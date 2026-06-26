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
import {
  WorkspaceStore,
  type ProviderProfileInput,
  type ProviderProfileSecret,
  type ProviderProfileUpdate,
  type ProviderType,
  type StoredConversation,
} from "./storage/workspace-store.js";
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
  fallbackProvider?: RunProviderMetadata;
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

type RunProviderMetadata = {
  providerProfileId: string | null;
  providerName: string;
  providerType: ProviderType | "env";
  model: string;
};

type ProviderModelsResult = {
  ok: boolean;
  status: string;
  models: string[];
  detail: string;
};

export class AppRuntime {
  private activeRuns = new Map<string, AbortController>();
  private pendingConfirmations = new Map<string, PendingConfirmation>();
  private sessionListeners = new Map<string, Set<SessionListener>>();

  constructor(private cfg: AppRuntimeConfig) {}

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
            {
              providerProfileId: optionalString(request.params.providerProfileId),
              model: optionalString(request.params.model),
            },
          );
          return { id: request.id, result: { conversation: this.cfg.store.getConversation(conversationId) } };
        }

        case "active_conversation": {
          const workspace = String(request.params.workspace ?? "");
          if (!workspace) return { id: request.id, error: { message: "Workspace is required", code: 400 } };
          return { id: request.id, result: { conversation: this.cfg.store.getActiveConversation(workspace) } };
        }

        case "set_active_conversation": {
          const workspace = String(request.params.workspace ?? "");
          if (!workspace) return { id: request.id, error: { message: "Workspace is required", code: 400 } };
          const conversationId = request.params.conversationId ? String(request.params.conversationId) : null;
          const ok = this.cfg.store.setActiveConversation(workspace, conversationId);
          if (!ok) return { id: request.id, error: { message: "Conversation not found", code: 404 } };
          return { id: request.id, result: { ok: true } };
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

        case "list_conversation_events":
          return {
            id: request.id,
            result: {
              events: this.cfg.store.listEvents(String(request.params.conversationId), {
                afterId: Number(request.params.afterId ?? 0),
              }),
            },
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

        case "list_provider_profiles":
          return { id: request.id, result: { providers: this.listProviderProfiles() } };

        case "create_provider_profile":
          return {
            id: request.id,
            result: { provider: this.createProviderProfile(request.params as ProviderProfileInput) },
          };

        case "update_provider_profile": {
          const provider = this.updateProviderProfile(
            String(request.params.providerId),
            request.params.profile as ProviderProfileUpdate,
          );
          if (!provider) return { id: request.id, error: { message: "Provider profile not found", code: 404 } };
          return { id: request.id, result: { provider } };
        }

        case "delete_provider_profile": {
          const deleted = this.deleteProviderProfile(String(request.params.providerId));
          if (!deleted) return { id: request.id, error: { message: "Provider profile not found", code: 404 } };
          return { id: request.id, result: { ok: true } };
        }

        case "set_default_provider_profile": {
          const provider = this.setDefaultProviderProfile(String(request.params.providerId));
          if (!provider) return { id: request.id, error: { message: "Provider profile not found", code: 404 } };
          return { id: request.id, result: { provider } };
        }

        case "test_provider_profile": {
          const result = this.testProviderProfile(String(request.params.providerId));
          if (!result) return { id: request.id, error: { message: "Provider profile not found", code: 404 } };
          return { id: request.id, result };
        }

        case "list_provider_models": {
          const result = await this.listProviderModels(String(request.params.providerId));
          if (!result) return { id: request.id, error: { message: "Provider profile not found", code: 404 } };
          return { id: request.id, result };
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

  listWorkspaceMetadata() {
    return this.cfg.store.listWorkspaceMetadata();
  }

  listConversations(workspace?: unknown, options: { includeArchived?: boolean } = {}): StoredConversation[] {
    return this.cfg.store.listConversations(workspace, options);
  }

  getConversation(id: string): StoredConversation | null {
    return this.cfg.store.getConversation(id);
  }

  getActiveConversation(workspace: string): StoredConversation | null {
    return this.cfg.store.getActiveConversation(workspace);
  }

  setActiveConversation(workspace: string, conversationId: string | null): boolean {
    return this.cfg.store.setActiveConversation(workspace, conversationId);
  }

  listConversationEvents(conversationId: string, options: { afterId?: number } = {}) {
    return this.cfg.store.listEvents(conversationId, options);
  }

  listProviderProfiles() {
    return this.cfg.store.listProviderProfiles();
  }

  createProviderProfile(input: ProviderProfileInput) {
    return this.cfg.store.createProviderProfile(input);
  }

  updateProviderProfile(id: string, input: ProviderProfileUpdate) {
    return this.cfg.store.updateProviderProfile(id, input);
  }

  deleteProviderProfile(id: string) {
    return this.cfg.store.deleteProviderProfile(id);
  }

  setDefaultProviderProfile(id: string) {
    return this.cfg.store.setDefaultProviderProfile(id);
  }

  testProviderProfile(id: string): { ok: boolean; status: string; detail: string } | null {
    const provider = this.cfg.store.getProviderProfileWithSecret(id);
    if (!provider) return null;
    const readiness = validateProviderReadiness(provider.type, {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: provider.model,
    });
    return readiness.ok
      ? { ok: true, status: "ready", detail: `${provider.name} is configured for ${provider.model}` }
      : { ok: false, status: "configuration_error", detail: readiness.detail };
  }

  async listProviderModels(id: string): Promise<ProviderModelsResult | null> {
    const provider = this.cfg.store.getProviderProfileWithSecret(id);
    if (!provider) return null;
    if (provider.type === "mock") {
      return { ok: true, status: "ready", models: ["mock"], detail: "Mock provider has one deterministic model" };
    }
    if (provider.type === "claude" && !provider.baseUrl) {
      return {
        ok: true,
        status: "preset",
        models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
        detail: "Claude presets loaded",
      };
    }
    const readiness = validateProviderReadiness(provider.type, {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: provider.model,
    });
    if (!readiness.ok) {
      return { ok: false, status: "configuration_error", models: [], detail: readiness.detail };
    }
    if (!provider.baseUrl) {
      return { ok: false, status: "unsupported", models: [], detail: "Model refresh requires a base URL" };
    }
    return fetchOpenAICompatibleModels(provider);
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
    const providerProfileId = optionalString(request.params.providerProfileId) ?? existing?.providerProfileId ?? undefined;
    const requestedModel = optionalString(request.params.model) ?? existing?.model ?? undefined;
    const providerSelection = this.resolveProvider(providerProfileId, requestedModel);
    if (!providerSelection) {
      return { id: request.id, error: { message: "Provider profile not found", code: 404 } };
    }
    if (providerSelection.error) {
      return { id: request.id, error: { message: providerSelection.error, code: 400 } };
    }

    const conversationId = this.cfg.store.ensureConversation(workspace, rawMessage, requestedConversationId, {
      providerProfileId: providerSelection.metadata.providerProfileId,
      model: providerSelection.metadata.model,
    });
    this.cfg.store.setActiveConversation(workspace, conversationId);
    this.cfg.store.addMessage(conversationId, "user", rawMessage);
    this.cfg.store.startTask(runId, conversationId);
    this.cfg.store.setConversationProvider(conversationId, {
      providerProfileId: providerSelection.metadata.providerProfileId,
      model: providerSelection.metadata.model,
    });

    const events: AppEvent[] = [];
    let status: "done" | "failed" | "cancelled" = "done";
    let finalContent = "";
    const orchestrator = this.createOrchestrator(providerSelection.llm);

    const emit = (event: AppEvent) => {
      const enriched = { ...event, runId, conversationId } as AppEvent;
      events.push(enriched);
      this.cfg.store.addEvent(conversationId, enriched);
      onEvent?.(enriched);
      this.publishSessionEvent(conversationId, enriched);
    };

    emit({
      kind: "run_started",
      runId,
      conversationId,
      providerProfileId: providerSelection.metadata.providerProfileId,
      providerName: providerSelection.metadata.providerName,
      providerType: providerSelection.metadata.providerType,
      model: providerSelection.metadata.model,
    });

    try {
      const mcpServers = await this.cfg.mcp.connectEnabled(workspace);
      emit({ kind: "mcp_status", servers: mcpServers });
      const availableSkills = await this.cfg.skills.list();
      const contextualMessage = withWorkspaceContext(rawMessage, workspace);
      for await (const event of orchestrator.run(contextualMessage, history, {
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

  private createOrchestrator(llm: LLMProvider) {
    if (this.cfg.orchestrator && llm === this.cfg.llm) return this.cfg.orchestrator;
    return new Orchestrator({
      llm,
      acl: this.cfg.acl,
      audit: this.cfg.audit,
      tools: this.cfg.tools,
    });
  }

  private resolveProvider(providerProfileId?: string, modelOverride?: string): {
    llm: LLMProvider;
    metadata: RunProviderMetadata;
    error?: string;
  } | null {
    const profile = providerProfileId
      ? this.cfg.store.getProviderProfileWithSecret(providerProfileId)
      : this.cfg.store.getDefaultProviderProfileWithSecret();
    if (!profile) {
      if (providerProfileId) return null;
      const fallback = this.cfg.fallbackProvider ?? {
        providerProfileId: null,
        providerName: this.cfg.llm.name,
        providerType: "env" as const,
        model: "env",
      };
      return {
        llm: this.cfg.llm,
        metadata: { ...fallback, model: modelOverride ?? fallback.model },
      };
    }
    if (!profile.enabled) return { llm: this.cfg.llm, metadata: profileMetadata(profile, modelOverride), error: "Provider profile is disabled" };
    const metadata = profileMetadata(profile, modelOverride);
    const readiness = validateProviderReadiness(profile.type, {
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: metadata.model,
    });
    if (!readiness.ok) return { llm: this.cfg.llm, metadata, error: readiness.detail };
    return { llm: createLLMFromProviderProfile(profile, metadata.model), metadata };
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
  let fallbackProvider: RunProviderMetadata;
  if (provider === "claude") {
    const model = env.CLAUDE_MODEL ?? "claude-sonnet-4-5";
    llm = new ClaudeProvider({
      apiKey: env.ANTHROPIC_API_KEY!,
      model,
    });
    fallbackProvider = { providerProfileId: null, providerName: "Claude env", providerType: "env", model };
  } else if (provider === "mock" && env.NODE_ENV === "test") {
    llm = new MockProvider();
    fallbackProvider = { providerProfileId: null, providerName: "Mock env", providerType: "env", model: "mock" };
  } else {
    const model = env.LLM_MODEL ?? "gpt-4o";
    llm = new OpenAICompatProvider({
      apiKey: env.LLM_API_KEY!,
      baseURL: env.LLM_BASE_URL,
      model,
    });
    fallbackProvider = { providerProfileId: null, providerName: "OpenAI-compatible env", providerType: "env", model };
  }

  return new AppRuntime({ llm, fallbackProvider, acl, audit, store, tools, skills, mcp });
}

function createLLMFromProviderProfile(profile: ProviderProfileSecret, model: string): LLMProvider {
  if (profile.type === "mock") return new MockProvider();
  if (profile.type === "claude") {
    return new ClaudeProvider({
      apiKey: profile.apiKey!,
      baseURL: profile.baseUrl ?? undefined,
      model,
    });
  }
  return new OpenAICompatProvider({
    apiKey: profile.apiKey || "ollama",
    baseURL: profile.baseUrl ?? undefined,
    model,
  });
}

async function fetchOpenAICompatibleModels(profile: ProviderProfileSecret): Promise<ProviderModelsResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(joinUrl(profile.baseUrl!, "models"), {
      headers: profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: "request_failed",
        models: [],
        detail: `Model list request failed with HTTP ${response.status}`,
      };
    }
    const body = await response.json() as { data?: Array<{ id?: unknown }>; models?: unknown[] };
    const models = Array.isArray(body.data)
      ? body.data.map((entry) => entry.id).filter((id): id is string => typeof id === "string")
      : Array.isArray(body.models)
        ? body.models.filter((id): id is string => typeof id === "string")
        : [];
    return models.length > 0
      ? { ok: true, status: "ready", models, detail: `${models.length} models found` }
      : { ok: false, status: "empty", models: [], detail: "No models were returned by this endpoint" };
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    const detail = profile.type === "ollama"
      ? "Could not reach Ollama. Check that Ollama is running and the base URL is correct."
      : `Could not reach model endpoint: ${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, status: isAbort ? "timeout" : "unreachable", models: [], detail };
  } finally {
    clearTimeout(timeout);
  }
}

function joinUrl(baseUrl: string, segment: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${segment.replace(/^\/+/, "")}`;
}

function profileMetadata(profile: ProviderProfileSecret, modelOverride?: string): RunProviderMetadata {
  return {
    providerProfileId: profile.id,
    providerName: profile.name,
    providerType: profile.type,
    model: modelOverride ?? profile.model,
  };
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function validateProviderReadiness(
  type: ProviderType,
  cfg: { apiKey: string | null; baseUrl: string | null; model: string },
) {
  if (!cfg.model.trim()) return { ok: false, detail: "Model is required" };
  if (type === "mock") return { ok: true, detail: "Mock provider is ready" };
  if (type === "claude") {
    return cfg.apiKey
      ? { ok: true, detail: "Claude provider is configured" }
      : { ok: false, detail: "Anthropic API key is required" };
  }
  if (type === "ollama") {
    return cfg.baseUrl
      ? { ok: true, detail: "Ollama-compatible endpoint is configured" }
      : { ok: false, detail: "Ollama base URL is required" };
  }
  return cfg.apiKey
    ? { ok: true, detail: "OpenAI-compatible provider is configured" }
    : { ok: false, detail: "API key is required" };
}
