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
import { WorkspaceStore, type StoredConversation } from "./storage/workspace-store.js";
import { withWorkspaceContext } from "./workspace-context.js";
import { McpManager } from "./mcp/manager.js";
import type { LLMProvider } from "./llm/provider.js";
import { MockProvider } from "./llm/mock.js";

export type RpcRequest = { id: string; method: string; params: Record<string, any> };
export type RpcResponse = { id: string; result?: unknown; error?: { message: string; code?: number } };
export type AppEvent = OrchestratorEvent | {
  kind: "confirmation_requested" | "confirmation_resolved" | "run_started" | "run_cancelled" | "mcp_status";
  [key: string]: unknown;
};

export type PendingApproval = {
  id: string;
  runId: string;
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  prompt: string;
  createdAt: string;
};

export type AppRuntimeConfig = {
  llm: LLMProvider;
  acl: PermissionACL;
  audit: AuditLog;
  store: WorkspaceStore;
  tools: ToolRegistry;
  skills: SkillsLoader;
  mcp: McpManager;
  orchestrator?: Orchestrator;
};

type PendingConfirmation = PendingApproval & {
  resolve: (approved: boolean) => void;
};

type SessionListener = (event: AppEvent) => void;

export class AppRuntime {
  private orchestrator: Orchestrator;
  private activeRuns = new Map<string, AbortController>();
  private pendingConfirmations = new Map<string, PendingConfirmation>();
  private sessionListeners = new Map<string, Set<SessionListener>>();

  constructor(private cfg: AppRuntimeConfig) {
    this.orchestrator = cfg.orchestrator ?? new Orchestrator({
      llm: cfg.llm,
      acl: cfg.acl,
      audit: cfg.audit,
      tools: cfg.tools,
    });
  }

