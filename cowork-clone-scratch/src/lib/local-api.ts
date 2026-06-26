export type SkillSummary = { name: string; description?: string };
export type McpServerSummary = { name: string; enabled: boolean; connected: boolean; tools: string[]; error?: string };
export type ExtensionCommand = {
  id: string;
  label: string;
  command: string;
  description: string;
  workingDir: string | null;
};
export type ExtensionResourceCheck = {
  type: "skill" | "mcpServer";
  name: string;
  ok: boolean;
  path: string | null;
  message: string | null;
};
export type ExtensionSummary = {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  source: "local";
  status: "ready" | "needs_setup" | "disabled" | "invalid";
  valid: boolean;
  errors: string[];
  rootPath: string;
  manifestPath: string;
  resources: {
    skills: string[];
    mcpServers: string[];
    commands: ExtensionCommand[];
  };
  setup: {
    requiredEnv: string[];
    missingEnv: string[];
    instructions: string;
  };
  checks: {
    ready: boolean;
    missingEnv: string[];
    missingResources: ExtensionResourceCheck[];
    resources: ExtensionResourceCheck[];
  };
};
export type Message = { role: "user" | "assistant"; content: string };
export type SessionSummary = {
  id: string;
  workspace: string;
  title: string;
  messages: Message[];
  archived: boolean;
  providerProfileId: string | null;
  model: string | null;
  updatedAt: string;
};
export type AgentEvent = { kind: string; runId?: string; conversationId?: string; [key: string]: unknown };
export type SessionEvent = {
  id: number;
  conversationId: string;
  runId?: string;
  kind: string;
  event: AgentEvent;
  createdAt: string;
};
export type ArtifactSummary = {
  id: string;
  conversationId: string;
  runId: string | null;
  sourceEventId: number | null;
  kind: "created" | "updated" | "moved" | "attached";
  path: string;
  previousPath: string | null;
  name: string;
  fileType: string;
  mimeType: string;
  sizeBytes: number | null;
  toolName: string | null;
  createdAt: string;
  updatedAt: string;
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
export type ArtifactPreviewResult = {
  artifact: ArtifactSummary;
  preview: ArtifactPreview;
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
  artifact: ArtifactSummary;
};
export type WorkspaceMetadata = {
  path: string;
  name: string;
  activeConversationId: string | null;
  sessionCount: number;
  archivedSessionCount: number;
  grantedAt: string;
  updatedAt: string | null;
};
export type ProviderType = "claude" | "openai-compatible" | "ollama" | "mock";
export type ProviderProfile = {
  id: string;
  type: ProviderType;
  name: string;
  model: string;
  baseUrl: string | null;
  hasApiKey: boolean;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};
export type ProviderProfileInput = {
  type: ProviderType;
  name: string;
  model: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  enabled?: boolean;
  isDefault?: boolean;
};
export type ProviderTestResult = { ok: boolean; status: string; detail: string };
export type ProviderModelsResult = { ok: boolean; status: string; models: string[]; detail: string };
export type RunResult = {
  events: AgentEvent[];
  runId: string;
  conversationId: string;
  status: string;
};

export class LocalApiClient {
  constructor(readonly baseUrl: string) {}

  async health() {
    return this.get<{ ok: boolean; version: string }>("/health");
  }

  async waitForHealth(options: { timeoutMs?: number; intervalMs?: number } = {}) {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const intervalMs = options.intervalMs ?? 100;
    const started = Date.now();
    let lastError: unknown;
    while (Date.now() - started < timeoutMs) {
      try {
        return await this.health();
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Timed out waiting for local server");
  }

  async listWorkspaces() {
    const result = await this.get<{ workspaces: string[] }>("/workspaces");
    return result.workspaces;
  }

  async listWorkspaceMetadata() {
    const result = await this.get<{ workspaces: WorkspaceMetadata[] }>("/workspaces/metadata");
    return result.workspaces;
  }

  async grantWorkspace(folder: string) {
    await this.post<{ ok: boolean }>("/workspaces", { folder });
  }

  async listProviders() {
    const result = await this.get<{ providers: ProviderProfile[] }>("/providers");
    return result.providers;
  }

  async createProvider(input: ProviderProfileInput) {
    const result = await this.post<{ provider: ProviderProfile }>("/providers", input);
    return result.provider;
  }

  async updateProvider(providerId: string, input: Partial<ProviderProfileInput>) {
    const result = await this.patch<{ provider: ProviderProfile }>(`/providers/${encodeURIComponent(providerId)}`, input);
    return result.provider;
  }

  async deleteProvider(providerId: string) {
    await this.delete<{ ok: boolean }>(`/providers/${encodeURIComponent(providerId)}`);
  }

  async setDefaultProvider(providerId: string) {
    const result = await this.post<{ provider: ProviderProfile }>(`/providers/${encodeURIComponent(providerId)}/default`, {});
    return result.provider;
  }

  async testProvider(providerId: string) {
    return this.post<ProviderTestResult>(`/providers/${encodeURIComponent(providerId)}/test`, {});
  }

  async listProviderModels(providerId: string) {
    return this.get<ProviderModelsResult>(`/providers/${encodeURIComponent(providerId)}/models`);
  }

  async listExtensions() {
    const result = await this.get<{ extensions: ExtensionSummary[] }>("/extensions");
    return result.extensions;
  }

  async getExtension(extensionId: string) {
    const result = await this.get<{ extension: ExtensionSummary }>(`/extensions/${encodeURIComponent(extensionId)}`);
    return result.extension;
  }

  async listSessions(workspace?: string, options: { includeArchived?: boolean } = {}) {
    const params = new URLSearchParams();
    if (workspace) params.set("workspace", workspace);
    if (options.includeArchived) params.set("includeArchived", "true");
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const result = await this.get<{ sessions: SessionSummary[] }>(`/sessions${query}`);
    return result.sessions;
  }

  async latestSession(workspace: string) {
    const sessions = await this.listSessions(workspace);
    return sessions[0] ?? null;
  }

  async activeSession(workspace: string) {
    const params = new URLSearchParams({ workspace });
    const result = await this.get<{ session: SessionSummary | null }>(`/active-session?${params.toString()}`);
    return result.session;
  }

  async setActiveSession(workspace: string, sessionId: string | null) {
    await this.patch<{ ok: boolean }>("/active-session", { workspace, sessionId });
  }

  async getSession(sessionId: string) {
    const result = await this.get<{ session: SessionSummary }>(`/sessions/${encodeURIComponent(sessionId)}`);
    return result.session;
  }

  async createSession(workspace: string, title: string, options: { providerProfileId?: string | null; model?: string | null } = {}) {
    const result = await this.post<{ conversation: SessionSummary }>("/sessions", { workspace, title, ...options });
    return result.conversation;
  }

  async renameSession(sessionId: string, title: string) {
    const result = await this.patch<{ conversation: SessionSummary }>(`/sessions/${encodeURIComponent(sessionId)}`, { title });
    return result.conversation;
  }

  async archiveSession(sessionId: string, archived = true) {
    const result = await this.patch<{ conversation: SessionSummary }>(`/sessions/${encodeURIComponent(sessionId)}`, { archived });
    return result.conversation;
  }

  async deleteSession(sessionId: string) {
    await this.delete<{ ok: boolean }>(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  async sendMessage(sessionId: string, input: {
    message: string;
    workspace: string;
    runId: string;
    providerProfileId?: string | null;
    model?: string | null;
  }) {
    return this.post<RunResult>(`/sessions/${encodeURIComponent(sessionId)}/messages`, input);
  }

  async listSessionEvents(sessionId: string, options: { afterId?: number } = {}) {
    const params = new URLSearchParams();
    if (options.afterId) params.set("after", String(options.afterId));
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const result = await this.get<{ events: SessionEvent[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/events/replay${query}`,
    );
    return result.events;
  }

  async listArtifacts(sessionId: string) {
    const result = await this.get<{ artifacts: ArtifactSummary[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/artifacts`,
    );
    return result.artifacts;
  }

  async attachArtifact(sessionId: string, path: string) {
    const result = await this.post<{ artifact: ArtifactSummary }>(
      `/sessions/${encodeURIComponent(sessionId)}/artifacts`,
      { path },
    );
    return result.artifact;
  }

  async getArtifact(artifactId: string) {
    const result = await this.get<{ artifact: ArtifactSummary }>(`/artifacts/${encodeURIComponent(artifactId)}`);
    return result.artifact;
  }

  async previewArtifact(artifactId: string, options: { limitBytes?: number } = {}) {
    const params = new URLSearchParams();
    if (options.limitBytes) params.set("limitBytes", String(options.limitBytes));
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return this.get<ArtifactPreviewResult>(`/artifacts/${encodeURIComponent(artifactId)}/preview${query}`);
  }

  async readFiles(sessionId: string, files: Array<string | { path: string; limitBytes?: number }>) {
    const input = files.map((file) => typeof file === "string" ? { path: file } : file);
    const result = await this.post<{ files: BatchFileRead[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/files/read`,
      { files: input },
    );
    return result.files;
  }

  async writeFiles(sessionId: string, files: Array<{ path: string; content: string }>) {
    const result = await this.post<{ files: BatchFileWrite[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/files/write`,
      { files },
    );
    return result.files;
  }

  openSessionEvents(sessionId: string, onEvent: (event: AgentEvent) => void) {
    const source = new EventSource(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events`);
    source.onmessage = (message) => onEvent(JSON.parse(message.data) as AgentEvent);
    const eventTypes = [
      "run_started",
      "mcp_status",
      "thinking",
      "plan",
      "subagent_spawned",
      "subagent_progress",
      "subagent_done",
      "skill_activated",
      "tool_call",
      "tool_result",
      "confirmation_requested",
      "confirmation_resolved",
      "file_attached",
      "file_created",
      "file_moved",
      "file_read",
      "file_updated",
      "artifact_created",
      "artifact_attached",
      "artifact_updated",
      "artifact_moved",
      "run_cancelled",
      "final",
      "error",
    ];
    for (const eventType of eventTypes) {
      source.addEventListener(eventType, (message) => {
        onEvent(JSON.parse((message as MessageEvent).data) as AgentEvent);
      });
    }
    return source;
  }

  async respondApproval(confirmationId: string, approved: boolean) {
    await this.post<{ ok: boolean }>(`/approvals/${encodeURIComponent(confirmationId)}`, { approved });
  }

  async cancelRun(runId: string) {
    await this.post<{ ok: boolean; status?: string }>(`/runs/${encodeURIComponent(runId)}/cancel`, {});
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  private async post<T>(path: string, body: object): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async patch<T>(path: string, body: object): Promise<T> {
    return this.request<T>(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    const body = await response.json().catch(() => null) as { error?: string } | T | null;
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body
        ? String(body.error)
        : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return body as T;
  }
}
