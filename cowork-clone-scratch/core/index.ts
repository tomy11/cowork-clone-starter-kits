import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { Orchestrator, type OrchestratorEvent } from "./agent/orchestrator.js";
import { ToolRegistry } from "./agent/tools/registry.js";
import { builtInFileTools } from "./agent/tools/file-tools.js";
import { PermissionACL } from "./permissions/acl.js";
import { AuditLog } from "./permissions/audit.js";
import { ClaudeProvider } from "./llm/claude.js";
import { OpenAICompatProvider } from "./llm/openai-compatible.js";
import { SkillsLoader } from "./skills/loader.js";
import { WorkspaceStore } from "./storage/workspace-store.js";
import { withWorkspaceContext } from "./workspace-context.js";
import { McpManager } from "./mcp/manager.js";
import type { LLMProvider } from "./llm/provider.js";
import { MockProvider } from "./llm/mock.js";

const acl = new PermissionACL();
const audit = new AuditLog();
const store = new WorkspaceStore();
const tools = new ToolRegistry();
for (const tool of builtInFileTools) tools.register(tool);
for (const workspace of store.listWorkspaces()) acl.grantFolder(workspace);

const resourceRoot = process.env.COWORK_RESOURCE_DIR ?? process.cwd();
const skills = new SkillsLoader(path.join(resourceRoot, "skills"));
const mcp = new McpManager(path.join(resourceRoot, "mcp.json"), tools);
const provider = process.env.LLM_PROVIDER ?? "claude";
let llm: LLMProvider;
if (provider === "claude") {
  llm = new ClaudeProvider({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      model: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5",
    });
} else if (provider === "mock" && process.env.NODE_ENV === "test") {
  llm = new MockProvider();
} else {
  llm = new OpenAICompatProvider({
      apiKey: process.env.LLM_API_KEY!,
      baseURL: process.env.LLM_BASE_URL,
      model: process.env.LLM_MODEL ?? "gpt-4o",
    });
}
const orchestrator = new Orchestrator({ llm, acl, audit, tools });

type RpcRequest = { id: string; method: string; params: Record<string, any> };
type RpcResponse = { id: string; result?: unknown; error?: { message: string; code?: number } };
type AppEvent = OrchestratorEvent | {
  kind: "confirmation_requested" | "confirmation_resolved" | "run_started" | "run_cancelled" | "mcp_status";
  [key: string]: unknown;
};

const activeRuns = new Map<string, AbortController>();
const pendingConfirmations = new Map<string, {
  runId: string;
  resolve: (approved: boolean) => void;
}>();

