import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

type RpcMessage = {
  id: string;
  event?: Record<string, unknown>;
  result?: Record<string, any>;
  error?: { message: string };
};

const children: ChildProcessWithoutNullStreams[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("sidecar protocol", () => {
  it("streams a run, resumes confirmation, writes a file, and persists conversation", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cowork-sidecar-"));
    const workspace = path.join(home, "workspace");
    await mkdir(workspace);
    temporaryDirectories.push(home);

    const child = spawn(process.execPath, ["--import", "tsx", "core/index.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, NODE_ENV: "test", LLM_PROVIDER: "mock" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);

    const messages: RpcMessage[] = [];
    const waiting = new Map<string, (message: RpcMessage) => void>();
    const events: Record<string, unknown>[] = [];
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as RpcMessage;
      messages.push(message);
      if (message.event) {
        events.push(message.event);
        if (message.event.kind === "confirmation_requested") {
          send("confirm", "respond_confirmation", {
            confirmationId: message.event.confirmationId,
            approved: true,
          });
        }
      } else {
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      }
    });

    function send(id: string, method: string, params: Record<string, unknown>) {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    }

    function request(id: string, method: string, params: Record<string, unknown>) {
      return new Promise<RpcMessage>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 15_000);
        waiting.set(id, (message) => {
          clearTimeout(timeout);
          resolve(message);
        });
        send(id, method, params);
      });
    }

    await request("grant", "grant_folder", { folder: workspace });
    const run = await request("run", "run", {
      message: "[MOCK_WRITE] create the output",
      workspace,
      runId: "e2e-run",
      history: [],
    });

    expect(run.error).toBeUndefined();
    expect(run.result?.status).toBe("done");
    expect(events.some((event) => event.kind === "plan")).toBe(true);
    expect(events.some((event) => event.kind === "confirmation_requested")).toBe(true);
    expect(events.some((event) => event.kind === "confirmation_resolved" && event.approved === true)).toBe(true);
    expect(events.some((event) => event.kind === "final")).toBe(true);
    expect(await readFile(path.join(workspace, "mock-output.txt"), "utf-8")).toBe("created by mock provider");

    const persisted = await request("latest", "latest_conversation", { workspace });
    expect(persisted.result?.conversation.messages).toEqual([
      { role: "user", content: "[MOCK_WRITE] create the output" },
      { role: "assistant", content: "Mock task completed." },
    ]);
    expect(messages.length).toBeGreaterThan(5);
  }, 20_000);
});
