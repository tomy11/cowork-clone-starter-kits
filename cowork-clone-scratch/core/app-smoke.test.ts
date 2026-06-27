import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

type SidecarMessage = {
  id: string;
  event?: Record<string, unknown>;
  error?: { message: string };
};

const children: ChildProcessWithoutNullStreams[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("app smoke", () => {
  it("starts the sidecar HTTP server and sends a mock session", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cowork-app-smoke-"));
    const workspace = path.join(home, "workspace");
    await mkdir(workspace);
    temporaryDirectories.push(home);

    const port = await reservePort();
    const child = spawn(process.execPath, ["--import", "tsx", "core/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COWORK_HTTP_PORT: String(port),
        HOME: home,
        NODE_ENV: "test",
        LLM_PROVIDER: "mock",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);

    const serverUrl = await waitForHttpServer(child);
    expect(await getJson(`${serverUrl}/health`)).toMatchObject({ ok: true });

    await postJson(`${serverUrl}/workspaces`, { folder: workspace });
    const provider = await postJson(`${serverUrl}/providers`, {
      type: "mock",
      name: "Smoke mock",
      model: "mock",
      isDefault: true,
    }) as { provider: { id: string } };
    const session = await postJson(`${serverUrl}/sessions`, {
      workspace,
      title: "Smoke session",
      providerProfileId: provider.provider.id,
      model: "mock",
    }) as { conversation: { id: string } };

    const run = await postJson(`${serverUrl}/sessions/${session.conversation.id}/messages`, {
      message: "finish without tools",
      providerProfileId: provider.provider.id,
      model: "mock",
      runId: "smoke-run",
    }) as { status: string; conversationId: string };

    expect(run).toMatchObject({ status: "done", conversationId: session.conversation.id });
    const replay = await getJson(`${serverUrl}/sessions/${session.conversation.id}/events/replay`) as {
      events: Array<{ kind: string; event: { kind: string } }>;
    };
    expect(replay.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      "run_started",
      "final",
    ]));
  }, 20_000);
});

async function waitForHttpServer(child: ChildProcessWithoutNullStreams) {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for sidecar HTTP server")), 10_000);
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as SidecarMessage;
      if (message.error) {
        clearTimeout(timeout);
        reject(new Error(message.error.message));
        return;
      }
      if (message.id === "http_server" && message.event?.url && typeof message.event.url === "string") {
        clearTimeout(timeout);
        resolve(message.event.url);
      }
    });
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("Could not reserve local port");
  return port;
}

async function getJson(url: string) {
  const response = await fetch(url);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function postJson(url: string, body: object) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`POST ${url} failed: ${response.status} ${JSON.stringify(parsed)}`);
  return parsed;
}
