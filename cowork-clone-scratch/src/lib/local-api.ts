export type SkillSummary = { name: string; description?: string };
export type McpServerSummary = { name: string; enabled: boolean; connected: boolean; tools: string[]; error?: string };
export type Message = { role: "user" | "assistant"; content: string };
export type SessionSummary = {
  id: string;
  workspace: string;
  title: string;
  messages: Message[];
  archived: boolean;
  updatedAt: string;
};
export type AgentEvent = { kind: string; runId?: string; conversationId?: string; [key: string]: unknown };
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

  async grantWorkspace(folder: string) {
    await this.post<{ ok: boolean }>("/workspaces", { folder });
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

  async getSession(sessionId: string) {
    const result = await this.get<{ session: SessionSummary }>(`/sessions/${encodeURIComponent(sessionId)}`);
    return result.session;
  }

  async createSession(workspace: string, title: string) {
    const result = await this.post<{ conversation: SessionSummary }>("/sessions", { workspace, title });
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

  async sendMessage(sessionId: string, input: { message: string; workspace: string; runId: string }) {
    return this.post<RunResult>(`/sessions/${encodeURIComponent(sessionId)}/messages`, input);
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

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async patch<T>(path: string, body: Record<string, unknown>): Promise<T> {
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
