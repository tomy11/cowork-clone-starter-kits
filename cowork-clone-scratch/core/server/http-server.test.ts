import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../agent/tools/registry.js";
import { builtInFileTools } from "../agent/tools/file-tools.js";
import { MockProvider } from "../llm/mock.js";
import { McpManager } from "../mcp/manager.js";
import { AuditLog } from "../permissions/audit.js";
import { PermissionACL } from "../permissions/acl.js";
import { SkillsLoader } from "../skills/loader.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { AppRuntime } from "../runtime.js";
import { createLocalServer, type LocalServerHandle } from "./http-server.js";

const handles: LocalServerHandle[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local HTTP server", () => {
  it("serves health, workspaces, and sessions", async () => {
    const { handle, workspace } = await createTestServer();

    expect(await getJson(`${handle.url}/health`)).toMatchObject({ ok: true });

    const granted = await postJson(`${handle.url}/workspaces`, { folder: workspace });
    expect(granted).toEqual({ ok: true });

    expect(await getJson(`${handle.url}/workspaces`)).toEqual({ workspaces: [workspace] });

    const created = await postJson(`${handle.url}/sessions`, {
      workspace,
      title: "Server boundary",
    }) as { conversation: { id: string; title: string } };
    expect(created.conversation.title).toBe("Server boundary");

    const sessions = await getJson(`${handle.url}/sessions?workspace=${encodeURIComponent(workspace)}`) as {
      sessions: Array<{ id: string }>;
    };
    expect(sessions.sessions.map((session) => session.id)).toEqual([created.conversation.id]);
  });

  it("streams session events over SSE while posting a message", async () => {
    const { handle, workspace } = await createTestServer();
    await postJson(`${handle.url}/workspaces`, { folder: workspace });
    const created = await postJson(`${handle.url}/sessions`, { workspace, title: "SSE" }) as {
      conversation: { id: string };
    };

    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const controller = new AbortController();
    const eventStream = readSse(`${handle.url}/sessions/${created.conversation.id}/events`, events, controller.signal);
    await waitFor(() => events.some((event) => event.event === "ready"));

    const result = await postJson(`${handle.url}/sessions/${created.conversation.id}/messages`, {
      message: "finish without tools",
      runId: "http-run",
    }) as { status: string; conversationId: string };
    expect(result.status).toBe("done");
    expect(result.conversationId).toBe(created.conversation.id);
    await waitFor(() => events.some((event) => event.event === "final"));
    controller.abort();
    await eventStream;

    expect(events.map((event) => event.event)).toContain("run_started");
    expect(events.map((event) => event.event)).toContain("final");
  });

  it("exposes run cancellation through HTTP", async () => {
    const { handle } = await createTestServer();

    const result = await postJson(`${handle.url}/runs/not-running/cancel`, {}) as {
      ok: boolean;
      status: string;
    };

    expect(result).toEqual({ ok: false, status: "not_running" });
  });

  it("renames, archives, and deletes sessions", async () => {
    const { handle, workspace } = await createTestServer();
    await postJson(`${handle.url}/workspaces`, { folder: workspace });
    const created = await postJson(`${handle.url}/sessions`, { workspace, title: "Original" }) as {
      conversation: { id: string; title: string };
    };

    const renamed = await patchJson(`${handle.url}/sessions/${created.conversation.id}`, { title: "Renamed" }) as {
      conversation: { title: string };
    };
    expect(renamed.conversation.title).toBe("Renamed");

    const archived = await patchJson(`${handle.url}/sessions/${created.conversation.id}`, { archived: true }) as {
      conversation: { archived: boolean };
    };
    expect(archived.conversation.archived).toBe(true);

    const visible = await getJson(`${handle.url}/sessions?workspace=${encodeURIComponent(workspace)}`) as {
      sessions: Array<{ id: string }>;
    };
    expect(visible.sessions).toEqual([]);

    const all = await getJson(`${handle.url}/sessions?workspace=${encodeURIComponent(workspace)}&includeArchived=true`) as {
      sessions: Array<{ id: string }>;
    };
    expect(all.sessions.map((session) => session.id)).toEqual([created.conversation.id]);

    expect(await deleteJson(`${handle.url}/sessions/${created.conversation.id}`)).toEqual({ ok: true });
    const afterDelete = await getJson(`${handle.url}/sessions?workspace=${encodeURIComponent(workspace)}&includeArchived=true`) as {
      sessions: Array<{ id: string }>;
    };
    expect(afterDelete.sessions).toEqual([]);
  });
});

async function createTestServer() {
  const directory = await mkdtemp(path.join(tmpdir(), "cowork-http-"));
  temporaryDirectories.push(directory);
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);

  const acl = new PermissionACL();
  const audit = new AuditLog(":memory:");
  const store = new WorkspaceStore(":memory:");
  const tools = new ToolRegistry();
  for (const tool of builtInFileTools) tools.register(tool);
  const skills = new SkillsLoader(path.join(directory, "skills"));
  const mcp = new McpManager(path.join(directory, "mcp.json"), tools);
  const runtime = new AppRuntime({
    llm: new MockProvider(),
    acl,
    audit,
    store,
    tools,
    skills,
    mcp,
  });
  const handle = await createLocalServer(runtime);
  handles.push(handle);
  return { handle, workspace };
}

async function getJson(url: string) {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.json();
}

async function postJson(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json();
}

async function patchJson(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json();
}

async function deleteJson(url: string) {
  const response = await fetch(url, { method: "DELETE" });
  expect(response.ok).toBe(true);
  return response.json();
}

async function readSse(
  url: string,
  events: Array<{ event: string; data: Record<string, unknown> }>,
  signal: AbortSignal,
) {
  try {
    const response = await fetch(url, { signal });
    expect(response.ok).toBe(true);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing response body");
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSse(raw);
        if (event) events.push(event);
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

function parseSse(raw: string) {
  const event = raw.match(/^event: (.+)$/m)?.[1];
  const data = raw.match(/^data: (.+)$/m)?.[1];
  if (!event || !data) return null;
  return { event, data: JSON.parse(data) as Record<string, unknown> };
}

async function waitFor(predicate: () => boolean) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 5_000) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
