import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { AddressInfo } from "node:net";
import type { AppRuntime, AppEvent, RpcResponse } from "../runtime.js";

export type LocalServerOptions = {
  host?: string;
  port?: number;
};

export type LocalServerHandle = {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
};

type JsonObject = Record<string, unknown>;

export async function createLocalServer(
  runtime: AppRuntime,
  options: LocalServerOptions = {},
): Promise<LocalServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((request, response) => {
    void route(runtime, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function route(runtime: AppRuntime, request: IncomingMessage, response: ServerResponse) {
  setCorsHeaders(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true, version: "0.3.0" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/workspaces") {
      writeJson(response, 200, { workspaces: runtime.listWorkspaces() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/workspaces/metadata") {
      writeJson(response, 200, { workspaces: runtime.listWorkspaceMetadata() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/active-session") {
      const workspace = url.searchParams.get("workspace");
      if (!workspace) return writeJson(response, 400, { error: "workspace is required" });
      writeJson(response, 200, { session: runtime.getActiveConversation(workspace) });
      return;
    }

    if (request.method === "PATCH" && url.pathname === "/active-session") {
      const body = await readJson(request);
      const workspace = stringField(body, "workspace");
      if (!workspace) return writeJson(response, 400, { error: "workspace is required" });
      const conversationId = stringField(body, "sessionId") ?? stringField(body, "conversationId") ?? null;
      const ok = runtime.setActiveConversation(workspace, conversationId);
      if (!ok) return writeJson(response, 404, { error: "session not found" });
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/providers") {
      writeJson(response, 200, { providers: runtime.listProviderProfiles() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/extensions") {
      writeJson(response, 200, { extensions: await runtime.listExtensions() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/skills") {
      const result = await runtime.handle({ id: requestId(), method: "list_skills", params: {} });
      writeRpc(response, result, 200);
      return;
    }

    if (request.method === "GET" && url.pathname === "/tools") {
      const result = await runtime.handle({ id: requestId(), method: "list_tools", params: {} });
      writeRpc(response, result, 200);
      return;
    }

    if (request.method === "GET" && url.pathname === "/mcp") {
      const result = await runtime.handle({ id: requestId(), method: "mcp_status", params: {} });
      writeRpc(response, result, 200);
      return;
    }

    const mcpConnectMatch = url.pathname.match(/^\/mcp\/([^/]+)\/connect$/);
    if (request.method === "POST" && mcpConnectMatch) {
      const body = await readJson(request);
      const result = await runtime.handle({
        id: requestId(),
        method: "mcp_connect",
        params: {
          name: decodeURIComponent(mcpConnectMatch[1]),
          workspace: stringField(body, "workspace"),
        },
      });
      writeRpc(response, result, 200);
      return;
    }

    const mcpDisconnectMatch = url.pathname.match(/^\/mcp\/([^/]+)\/disconnect$/);
    if (request.method === "POST" && mcpDisconnectMatch) {
      const result = await runtime.handle({
        id: requestId(),
        method: "mcp_disconnect",
        params: { name: decodeURIComponent(mcpDisconnectMatch[1]) },
      });
      writeRpc(response, result, 200);
      return;
    }

    const extensionMatch = url.pathname.match(/^\/extensions\/([^/]+)$/);
    if (request.method === "GET" && extensionMatch) {
      const extension = await runtime.getExtension(decodeURIComponent(extensionMatch[1]));
      if (!extension) return writeJson(response, 404, { error: "extension not found" });
      writeJson(response, 200, { extension });
      return;
    }

    if (request.method === "PATCH" && extensionMatch) {
      const extensionId = decodeURIComponent(extensionMatch[1]);
      const body = await readJson(request);
      const enabled = Boolean((body as Record<string, unknown>).enabled);
      const result = await runtime.handle({
        id: requestId(),
        method: enabled ? "enable_extension" : "disable_extension",
        params: { extensionId },
      });
      writeRpc(response, result, 200);
      return;
    }

    if (request.method === "POST" && url.pathname === "/providers") {
      const body = await readJson(request);
      const result = await runtime.handle({
        id: requestId(),
        method: "create_provider_profile",
        params: providerProfileInput(body),
      });
      writeRpc(response, result, 201);
      return;
    }

    const providerMatch = url.pathname.match(/^\/providers\/([^/]+)$/);
    if (request.method === "PATCH" && providerMatch) {
      const body = await readJson(request);
      const result = await runtime.handle({
        id: requestId(),
        method: "update_provider_profile",
        params: {
          providerId: decodeURIComponent(providerMatch[1]),
          profile: providerProfileInput(body, true),
        },
      });
      writeRpc(response, result, 200);
      return;
    }

    if (request.method === "DELETE" && providerMatch) {
      const result = await runtime.handle({
        id: requestId(),
        method: "delete_provider_profile",
        params: { providerId: decodeURIComponent(providerMatch[1]) },
      });
      writeRpc(response, result, 200);
      return;
    }

    const providerDefaultMatch = url.pathname.match(/^\/providers\/([^/]+)\/default$/);
    if (request.method === "POST" && providerDefaultMatch) {
      const result = await runtime.handle({
        id: requestId(),
        method: "set_default_provider_profile",
        params: { providerId: decodeURIComponent(providerDefaultMatch[1]) },
      });
      writeRpc(response, result, 200);
      return;
    }

    const providerTestMatch = url.pathname.match(/^\/providers\/([^/]+)\/test$/);
    if (request.method === "POST" && providerTestMatch) {
      const result = await runtime.handle({
        id: requestId(),
        method: "test_provider_profile",
        params: { providerId: decodeURIComponent(providerTestMatch[1]) },
      });
      writeRpc(response, result, 200);
      return;
    }

    const providerModelsMatch = url.pathname.match(/^\/providers\/([^/]+)\/models$/);
    if (request.method === "GET" && providerModelsMatch) {
      const result = await runtime.handle({
        id: requestId(),
        method: "list_provider_models",
        params: { providerId: decodeURIComponent(providerModelsMatch[1]) },
      });
      writeRpc(response, result, 200);
      return;
    }

    if (request.method === "POST" && url.pathname === "/workspaces") {
      const body = await readJson(request);
      const folder = stringField(body, "folder") ?? stringField(body, "path");
      if (!folder) return writeJson(response, 400, { error: "folder is required" });
      const result = await runtime.handle({ id: requestId(), method: "grant_folder", params: { folder } });
      writeRpc(response, result, 201);
      return;
    }

    if (request.method === "GET" && url.pathname === "/sessions") {
      writeJson(response, 200, {
        sessions: runtime.listConversations(url.searchParams.get("workspace") ?? undefined, {
          includeArchived: url.searchParams.get("includeArchived") === "true",
        }),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/sessions") {
      const body = await readJson(request);
      const workspace = stringField(body, "workspace");
      if (!workspace) return writeJson(response, 400, { error: "workspace is required" });
      const result = await runtime.handle({
        id: requestId(),
        method: "create_conversation",
        params: {
          workspace,
          title: stringField(body, "title") ?? "New task",
          conversationId: stringField(body, "id"),
          providerProfileId: stringField(body, "providerProfileId"),
          model: stringField(body, "model"),
        },
      });
      writeRpc(response, result, 201);
      return;
    }

    const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (request.method === "GET" && sessionMatch) {
      const conversation = runtime.getConversation(decodeURIComponent(sessionMatch[1]));
      if (!conversation) return writeJson(response, 404, { error: "session not found" });
      writeJson(response, 200, { session: conversation });
      return;
    }

    if (request.method === "PATCH" && sessionMatch) {
      const conversationId = decodeURIComponent(sessionMatch[1]);
      const body = await readJson(request);
      let result: RpcResponse | null = null;
      if (typeof body.title === "string") {
        result = await runtime.handle({
          id: requestId(),
          method: "rename_conversation",
          params: { conversationId, title: body.title },
        });
      }
      if (typeof body.archived === "boolean") {
        result = await runtime.handle({
          id: requestId(),
          method: "archive_conversation",
          params: { conversationId, archived: body.archived },
        });
      }
      if (!result) return writeJson(response, 400, { error: "No session fields to update" });
      writeRpc(response, result, 200);
      return;
    }

    if (request.method === "DELETE" && sessionMatch) {
      const result = await runtime.handle({
        id: requestId(),
        method: "delete_conversation",
        params: { conversationId: decodeURIComponent(sessionMatch[1]) },
      });
      writeRpc(response, result, 200);
      return;
    }

    const replayMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events\/replay$/);
    if (request.method === "GET" && replayMatch) {
      const conversationId = decodeURIComponent(replayMatch[1]);
      if (!runtime.getConversation(conversationId)) return writeJson(response, 404, { error: "session not found" });
      const afterId = Number(url.searchParams.get("after") ?? 0);
      writeJson(response, 200, {
        events: runtime.listConversationEvents(conversationId, { afterId }),
      });
      return;
    }

    const artifactsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/artifacts$/);
    if (request.method === "POST" && artifactsMatch) {
      const conversationId = decodeURIComponent(artifactsMatch[1]);
      if (!runtime.getConversation(conversationId)) return writeJson(response, 404, { error: "session not found" });
      const body = await readJson(request);
      const filePath = stringField(body, "path") ?? stringField(body, "filePath");
      if (!filePath) return writeJson(response, 400, { error: "path is required" });
      let artifact;
      try {
        artifact = runtime.attachArtifact(conversationId, filePath);
      } catch (error) {
        return writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      if (!artifact) return writeJson(response, 404, { error: "session not found" });
      writeJson(response, 201, { artifact });
      return;
    }

    if (request.method === "GET" && artifactsMatch) {
      const conversationId = decodeURIComponent(artifactsMatch[1]);
      if (!runtime.getConversation(conversationId)) return writeJson(response, 404, { error: "session not found" });
      writeJson(response, 200, { artifacts: runtime.listArtifacts(conversationId) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/artifacts") {
      const workspace = url.searchParams.get("workspace");
      if (!workspace) return writeJson(response, 400, { error: "workspace is required" });
      writeJson(response, 200, { artifacts: runtime.listWorkspaceArtifacts(workspace) });
      return;
    }

    const fileReadMatch = url.pathname.match(/^\/sessions\/([^/]+)\/files\/read$/);
    if (request.method === "POST" && fileReadMatch) {
      const conversationId = decodeURIComponent(fileReadMatch[1]);
      if (!runtime.getConversation(conversationId)) return writeJson(response, 404, { error: "session not found" });
      const body = await readJson(request);
      let result;
      try {
        result = await runtime.batchReadFiles(conversationId, batchReadInput(body));
      } catch (error) {
        return writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      if (!result) return writeJson(response, 404, { error: "session not found" });
      writeJson(response, 200, result);
      return;
    }

    const fileWriteMatch = url.pathname.match(/^\/sessions\/([^/]+)\/files\/write$/);
    if (request.method === "POST" && fileWriteMatch) {
      const conversationId = decodeURIComponent(fileWriteMatch[1]);
      if (!runtime.getConversation(conversationId)) return writeJson(response, 404, { error: "session not found" });
      const body = await readJson(request);
      let result;
      try {
        result = await runtime.batchWriteFiles(conversationId, batchWriteInput(body));
      } catch (error) {
        return writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      if (!result) return writeJson(response, 404, { error: "session not found" });
      writeJson(response, 200, result);
      return;
    }

    const eventsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
    if (request.method === "GET" && eventsMatch) {
      const conversationId = decodeURIComponent(eventsMatch[1]);
      if (!runtime.getConversation(conversationId)) return writeJson(response, 404, { error: "session not found" });
      openSse(runtime, conversationId, response);
      return;
    }

    const messageMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
    if (request.method === "POST" && messageMatch) {
      const conversationId = decodeURIComponent(messageMatch[1]);
      const conversation = runtime.getConversation(conversationId);
      if (!conversation) return writeJson(response, 404, { error: "session not found" });
      const body = await readJson(request);
      const message = stringField(body, "message");
      if (!message) return writeJson(response, 400, { error: "message is required" });
      const result = await runtime.handle({
        id: requestId(),
        method: "run",
        params: {
          conversationId,
          workspace: stringField(body, "workspace") ?? conversation.workspace,
          message,
          runId: stringField(body, "runId"),
          providerProfileId: stringField(body, "providerProfileId"),
          model: stringField(body, "model"),
        },
      });
      writeRpc(response, result, 202);
      return;
    }

    if (request.method === "GET" && url.pathname === "/approvals") {
      writeJson(response, 200, { approvals: runtime.listApprovals() });
      return;
    }

    const approvalMatch = url.pathname.match(/^\/approvals\/([^/]+)$/);
    if (request.method === "POST" && approvalMatch) {
      const body = await readJson(request);
      const result = await runtime.handle({
        id: requestId(),
        method: "respond_confirmation",
        params: {
          confirmationId: decodeURIComponent(approvalMatch[1]),
          approved: Boolean(body.approved),
        },
      });
      writeRpc(response, result, 200);
      return;
    }

    const cancelRunMatch = url.pathname.match(/^\/runs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelRunMatch) {
      const result = await runtime.handle({
        id: requestId(),
        method: "cancel_run",
        params: { runId: decodeURIComponent(cancelRunMatch[1]) },
      });
      writeRpc(response, result, 200);
      return;
    }

    const artifactPreviewMatch = url.pathname.match(/^\/artifacts\/([^/]+)\/preview$/);
    if (request.method === "GET" && artifactPreviewMatch) {
      const limit = Number(url.searchParams.get("limitBytes") ?? 0);
      let preview;
      try {
        preview = runtime.previewArtifact(decodeURIComponent(artifactPreviewMatch[1]), {
          limitBytes: limit || undefined,
        });
      } catch (error) {
        return writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      if (!preview) return writeJson(response, 404, { error: "artifact not found" });
      writeJson(response, 200, preview);
      return;
    }

    const artifactMatch = url.pathname.match(/^\/artifacts\/([^/]+)$/);
    if (request.method === "GET" && artifactMatch) {
      const artifact = runtime.getArtifact(decodeURIComponent(artifactMatch[1]));
      if (!artifact) return writeJson(response, 404, { error: "artifact not found" });
      writeJson(response, 200, { artifact });
      return;
    }

    writeJson(response, 404, { error: "not found" });
  } catch (error) {
    writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function openSse(runtime: AppRuntime, conversationId: string, response: ServerResponse) {
  response.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no",
  });
  writeSse(response, "ready", { conversationId });
  const unsubscribe = runtime.subscribeSession(conversationId, (event) => writeSse(response, event.kind, event));
  response.on("close", unsubscribe);
}

function writeRpc(response: ServerResponse, rpc: RpcResponse, successStatus: number) {
  if (rpc.error) {
    writeJson(response, rpc.error.code ?? 500, { error: rpc.error.message });
    return;
  }
  writeJson(response, successStatus, rpc.result ?? {});
}

function writeSse(response: ServerResponse, event: string, data: AppEvent | JsonObject) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected JSON object body");
  return parsed as JsonObject;
}

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function setCorsHeaders(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
}

function stringField(body: JsonObject, key: string) {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function providerProfileInput(body: JsonObject, partial = false) {
  const profile: JsonObject = {};
  for (const key of ["type", "name", "model", "baseUrl", "apiKey"] as const) {
    if (partial && !(key in body)) continue;
    const value = body[key];
    if (typeof value === "string") profile[key] = value;
    else if (value === null && (key === "baseUrl" || key === "apiKey")) profile[key] = null;
  }
  for (const key of ["enabled", "isDefault"] as const) {
    if (partial && !(key in body)) continue;
    const value = body[key];
    if (typeof value === "boolean") profile[key] = value;
  }
  return profile;
}

function batchReadInput(body: JsonObject) {
  const files = Array.isArray(body.files)
    ? body.files
    : Array.isArray(body.paths)
      ? body.paths.map((entry) => ({ path: entry }))
      : [];
  if (files.length === 0) throw new Error("files or paths are required");
  return files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Each file must be an object");
    const file = entry as JsonObject;
    const filePath = stringField(file, "path") ?? stringField(file, "filePath");
    if (!filePath) throw new Error("Each file requires a path");
    const limitBytes = typeof file.limitBytes === "number" ? file.limitBytes : undefined;
    return { path: filePath, limitBytes };
  });
}

function batchWriteInput(body: JsonObject) {
  if (!Array.isArray(body.files) || body.files.length === 0) throw new Error("files are required");
  return body.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Each file must be an object");
    const file = entry as JsonObject;
    const filePath = stringField(file, "path") ?? stringField(file, "filePath");
    if (!filePath) throw new Error("Each file requires a path");
    if (typeof file.content !== "string") throw new Error("Each file requires string content");
    return { path: filePath, content: file.content };
  });
}

function requestId() {
  return `http-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