process.stdin.setEncoding("utf-8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line) as RpcRequest;
      void dispatch(request);
    } catch (error) {
      writeResponse({
        id: "unknown",
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
});

async function dispatch(request: RpcRequest) {
  try {
    writeResponse(await handle(request));
  } catch (error) {
    writeResponse({
      id: request.id,
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

function writeResponse(response: RpcResponse | { id: string; event: AppEvent }) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function handle(request: RpcRequest): Promise<RpcResponse> {
  switch (request.method) {
    case "grant_folder": {
      const workspace = String(request.params.folder);
      acl.grantFolder(workspace, request.params.defaults);
      store.grantWorkspace(workspace);
      return { id: request.id, result: { ok: true } };
    }

    case "list_granted_folders":
      return { id: request.id, result: { folders: store.listWorkspaces() } };

    case "list_skills":
      return { id: request.id, result: { skills: await skills.list() } };

    case "load_skill":
      return { id: request.id, result: { skill: await skills.load(String(request.params.name)) } };

    case "list_tools":
      return { id: request.id, result: { tools: tools.names() } };

    case "mcp_status":
      return { id: request.id, result: { servers: await mcp.status() } };

    case "mcp_connect": {
      await mcp.connect(String(request.params.name), request.params.workspace);
      return { id: request.id, result: { servers: await mcp.status(), tools: tools.names() } };
    }

    case "mcp_disconnect": {
      await mcp.disconnect(String(request.params.name));
      return { id: request.id, result: { servers: await mcp.status(), tools: tools.names() } };
    }

    case "latest_conversation":
      return {
        id: request.id,
        result: { conversation: store.latestConversation(String(request.params.workspace)) },
      };

    case "get_conversation":
      return {
        id: request.id,
        result: { conversation: store.getConversation(String(request.params.conversationId)) },
      };

    case "respond_confirmation": {
      const confirmationId = String(request.params.confirmationId);
      const pending = pendingConfirmations.get(confirmationId);
      if (!pending) {
        return { id: request.id, error: { message: "Confirmation is no longer pending", code: 404 } };
      }
      pendingConfirmations.delete(confirmationId);
      pending.resolve(Boolean(request.params.approved));
      return { id: request.id, result: { ok: true } };
    }

    case "cancel_run": {
      const runId = String(request.params.runId);
      const controller = activeRuns.get(runId);
      if (!controller) return { id: request.id, result: { ok: false, status: "not_running" } };
      controller.abort();
      for (const [confirmationId, pending] of pendingConfirmations) {
        if (pending.runId === runId) {
          pendingConfirmations.delete(confirmationId);
          pending.resolve(false);
        }
      }
      return { id: request.id, result: { ok: true } };
    }

    case "run":
      return runTask(request);

    case "audit_recent":
      return { id: request.id, result: { entries: audit.recent(request.params.limit) } };

    case "ping":
      return { id: request.id, result: { pong: true, version: "0.2.0" } };

    default:
      return { id: request.id, error: { message: `Unknown method: ${request.method}`, code: 404 } };
  }
}

async function runTask(request: RpcRequest): Promise<RpcResponse> {
  const workspace = String(request.params.workspace ?? "");
  if (!workspace) return { id: request.id, error: { message: "Workspace is required", code: 400 } };

  const runId = String(request.params.runId ?? randomUUID());
  const controller = new AbortController();
  activeRuns.set(runId, controller);

  const requestedConversationId = request.params.conversationId
    ? String(request.params.conversationId)
    : undefined;
  const existing = requestedConversationId
    ? store.getConversation(requestedConversationId)
    : null;
  const history = existing?.messages ?? (Array.isArray(request.params.history) ? request.params.history : []);
  const rawMessage = String(request.params.message ?? "");
  const conversationId = store.ensureConversation(workspace, rawMessage, requestedConversationId);
  store.addMessage(conversationId, "user", rawMessage);
  store.startTask(runId, conversationId);

  const events: AppEvent[] = [];
  let status: "done" | "failed" | "cancelled" = "done";
  let finalContent = "";

  const emit = (event: AppEvent) => {
    const enriched = { ...event, runId, conversationId } as AppEvent;
    events.push(enriched);
    writeResponse({ id: request.id, event: enriched });
  };

  emit({ kind: "run_started", runId, conversationId });

  try {
    const mcpServers = await mcp.connectEnabled(workspace);
    emit({ kind: "mcp_status", servers: mcpServers });
    const availableSkills = await skills.list();
    const contextualMessage = withWorkspaceContext(rawMessage, workspace);
    for await (const event of orchestrator.run(contextualMessage, history, {
      signal: controller.signal,
      availableSkills,
      loadSkill: (name) => skills.load(name),
      onEvent: emit,
      requestConfirmation: (confirmation) => {
        const confirmationId = randomUUID();
        emit({
          kind: "confirmation_requested",
          confirmationId,
          agentId: confirmation.agentId,
          tool: confirmation.tool,
          args: confirmation.args,
          prompt: confirmation.prompt,
        });
        return new Promise<boolean>((resolve) => {
          pendingConfirmations.set(confirmationId, {
            runId,
            resolve: (approved) => {
              emit({ kind: "confirmation_resolved", confirmationId, approved });
              resolve(approved);
            },
          });
        });
      },
    })) {
      emit(event);
      if (event.kind === "final") finalContent = event.content;
      if (event.kind === "error") status = controller.signal.aborted ? "cancelled" : "failed";
    }

    if (controller.signal.aborted) {
      status = "cancelled";
      emit({ kind: "run_cancelled", runId });
    } else if (finalContent) {
      store.addMessage(conversationId, "assistant", finalContent);
    }
    store.finishTask(runId, status);
    return { id: request.id, result: { events, runId, conversationId, status } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status = controller.signal.aborted ? "cancelled" : "failed";
    store.finishTask(runId, status, message);
    emit({ kind: "error", message });
    return { id: request.id, result: { events, runId, conversationId, status } };
  } finally {
    activeRuns.delete(runId);
    for (const [confirmationId, pending] of pendingConfirmations) {
      if (pending.runId === runId) {
        pendingConfirmations.delete(confirmationId);
        pending.resolve(false);
      }
    }
  }
}
