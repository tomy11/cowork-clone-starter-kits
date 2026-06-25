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

function requestId() {
  return `http-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