  async handle(request: RpcRequest, onEvent?: (event: AppEvent) => void): Promise<RpcResponse> {
    try {
      switch (request.method) {
        case "grant_folder": {
          const workspace = String(request.params.folder);
          this.cfg.acl.grantFolder(workspace, request.params.defaults);
          this.cfg.store.grantWorkspace(workspace);
          return { id: request.id, result: { ok: true } };
        }

        case "list_granted_folders":
          return { id: request.id, result: { folders: this.cfg.store.listWorkspaces() } };

        case "list_conversations":
          return {
            id: request.id,
            result: {
              conversations: this.cfg.store.listConversations(request.params.workspace, {
                includeArchived: Boolean(request.params.includeArchived),
              }),
            },
          };

        case "create_conversation": {
          const workspace = String(request.params.workspace ?? "");
          if (!workspace) return { id: request.id, error: { message: "Workspace is required", code: 400 } };
          const conversationId = this.cfg.store.ensureConversation(
            workspace,
            String(request.params.title ?? "New task"),
            request.params.conversationId ? String(request.params.conversationId) : undefined,
          );
          return { id: request.id, result: { conversation: this.cfg.store.getConversation(conversationId) } };
        }

        case "list_skills":
          return { id: request.id, result: { skills: await this.cfg.skills.list() } };

        case "load_skill":
          return { id: request.id, result: { skill: await this.cfg.skills.load(String(request.params.name)) } };

        case "list_tools":
          return { id: request.id, result: { tools: this.cfg.tools.names() } };

        case "mcp_status":
          return { id: request.id, result: { servers: await this.cfg.mcp.status() } };

        case "mcp_connect": {
          await this.cfg.mcp.connect(String(request.params.name), request.params.workspace);
          return { id: request.id, result: { servers: await this.cfg.mcp.status(), tools: this.cfg.tools.names() } };
        }

        case "mcp_disconnect": {
          await this.cfg.mcp.disconnect(String(request.params.name));
          return { id: request.id, result: { servers: await this.cfg.mcp.status(), tools: this.cfg.tools.names() } };
        }

        case "latest_conversation":
          return {
            id: request.id,
            result: { conversation: this.cfg.store.latestConversation(String(request.params.workspace)) },
          };

        case "get_conversation":
          return {
            id: request.id,
            result: { conversation: this.cfg.store.getConversation(String(request.params.conversationId)) },
          };

        case "rename_conversation": {
          const conversation = this.cfg.store.renameConversation(
            String(request.params.conversationId),
            String(request.params.title ?? ""),
          );
          if (!conversation) return { id: request.id, error: { message: "Conversation not found", code: 404 } };
          return { id: request.id, result: { conversation } };
        }

        case "archive_conversation": {
          const conversation = this.cfg.store.archiveConversation(
            String(request.params.conversationId),
            Boolean(request.params.archived ?? true),
          );
          if (!conversation) return { id: request.id, error: { message: "Conversation not found", code: 404 } };
          return { id: request.id, result: { conversation } };
        }

        case "delete_conversation": {
          const deleted = this.cfg.store.deleteConversation(String(request.params.conversationId));
          if (!deleted) return { id: request.id, error: { message: "Conversation not found", code: 404 } };
          return { id: request.id, result: { ok: true } };
        }

        case "list_approvals":
          return { id: request.id, result: { approvals: this.listApprovals() } };

        case "respond_confirmation":
          return this.respondConfirmation(request);

        case "cancel_run":
          return this.cancelRun(request);

        case "run":
          return this.runTask(request, onEvent);

        case "audit_recent":
          return { id: request.id, result: { entries: this.cfg.audit.recent(request.params.limit) } };

        case "ping":
          return { id: request.id, result: { pong: true, version: "0.3.0" } };

        default:
          return { id: request.id, error: { message: `Unknown method: ${request.method}`, code: 404 } };
      }
    } catch (error) {
      return {
        id: request.id,
        error: { message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  listWorkspaces(): string[] {
    return this.cfg.store.listWorkspaces();
  }

  listConversations(workspace?: unknown, options: { includeArchived?: boolean } = {}): StoredConversation[] {
    return this.cfg.store.listConversations(workspace, options);
  }

  getConversation(id: string): StoredConversation | null {
    return this.cfg.store.getConversation(id);
  }

  listApprovals(): PendingApproval[] {
    return [...this.pendingConfirmations.values()].map(({ resolve: _resolve, ...approval }) => approval);
  }

  subscribeSession(conversationId: string, listener: SessionListener) {
    const listeners = this.sessionListeners.get(conversationId) ?? new Set<SessionListener>();
    listeners.add(listener);
    this.sessionListeners.set(conversationId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.sessionListeners.delete(conversationId);
    };
  }

  async close() {
    await this.cfg.mcp.close();
    this.cfg.audit.close();
    this.cfg.store.close();
  }

  private respondConfirmation(request: RpcRequest): RpcResponse {
    const confirmationId = String(request.params.confirmationId);
    const pending = this.pendingConfirmations.get(confirmationId);
    if (!pending) {
      return { id: request.id, error: { message: "Confirmation is no longer pending", code: 404 } };
    }
    this.pendingConfirmations.delete(confirmationId);
    pending.resolve(Boolean(request.params.approved));
    return { id: request.id, result: { ok: true } };
  }

  private cancelRun(request: RpcRequest): RpcResponse {
    const runId = String(request.params.runId);
    const controller = this.activeRuns.get(runId);
    if (!controller) return { id: request.id, result: { ok: false, status: "not_running" } };
    controller.abort();
    for (const [confirmationId, pending] of this.pendingConfirmations) {
      if (pending.runId === runId) {
        this.pendingConfirmations.delete(confirmationId);
        pending.resolve(false);
      }
    }
    return { id: request.id, result: { ok: true } };
  }

  private async runTask(request: RpcRequest, onEvent?: (event: AppEvent) => void): Promise<RpcResponse> {
    const workspace = String(request.params.workspace ?? "");
    if (!workspace) return { id: request.id, error: { message: "Workspace is required", code: 400 } };

    const runId = String(request.params.runId ?? randomUUID());
    const controller = new AbortController();
    this.activeRuns.set(runId, controller);

    const requestedConversationId = request.params.conversationId
      ? String(request.params.conversationId)
      : undefined;
    const existing = requestedConversationId
      ? this.cfg.store.getConversation(requestedConversationId)
      : null;
    const history = existing?.messages ?? (Array.isArray(request.params.history) ? request.params.history : []);
    const rawMessage = String(request.params.message ?? "");
    const conversationId = this.cfg.store.ensureConversation(workspace, rawMessage, requestedConversationId);
    this.cfg.store.addMessage(conversationId, "user", rawMessage);
    this.cfg.store.startTask(runId, conversationId);

    const events: AppEvent[] = [];
    let status: "done" | "failed" | "cancelled" = "done";
    let finalContent = "";

    const emit = (event: AppEvent) => {
      const enriched = { ...event, runId, conversationId } as AppEvent;
      events.push(enriched);
      onEvent?.(enriched);
      this.publishSessionEvent(conversationId, enriched);
    };

    emit({ kind: "run_started", runId, conversationId });

    try {
      const mcpServers = await this.cfg.mcp.connectEnabled(workspace);
      emit({ kind: "mcp_status", servers: mcpServers });
      const availableSkills = await this.cfg.skills.list();
      const contextualMessage = withWorkspaceContext(rawMessage, workspace);
      for await (const event of this.orchestrator.run(contextualMessage, history, {
        signal: controller.signal,
        availableSkills,
        loadSkill: (name) => this.cfg.skills.load(name),
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
            this.pendingConfirmations.set(confirmationId, {
              id: confirmationId,
              runId,
              agentId: confirmation.agentId,
              tool: confirmation.tool,
              args: confirmation.args,
              prompt: confirmation.prompt,
              createdAt: new Date().toISOString(),
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
        this.cfg.store.addMessage(conversationId, "assistant", finalContent);
      }
      this.cfg.store.finishTask(runId, status);
      return { id: request.id, result: { events, runId, conversationId, status } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status = controller.signal.aborted ? "cancelled" : "failed";
      this.cfg.store.finishTask(runId, status, message);
      emit({ kind: "error", message });
      return { id: request.id, result: { events, runId, conversationId, status } };
    } finally {
      this.activeRuns.delete(runId);
      for (const [confirmationId, pending] of this.pendingConfirmations) {
        if (pending.runId === runId) {
          this.pendingConfirmations.delete(confirmationId);
          pending.resolve(false);
        }
      }
    }
  }

  private publishSessionEvent(conversationId: string, event: AppEvent) {
    const listeners = this.sessionListeners.get(conversationId);
    if (!listeners) return;
    for (const listener of listeners) listener(event);
  }
}

export function createRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const acl = new PermissionACL();
  const audit = new AuditLog();
  const store = new WorkspaceStore();
  const tools = new ToolRegistry();
  for (const tool of builtInFileTools) tools.register(tool);
  for (const workspace of store.listWorkspaces()) acl.grantFolder(workspace);

  const resourceRoot = env.COWORK_RESOURCE_DIR ?? process.cwd();
  const skills = new SkillsLoader(path.join(resourceRoot, "skills"));
  const mcp = new McpManager(path.join(resourceRoot, "mcp.json"), tools);
  const provider = env.LLM_PROVIDER ?? "claude";
  let llm: LLMProvider;
  if (provider === "claude") {
    llm = new ClaudeProvider({
      apiKey: env.ANTHROPIC_API_KEY!,
      model: env.CLAUDE_MODEL ?? "claude-sonnet-4-5",
    });
  } else if (provider === "mock" && env.NODE_ENV === "test") {
    llm = new MockProvider();
  } else {
    llm = new OpenAICompatProvider({
      apiKey: env.LLM_API_KEY!,
      baseURL: env.LLM_BASE_URL,
      model: env.LLM_MODEL ?? "gpt-4o",
    });
  }

  return new AppRuntime({ llm, acl, audit, store, tools, skills, mcp });
}
