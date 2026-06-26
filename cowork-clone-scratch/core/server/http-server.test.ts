import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../agent/tools/registry.js";
import { builtInFileTools } from "../agent/tools/file-tools.js";
import { MockProvider } from "../llm/mock.js";
import { ExtensionsLoader } from "../extensions/loader.js";
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

    const metadata = await getJson(`${handle.url}/workspaces/metadata`) as {
      workspaces: Array<{ path: string; name: string; activeConversationId: string | null; sessionCount: number }>;
    };
    expect(metadata.workspaces).toMatchObject([
      {
        path: workspace,
        name: path.basename(workspace),
        activeConversationId: created.conversation.id,
        sessionCount: 1,
      },
    ]);
  });

  it("streams session events over SSE while posting a message", async () => {
    const { handle, workspace } = await createTestServer();
    await postJson(`${handle.url}/workspaces`, { folder: workspace });
    const provider = await postJson(`${handle.url}/providers`, {
      type: "mock",
      name: "Mock",
      model: "mock",
    }) as { provider: { id: string } };
    const created = await postJson(`${handle.url}/sessions`, {
      workspace,
      title: "SSE",
      providerProfileId: provider.provider.id,
      model: "mock",
    }) as {
      conversation: { id: string };
    };

    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const controller = new AbortController();
    const eventStream = readSse(`${handle.url}/sessions/${created.conversation.id}/events`, events, controller.signal);
    await waitFor(() => events.some((event) => event.event === "ready"));

    const result = await postJson(`${handle.url}/sessions/${created.conversation.id}/messages`, {
      message: "finish without tools",
      runId: "http-run",
      providerProfileId: provider.provider.id,
      model: "mock",
    }) as { status: string; conversationId: string };
    expect(result.status).toBe("done");
    expect(result.conversationId).toBe(created.conversation.id);
    await waitFor(() => events.some((event) => event.event === "final"));
    controller.abort();
    await eventStream;

    expect(events.map((event) => event.event)).toContain("run_started");
    expect(events.map((event) => event.event)).toContain("final");

    const replay = await getJson(`${handle.url}/sessions/${created.conversation.id}/events/replay`) as {
      events: Array<{ kind: string; event: { kind: string } }>;
    };
    expect(replay.events.map((event) => event.kind)).toContain("run_started");
    expect(replay.events.map((event) => event.event.kind)).toContain("final");
    expect(replay.events.find((event) => event.kind === "run_started")?.event).toMatchObject({
      providerProfileId: provider.provider.id,
      providerType: "mock",
      model: "mock",
    });
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

  it("restores the active session for a workspace", async () => {
    const { handle, workspace } = await createTestServer();
    await postJson(`${handle.url}/workspaces`, { folder: workspace });
    const first = await postJson(`${handle.url}/sessions`, { workspace, title: "First" }) as {
      conversation: { id: string };
    };
    const second = await postJson(`${handle.url}/sessions`, { workspace, title: "Second" }) as {
      conversation: { id: string };
    };

    const initial = await getJson(`${handle.url}/active-session?workspace=${encodeURIComponent(workspace)}`) as {
      session: { id: string };
    };
    expect(initial.session.id).toBe(second.conversation.id);

    await patchJson(`${handle.url}/active-session`, { workspace, sessionId: first.conversation.id });
    const restored = await getJson(`${handle.url}/active-session?workspace=${encodeURIComponent(workspace)}`) as {
      session: { id: string };
    };
    expect(restored.session.id).toBe(first.conversation.id);

    await patchJson(`${handle.url}/sessions/${first.conversation.id}`, { archived: true });
    const fallback = await getJson(`${handle.url}/active-session?workspace=${encodeURIComponent(workspace)}`) as {
      session: { id: string };
    };
    expect(fallback.session.id).toBe(second.conversation.id);
  });

  it("manages provider profiles through HTTP", async () => {
    const { handle } = await createTestServer();
    const created = await postJson(`${handle.url}/providers`, {
      type: "claude",
      name: "Claude",
      model: "claude-sonnet-4-5",
      apiKey: "anthropic-key",
    }) as {
      provider: { id: string; type: string; hasApiKey: boolean; isDefault: boolean; apiKey?: string };
    };

    expect(created.provider).toMatchObject({
      type: "claude",
      hasApiKey: true,
      isDefault: true,
    });
    expect(created.provider.apiKey).toBeUndefined();

    const updated = await patchJson(`${handle.url}/providers/${created.provider.id}`, {
      name: "Claude Prod",
      model: "claude-opus-4-1",
    }) as { provider: { name: string; model: string } };
    expect(updated.provider).toMatchObject({ name: "Claude Prod", model: "claude-opus-4-1" });

    const providers = await getJson(`${handle.url}/providers`) as {
      providers: Array<{ id: string; name: string; hasApiKey: boolean }>;
    };
    expect(providers.providers).toMatchObject([
      { id: created.provider.id, name: "Claude Prod", hasApiKey: true },
    ]);

    const readiness = await postJson(`${handle.url}/providers/${created.provider.id}/test`, {}) as {
      ok: boolean;
      status: string;
    };
    expect(readiness).toMatchObject({ ok: true, status: "ready" });

    const mock = await postJson(`${handle.url}/providers`, {
      type: "mock",
      name: "Mock",
      model: "mock",
    }) as { provider: { id: string } };
    const models = await getJson(`${handle.url}/providers/${mock.provider.id}/models`) as {
      ok: boolean;
      models: string[];
    };
    expect(models).toMatchObject({ ok: true, models: ["mock"] });

    expect(await deleteJson(`${handle.url}/providers/${created.provider.id}`)).toEqual({ ok: true });
  });

  it("serves local extension manifests through HTTP", async () => {
    const { handle, extensionsRoot, resourceRoot } = await createTestServer();
    await writeSkill(path.join(resourceRoot, "skills", "webapp-testing"));
    await writeManifest(path.join(resourceRoot, "mcp.json"), {
      servers: { browser: { command: "browser", enabled: false } },
    });
    await writeManifest(path.join(extensionsRoot, "webapp-testing", "extension.json"), {
      id: "webapp-testing",
      name: "Webapp Testing",
      resources: {
        skills: ["webapp-testing"],
        mcpServers: ["browser"],
      },
      setup: {
        requiredEnv: ["PLAYWRIGHT_BROWSERS_PATH"],
        instructions: "Install browser dependencies before use.",
      },
    });

    const list = await getJson(`${handle.url}/extensions`) as {
      extensions: Array<{
        id: string;
        status: string;
        resources: { skills: string[]; mcpServers: string[] };
        setup: { missingEnv: string[] };
        checks: { ready: boolean; missingResources: unknown[] };
      }>;
    };
    expect(list.extensions).toHaveLength(1);
    expect(list.extensions[0]).toMatchObject({
      id: "webapp-testing",
      status: "ready",
      resources: { skills: ["webapp-testing"], mcpServers: ["browser"] },
      setup: { missingEnv: [] },
      checks: { ready: true, missingResources: [] },
    });

    const detail = await getJson(`${handle.url}/extensions/webapp-testing`) as {
      extension: { id: string; setup: { requiredEnv: string[]; missingEnv: string[] } };
    };
    expect(detail.extension).toMatchObject({
      id: "webapp-testing",
      setup: { requiredEnv: ["PLAYWRIGHT_BROWSERS_PATH"], missingEnv: [] },
    });
  });

  it("serves session artifacts through HTTP", async () => {
    const { handle, workspace, store } = await createTestServer();
    await postJson(`${handle.url}/workspaces`, { folder: workspace });
    const created = await postJson(`${handle.url}/sessions`, { workspace, title: "Artifacts" }) as {
      conversation: { id: string };
    };
    const event = store.addEvent(created.conversation.id, {
      kind: "tool_result",
      runId: "artifact-run",
      conversationId: created.conversation.id,
      name: "write_file",
    });
    const artifact = store.addArtifact({
      conversationId: created.conversation.id,
      runId: "artifact-run",
      sourceEventId: event.id,
      kind: "created",
      path: path.join(workspace, "report.md"),
      toolName: "write_file",
      metadata: { sizeBytes: 12, fileType: "md", mimeType: "text/markdown" },
    });

    const list = await getJson(`${handle.url}/sessions/${created.conversation.id}/artifacts`) as {
      artifacts: Array<{ id: string; path: string; sizeBytes: number }>;
    };
    expect(list.artifacts).toMatchObject([
      { id: artifact.id, path: path.join(workspace, "report.md"), sizeBytes: 12 },
    ]);

    const detail = await getJson(`${handle.url}/artifacts/${artifact.id}`) as {
      artifact: { id: string; conversationId: string };
    };
    expect(detail.artifact).toMatchObject({ id: artifact.id, conversationId: created.conversation.id });

    const attachedPath = path.join(workspace, "input.txt");
    await writeFile(attachedPath, "attached input");
    const attached = await postJson(`${handle.url}/sessions/${created.conversation.id}/artifacts`, {
      path: attachedPath,
    }) as {
      artifact: { id: string; kind: string; path: string; sizeBytes: number; toolName: string };
    };
    expect(attached.artifact).toMatchObject({
      kind: "attached",
      path: attachedPath,
      sizeBytes: 14,
      toolName: "attach_file",
    });

    const replay = await getJson(`${handle.url}/sessions/${created.conversation.id}/events/replay`) as {
      events: Array<{ kind: string; event: { kind: string; artifact?: { id: string } } }>;
    };
    expect(replay.events.map((event) => event.kind)).toContain("artifact_attached");
    expect(replay.events.find((event) => event.kind === "artifact_attached")?.event.artifact?.id)
      .toBe(attached.artifact.id);

    const preview = await getJson(`${handle.url}/artifacts/${attached.artifact.id}/preview`) as {
      artifact: { id: string };
      preview: { kind: string; content?: string; truncated: boolean };
    };
    expect(preview.artifact.id).toBe(attached.artifact.id);
    expect(preview.preview).toMatchObject({
      kind: "text",
      content: "attached input",
      truncated: false,
    });

    const batchWrite = await postJson(`${handle.url}/sessions/${created.conversation.id}/files/write`, {
      files: [
        { path: "batch/a.txt", content: "alpha" },
        { path: "batch/b.md", content: "# Bravo\n" },
      ],
    }) as {
      files: Array<{ path: string; created: boolean; artifact: { id: string; kind: string } }>;
    };
    expect(batchWrite.files).toHaveLength(2);
    expect(batchWrite.files[0]).toMatchObject({
      path: path.join(workspace, "batch/a.txt"),
      created: true,
      artifact: { kind: "created" },
    });

    const batchRead = await postJson(`${handle.url}/sessions/${created.conversation.id}/files/read`, {
      paths: ["batch/a.txt", "batch/b.md"],
    }) as {
      files: Array<{ path: string; content: string; truncated: boolean }>;
    };
    expect(batchRead.files).toMatchObject([
      { path: path.join(workspace, "batch/a.txt"), content: "alpha", truncated: false },
      { path: path.join(workspace, "batch/b.md"), content: "# Bravo\n", truncated: false },
    ]);

    const finalReplay = await getJson(`${handle.url}/sessions/${created.conversation.id}/events/replay`) as {
      events: Array<{ kind: string; event: { kind: string; artifact?: { id: string } } }>;
    };
    expect(finalReplay.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      "file_attached",
      "artifact_created",
      "file_created",
      "file_read",
    ]));
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
  const extensionsRoot = path.join(directory, "extensions");
  const extensions = new ExtensionsLoader(extensionsRoot, {
    env: { PLAYWRIGHT_BROWSERS_PATH: "/tmp/browsers" },
    resourceRoot: directory,
  });
  const mcp = new McpManager(path.join(directory, "mcp.json"), tools);
  const runtime = new AppRuntime({
    llm: new MockProvider(),
    acl,
    audit,
    store,
    tools,
    skills,
    extensions,
    mcp,
  });
  const handle = await createLocalServer(runtime);
  handles.push(handle);
  return { handle, workspace, extensionsRoot, resourceRoot: directory, store };
}

async function writeManifest(filePath: string, manifest: Record<string, unknown>) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

async function writeSkill(skillPath: string) {
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), "---\nname: test\n---\nUse this skill.\n", "utf-8");
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
