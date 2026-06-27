import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { Orchestrator, type OrchestratorEvent } from "./agent/orchestrator.js";
import { ToolRegistry } from "./agent/tools/registry.js";
import { builtInFileTools } from "./agent/tools/file-tools.js";
import { PermissionACL } from "./permissions/acl.js";
import { AuditLog } from "./permissions/audit.js";
import { ClaudeProvider } from "./llm/claude.js";
import { OpenAICompatProvider } from "./llm/openai-compatible.js";
import { SkillsLoader, type Skill, type SkillMetadata } from "./skills/loader.js";
import { ExtensionsLoader } from "./extensions/loader.js";
import {
  WorkspaceStore,
  type ProviderProfileInput,
  type ProviderProfileSecret,
  type ProviderProfileUpdate,
  type ProviderType,
  type ArtifactInput,
  type StoredArtifact,
  type StoredConversation,
} from "./storage/workspace-store.js";
import { withWorkspaceContext } from "./workspace-context.js";
import { McpManager } from "./mcp/manager.js";
import type { LLMProvider } from "./llm/provider.js";
import { MockProvider } from "./llm/mock.js";

export type RpcRequest = { id: string; method: string; params: Record<string, any> };
export type RpcResponse = { id: string; result?: unknown; error?: { message: string; code?: number } };
export type AppEvent = OrchestratorEvent | {
  kind:
    | "artifact_created"
    | "artifact_attached"
    | "artifact_moved"
    | "artifact_updated"
    | "confirmation_requested"
    | "confirmation_resolved"
    | "file_attached"
    | "file_created"
    | "file_moved"
    | "file_read"
    | "file_updated"
    | "run_started"
    | "run_cancelled"
    | "mcp_status";
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
  extensions: ExtensionsLoader;
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

export type ArtifactPreview =
  | {
      kind: "text";
      content: string;
      truncated: boolean;
      limitBytes: number;
    }
  | {
      kind: "image";
      dataUrl: string;
      truncated: false;
      limitBytes: number;
    }
  | {
      kind: "binary" | "missing";
      message: string;
      truncated: false;
      limitBytes: number;
    };

export type BatchFileRead = {
  path: string;
  name: string;
  fileType: string;
  mimeType: string;
  sizeBytes: number | null;
  content: string;
  truncated: boolean;
  limitBytes: number;
};

export type BatchFileWrite = {
  path: string;
  name: string;
  fileType: string;
  mimeType: string;
  sizeBytes: number | null;
  created: boolean;
  artifact: StoredArtifact;
};

export class AppRuntime {
  private activeRuns = new Map<string, AbortController>();
  private pendingConfirmations = new Map<string, PendingConfirmation>();
  private sessionListeners = new Map<string, Set<SessionListener>>();
  private pendingToolCalls = new Map<string, Array<{ name: string; args: unknown; existedBefore?: boolean }>>();

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
          return { id: request.id, result: { skills: await this.listSkills() } };

        case "load_skill":
          return { id: request.id, result: { skill: await this.loadSkill(String(request.params.name)) } };

        case "list_extensions":
          return { id: request.id, result: { extensions: await this.cfg.extensions.list() } };

        case "get_extension": {
          const extension = await this.cfg.extensions.get(String(request.params.extensionId));
          if (!extension) return { id: request.id, error: { message: "Extension not found", code: 404 } };
          return { id: request.id, result: { extension } };
        }

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

  listArtifacts(conversationId: string) {
    return this.cfg.store.listArtifacts(conversationId);
  }

  getArtifact(id: string) {
    return this.cfg.store.getArtifact(id);
  }

  previewArtifact(id: string, options: { limitBytes?: number } = {}): { artifact: StoredArtifact; preview: ArtifactPreview } | null {
    const artifact = this.cfg.store.getArtifact(id);
    if (!artifact) return null;
    const conversation = this.cfg.store.getConversation(artifact.conversationId);
    if (!conversation) return null;
    const target = path.resolve(artifact.path);
    if (!pathIsInside(conversation.workspace, target)) {
      throw new Error("Artifact path must be inside the session workspace");
    }
    const limitBytes = clampPreviewLimit(options.limitBytes ?? 64 * 1024);
    if (!existsSync(target)) {
      return {
        artifact,
        preview: {
          kind: "missing",
          message: "The file no longer exists on disk.",
          truncated: false,
          limitBytes,
        },
      };
    }
    const stats = statSync(target);
    if (!stats.isFile()) {
      return {
        artifact,
        preview: {
          kind: "binary",
          message: "Only regular files can be previewed.",
          truncated: false,
          limitBytes,
        },
      };
    }
    if (isTextPreview(artifact)) {
      const content = readPreviewBytes(target, limitBytes).toString("utf-8");
      return {
        artifact,
        preview: {
          kind: "text",
          content,
          truncated: stats.size > limitBytes,
          limitBytes,
        },
      };
    }
    if (isImagePreview(artifact) && stats.size <= limitBytes) {
      const dataUrl = `data:${artifact.mimeType};base64,${readFileSync(target).toString("base64")}`;
      return {
        artifact,
        preview: {
          kind: "image",
          dataUrl,
          truncated: false,
          limitBytes,
        },
      };
    }
    return {
      artifact,
      preview: {
        kind: "binary",
        message: "Preview is not available for this file type or size.",
        truncated: false,
        limitBytes,
      },
    };
  }

  attachArtifact(conversationId: string, filePath: string) {
    const conversation = this.cfg.store.getConversation(conversationId);
    if (!conversation) return null;
    const target = path.resolve(filePath);
    if (!pathIsInside(conversation.workspace, target)) {
      throw new Error("Artifact path must be inside the session workspace");
    }
    if (!existsSync(target)) throw new Error("Artifact path does not exist");
    const artifact = this.cfg.store.addArtifact({
      conversationId,
      kind: "attached",
      path: target,
      toolName: "attach_file",
      metadata: fileMetadata(target),
    });
    const event: AppEvent = {
      kind: "artifact_attached",
      conversationId,
      artifact,
      sourceEventId: null,
    };
    this.cfg.store.addEvent(conversationId, event);
    this.publishSessionEvent(conversationId, event);
    this.recordSessionEvent(conversationId, fileEventKind("attached"), {
      path: target,
      artifactId: artifact.id,
      sizeBytes: artifact.sizeBytes,
      mimeType: artifact.mimeType,
      fileType: artifact.fileType,
    });
    return artifact;
  }

  batchReadFiles(
    conversationId: string,
    files: Array<{ path: string; limitBytes?: number }>,
  ): { files: BatchFileRead[] } | null {
    const conversation = this.cfg.store.getConversation(conversationId);
    if (!conversation) return null;
    const result = files.map((file) => {
      const target = this.resolveSessionFilePath(conversation, file.path);
      if (!existsSync(target)) throw new Error(`File does not exist: ${target}`);
      const stats = statSync(target);
      if (!stats.isFile()) throw new Error(`Not a regular file: ${target}`);
      const limitBytes = clampPreviewLimit(file.limitBytes ?? 64 * 1024);
      const content = readPreviewBytes(target, limitBytes).toString("utf-8");
      const output = {
        path: target,
        name: path.basename(target),
        fileType: inferFileType(target),
        mimeType: inferMimeType(target),
        sizeBytes: stats.size,
        content,
        truncated: stats.size > limitBytes,
        limitBytes,
      };
      this.recordSessionEvent(conversationId, "file_read", {
        path: target,
        sizeBytes: output.sizeBytes,
        mimeType: output.mimeType,
        fileType: output.fileType,
        truncated: output.truncated,
      });
      return output;
    });
    return { files: result };
  }

  batchWriteFiles(
    conversationId: string,
    files: Array<{ path: string; content: string }>,
  ): { files: BatchFileWrite[] } | null {
    const conversation = this.cfg.store.getConversation(conversationId);
    if (!conversation) return null;
    const result = files.map((file) => {
      const target = this.resolveSessionFilePath(conversation, file.path);
      const created = !existsSync(target);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.content, "utf-8");
      const artifact = this.cfg.store.addArtifact({
        conversationId,
        kind: created ? "created" : "updated",
        path: target,
        toolName: "batch_write",
        metadata: fileMetadata(target),
      });
      const artifactEvent: AppEvent = {
        kind: artifactEventKind(artifact.kind),
        conversationId,
        artifact,
        sourceEventId: null,
      };
      this.cfg.store.addEvent(conversationId, artifactEvent);
      this.publishSessionEvent(conversationId, artifactEvent);
      this.recordSessionEvent(conversationId, fileEventKind(artifact.kind), {
        path: target,
        artifactId: artifact.id,
        sizeBytes: artifact.sizeBytes,
        mimeType: artifact.mimeType,
        fileType: artifact.fileType,
      });
      return {
        path: target,
        name: artifact.name,
        fileType: artifact.fileType,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        created,
        artifact,
      };
    });
    return { files: result };
  }

  listProviderProfiles() {
    return this.cfg.store.listProviderProfiles();
  }

  async listExtensions() {
    return this.cfg.extensions.list();
  }

  async getExtension(id: string) {
    return this.cfg.extensions.get(id);
  }

  async listSkills(): Promise<SkillMetadata[]> {
    const baseSkills = await this.cfg.skills.list();
    const knownNames = new Set(baseSkills.map((skill) => skill.name));
    const extensionSkills: SkillMetadata[] = [];
    for (const resource of await this.cfg.extensions.listReadySkillResources()) {
      const metadata = await this.cfg.skills.metadataFromPath(resource.path, path.basename(resource.path));
      if (!metadata || knownNames.has(metadata.name)) continue;
      knownNames.add(metadata.name);
      extensionSkills.push({
        ...metadata,
        raw: { ...metadata.raw, extensionId: resource.extensionId },
      });
    }
    return [...baseSkills, ...extensionSkills];
  }

  async loadSkill(name: string): Promise<Skill> {
    const baseSkills = await this.cfg.skills.list();
    const baseSkill = baseSkills.find((skill) => skill.name === name);
    if (baseSkill) return this.cfg.skills.loadFromPath(baseSkill.path, path.basename(baseSkill.path));
    for (const resource of await this.cfg.extensions.listReadySkillResources()) {
      const metadata = await this.cfg.skills.metadataFromPath(resource.path, path.basename(resource.path));
      if (metadata?.name === name) return this.cfg.skills.loadFromPath(resource.path, path.basename(resource.path));
    }
    return this.cfg.skills.load(name);
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
      const storedEvent = this.cfg.store.addEvent(conversationId, enriched);
      onEvent?.(enriched);
      this.publishSessionEvent(conversationId, enriched);
      const artifactEvent = this.recordArtifactFromEvent(conversationId, runId, enriched, storedEvent.id);
      if (!artifactEvent) return;
      events.push(artifactEvent);
      this.cfg.store.addEvent(conversationId, artifactEvent);
      onEvent?.(artifactEvent);
      this.publishSessionEvent(conversationId, artifactEvent);
      const artifact = (artifactEvent as AppEvent & { artifact: StoredArtifact }).artifact;
      this.recordSessionEvent(conversationId, fileEventKind(artifact.kind), {
        path: artifact.path,
        previousPath: artifact.previousPath,
        artifactId: artifact.id,
        runId,
        sourceEventId: storedEvent.id,
        sizeBytes: artifact.sizeBytes,
        mimeType: artifact.mimeType,
        fileType: artifact.fileType,
      });
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
      const availableSkills = await this.listSkills();
      const contextualMessage = withWorkspaceContext(rawMessage, workspace);
      for await (const event of orchestrator.run(contextualMessage, history, {
        signal: controller.signal,
        availableSkills,
        loadSkill: (name) => this.loadSkill(name),
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

  private recordSessionEvent(conversationId: string, kind: AppEvent["kind"], payload: Record<string, unknown>) {
    const event = { kind, conversationId, ...payload } as AppEvent;
    this.cfg.store.addEvent(conversationId, event);
    this.publishSessionEvent(conversationId, event);
  }

  private resolveSessionFilePath(conversation: StoredConversation, filePath: string) {
    const target = path.resolve(conversation.workspace, filePath);
    if (!pathIsInside(conversation.workspace, target)) {
      throw new Error("File path must be inside the session workspace");
    }
    return target;
  }

  private recordArtifactFromEvent(
    conversationId: string,
    runId: string,
    event: AppEvent,
    sourceEventId: number,
  ): AppEvent | null {
    if (event.kind === "tool_call") {
      const key = String(event.id ?? "agent");
      const calls = this.pendingToolCalls.get(key) ?? [];
      const args = event.args;
      calls.push({
        name: String(event.name ?? ""),
        args,
        existedBefore: isObject(args) && typeof args.path === "string"
          ? existsSync(args.path)
          : undefined,
      });
      this.pendingToolCalls.set(key, calls.slice(-20));
      return null;
    }
    if (event.kind !== "tool_result") return null;
    const key = String(event.id ?? "agent");
    const calls = this.pendingToolCalls.get(key) ?? [];
    const index = calls.findIndex((call) => call.name === event.name);
    const [call] = index >= 0 ? calls.splice(index, 1) : [];
    if (calls.length > 0) this.pendingToolCalls.set(key, calls);
    else this.pendingToolCalls.delete(key);
    if (!call || !isObject(call.args)) return null;

    const artifactInput = artifactInputFromToolResult(
      conversationId,
      runId,
      sourceEventId,
      String(event.name),
      call.args,
      event.result,
      call.existedBefore,
    );
    if (!artifactInput) return null;
    const artifact = this.cfg.store.addArtifact(artifactInput);
    return {
      kind: artifactEventKind(artifact.kind),
      runId,
      conversationId,
      artifact,
      sourceEventId,
    };
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
  const extensions = new ExtensionsLoader(path.join(resourceRoot, "extensions"), { env, resourceRoot });
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
  seedEnvProviderProfile(store, env, provider);

  return new AppRuntime({ llm, fallbackProvider, acl, audit, store, tools, skills, extensions, mcp });
}

function seedEnvProviderProfile(store: WorkspaceStore, env: NodeJS.ProcessEnv, provider: string) {
  if (store.listProviderProfiles().length > 0) return;

  const profile = envProviderProfileInput(env, provider);
  if (!profile) return;
  store.createProviderProfile({ ...profile, enabled: true, isDefault: true });
}

function envProviderProfileInput(env: NodeJS.ProcessEnv, provider: string): ProviderProfileInput | null {
  if (provider === "claude") {
    const model = env.CLAUDE_MODEL ?? "claude-sonnet-4-5";
    return {
      type: "claude",
      name: "Claude env",
      model,
      apiKey: env.ANTHROPIC_API_KEY ?? null,
    };
  }

  if (provider === "mock" && env.NODE_ENV === "test") {
    return {
      type: "mock",
      name: "Mock env",
      model: "mock",
    };
  }

  const type: ProviderType = provider === "ollama" ? "ollama" : "openai-compatible";
  const model = env.LLM_MODEL ?? (type === "ollama" ? "llama3.2" : "gpt-4o");
  const baseUrl = env.LLM_BASE_URL ?? (type === "ollama" ? "http://localhost:11434/v1" : null);
  const name = baseUrl?.includes("deepseek")
    ? "DeepSeek env"
    : type === "ollama"
      ? "Ollama env"
      : "OpenAI-compatible env";
  return {
    type,
    name,
    model,
    baseUrl,
    apiKey: env.LLM_API_KEY ?? null,
  };
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

function artifactInputFromToolResult(
  conversationId: string,
  runId: string,
  sourceEventId: number,
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  existedBefore?: boolean,
): ArtifactInput | null {
  const resultText = typeof result === "string" ? result : "";
  if (toolName === "write_file" && resultText.startsWith("Wrote ")) {
    const target = stringArg(args, "path");
    if (!target) return null;
    return {
      conversationId,
      runId,
      sourceEventId,
      kind: existedBefore ? "updated" : "created",
      path: target,
      toolName,
      metadata: fileMetadata(target),
    };
  }
  if (toolName === "move_file" && resultText.startsWith("Moved ")) {
    const target = stringArg(args, "to");
    const previousPath = stringArg(args, "from");
    if (!target) return null;
    return {
      conversationId,
      runId,
      sourceEventId,
      kind: "moved",
      path: target,
      previousPath,
      toolName,
      metadata: fileMetadata(target),
    };
  }
  return null;
}

function fileMetadata(filePath: string): ArtifactInput["metadata"] {
  try {
    const stats = statSync(filePath);
    return {
      fileType: inferFileType(filePath),
      mimeType: inferMimeType(filePath),
      sizeBytes: stats.isFile() ? stats.size : null,
    };
  } catch {
    return {
      fileType: inferFileType(filePath),
      mimeType: inferMimeType(filePath),
      sizeBytes: null,
    };
  }
}

function artifactEventKind(
  kind: ArtifactInput["kind"],
): "artifact_created" | "artifact_updated" | "artifact_moved" | "artifact_attached" {
  if (kind === "created") return "artifact_created";
  if (kind === "updated") return "artifact_updated";
  if (kind === "attached") return "artifact_attached";
  return "artifact_moved";
}

function fileEventKind(kind: ArtifactInput["kind"]): "file_created" | "file_updated" | "file_moved" | "file_attached" {
  if (kind === "created") return "file_created";
  if (kind === "updated") return "file_updated";
  if (kind === "attached") return "file_attached";
  return "file_moved";
}

function stringArg(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inferFileType(filePath: string) {
  const extension = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return extension || "file";
}

function inferMimeType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  const known: Record<string, string> = {
    ".css": "text/css",
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
  };
  return known[extension] ?? "application/octet-stream";
}

function pathIsInside(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function clampPreviewLimit(limitBytes: number) {
  if (!Number.isFinite(limitBytes)) return 64 * 1024;
  return Math.min(Math.max(Math.floor(limitBytes), 1024), 256 * 1024);
}

function readPreviewBytes(filePath: string, limitBytes: number) {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(limitBytes);
    const bytesRead = readSync(fd, buffer, 0, limitBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function isTextPreview(artifact: StoredArtifact) {
  if (artifact.mimeType.startsWith("text/")) return true;
  return [
    "application/json",
    "application/xml",
    "application/yaml",
    "image/svg+xml",
  ].includes(artifact.mimeType)
    || [
      "css",
      "csv",
      "env",
      "html",
      "js",
      "json",
      "md",
      "toml",
      "ts",
      "tsx",
      "txt",
      "xml",
      "yaml",
      "yml",
    ].includes(artifact.fileType);
}

function isImagePreview(artifact: StoredArtifact) {
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(artifact.mimeType);
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
