import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "../llm/provider.js";

export type StoredConversation = {
  id: string;
  workspace: string;
  title: string;
  messages: Message[];
  archived: boolean;
  providerProfileId: string | null;
  model: string | null;
  updatedAt: string;
};

export type StoredEvent = {
  id: number;
  conversationId: string;
  runId?: string;
  kind: string;
  event: Record<string, unknown>;
  createdAt: string;
};

export type StoredWorkspaceMetadata = {
  path: string;
  name: string;
  activeConversationId: string | null;
  sessionCount: number;
  archivedSessionCount: number;
  grantedAt: string;
  updatedAt: string | null;
};

export type ProviderType = "claude" | "openai-compatible" | "ollama" | "mock";

export type ProviderProfileInput = {
  type: ProviderType;
  name: string;
  model: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  enabled?: boolean;
  isDefault?: boolean;
};

export type ProviderProfileUpdate = Partial<ProviderProfileInput>;

export type StoredProviderProfile = {
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

export type ProviderProfileSecret = StoredProviderProfile & {
  apiKey: string | null;
};

export type ConversationOptions = {
  providerProfileId?: string | null;
  model?: string | null;
};

export class WorkspaceStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const target = dbPath ?? path.join(os.homedir(), ".cowork-clone", "state.db");
    if (target !== ":memory:") fs.mkdirSync(path.dirname(target), { recursive: true });
    this.db = new Database(target);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        path TEXT PRIMARY KEY,
        granted_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        title TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        provider_profile_id TEXT,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tasks (
        run_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS conversation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        run_id TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS workspace_state (
        workspace TEXT PRIMARY KEY,
        active_conversation_id TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS provider_profiles (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        base_url TEXT,
        api_key TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace, updated_at);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
      CREATE INDEX IF NOT EXISTS idx_events_conversation ON conversation_events(conversation_id, id);
      CREATE INDEX IF NOT EXISTS idx_provider_profiles_default ON provider_profiles(is_default);
    `);
    this.ensureColumn("conversations", "archived", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("conversations", "provider_profile_id", "TEXT");
    this.ensureColumn("conversations", "model", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  grantWorkspace(workspace: string) {
    const absolute = path.resolve(workspace);
    this.db.prepare("INSERT OR IGNORE INTO workspaces (path) VALUES (?)").run(absolute);
  }

  listWorkspaces(): string[] {
    const rows = this.db.prepare("SELECT path FROM workspaces ORDER BY granted_at").all() as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  listWorkspaceMetadata(): StoredWorkspaceMetadata[] {
    const rows = this.db
      .prepare(`
        SELECT
          workspaces.path,
          workspaces.granted_at,
          workspace_state.active_conversation_id,
          MAX(conversations.updated_at) AS updated_at,
          COUNT(conversations.id) AS session_count,
          COALESCE(SUM(CASE WHEN conversations.archived = 1 THEN 1 ELSE 0 END), 0) AS archived_session_count
        FROM workspaces
        LEFT JOIN conversations ON conversations.workspace = workspaces.path
        LEFT JOIN workspace_state ON workspace_state.workspace = workspaces.path
        GROUP BY workspaces.path, workspaces.granted_at, workspace_state.active_conversation_id
        ORDER BY workspaces.granted_at
      `)
      .all() as WorkspaceMetadataRow[];
    return rows.map((row) => ({
      path: row.path,
      name: path.basename(row.path) || row.path,
      activeConversationId: row.active_conversation_id,
      sessionCount: row.session_count,
      archivedSessionCount: row.archived_session_count,
      grantedAt: row.granted_at,
      updatedAt: row.updated_at,
    }));
  }

  ensureConversation(workspace: string, title: string, conversationId?: string, options: ConversationOptions = {}): string {
    if (conversationId) {
      const existing = this.db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId);
      if (existing && (options.providerProfileId !== undefined || options.model !== undefined)) {
        this.setConversationProvider(conversationId, options);
      }
      if (existing) return conversationId;
    }

    const id = conversationId ?? randomUUID();
    this.db
      .prepare("INSERT INTO conversations (id, workspace, title, provider_profile_id, model) VALUES (?, ?, ?, ?, ?)")
      .run(
        id,
        path.resolve(workspace),
        title.slice(0, 120) || "New task",
        options.providerProfileId ?? null,
        normalizeOptionalText(options.model, 120),
      );
    this.setActiveConversation(workspace, id);
    return id;
  }

  addMessage(conversationId: string, role: "user" | "assistant", content: string) {
    const transaction = this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)")
        .run(conversationId, role, content);
      this.db
        .prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?")
        .run(conversationId);
    });
    transaction();
  }

  latestConversation(workspace: string): StoredConversation | null {
    const row = this.db
      .prepare("SELECT id, workspace, title, archived, provider_profile_id, model, updated_at FROM conversations WHERE workspace = ? AND archived = 0 ORDER BY updated_at DESC, rowid DESC LIMIT 1")
      .get(path.resolve(workspace)) as ConversationRow | undefined;
    return row ? this.hydrateConversation(row) : null;
  }

  listConversations(workspace?: unknown, options: { includeArchived?: boolean } = {}): StoredConversation[] {
    const hasWorkspace = typeof workspace === "string" && workspace.trim().length > 0;
    const archiveFilter = options.includeArchived ? "" : " AND archived = 0";
    const rows = hasWorkspace
      ? this.db
        .prepare(`SELECT id, workspace, title, archived, provider_profile_id, model, updated_at FROM conversations WHERE workspace = ?${archiveFilter} ORDER BY updated_at DESC, rowid DESC`)
        .all(path.resolve(workspace)) as ConversationRow[]
      : this.db
        .prepare(`SELECT id, workspace, title, archived, provider_profile_id, model, updated_at FROM conversations WHERE 1 = 1${archiveFilter} ORDER BY updated_at DESC, rowid DESC`)
        .all() as ConversationRow[];
    return rows.map((row) => this.hydrateConversation(row));
  }

  getConversation(id: string): StoredConversation | null {
    const row = this.db
      .prepare("SELECT id, workspace, title, archived, provider_profile_id, model, updated_at FROM conversations WHERE id = ?")
      .get(id) as ConversationRow | undefined;
    return row ? this.hydrateConversation(row) : null;
  }

  setConversationProvider(id: string, options: ConversationOptions): StoredConversation | null {
    const current = this.getConversation(id);
    if (!current) return null;
    const providerProfileId = options.providerProfileId !== undefined
      ? options.providerProfileId
      : current.providerProfileId;
    const model = options.model !== undefined
      ? normalizeOptionalText(options.model, 120)
      : current.model;
    const result = this.db
      .prepare("UPDATE conversations SET provider_profile_id = ?, model = ?, updated_at = datetime('now') WHERE id = ?")
      .run(providerProfileId ?? null, model, id);
    return result.changes > 0 ? this.getConversation(id) : null;
  }

  renameConversation(id: string, title: string): StoredConversation | null {
    const trimmed = title.trim().slice(0, 120);
    if (!trimmed) throw new Error("Title is required");
    const result = this.db
      .prepare("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?")
      .run(trimmed, id);
    return result.changes > 0 ? this.getConversation(id) : null;
  }

  archiveConversation(id: string, archived: boolean): StoredConversation | null {
    const transaction = this.db.transaction(() => {
      const result = this.db
        .prepare("UPDATE conversations SET archived = ?, updated_at = datetime('now') WHERE id = ?")
        .run(archived ? 1 : 0, id);
      if (archived) {
        this.db
          .prepare("UPDATE workspace_state SET active_conversation_id = NULL, updated_at = datetime('now') WHERE active_conversation_id = ?")
          .run(id);
      }
      return result;
    });
    const result = transaction();
    return result.changes > 0 ? this.getConversation(id) : null;
  }

  deleteConversation(id: string): boolean {
    const transaction = this.db.transaction(() => {
      this.db.prepare("UPDATE workspace_state SET active_conversation_id = NULL, updated_at = datetime('now') WHERE active_conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM conversation_events WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM tasks WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
      return this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id).changes > 0;
    });
    return transaction();
  }

  addEvent(conversationId: string, event: Record<string, unknown>) {
    const kind = typeof event.kind === "string" ? event.kind : "event";
    const runId = typeof event.runId === "string" ? event.runId : null;
    this.db
      .prepare("INSERT INTO conversation_events (conversation_id, run_id, kind, payload) VALUES (?, ?, ?, ?)")
      .run(conversationId, runId, kind, JSON.stringify(event));
  }

  listEvents(conversationId: string, options: { afterId?: number } = {}): StoredEvent[] {
    const afterId = Number.isFinite(options.afterId) ? Number(options.afterId) : 0;
    const rows = this.db
      .prepare("SELECT id, conversation_id, run_id, kind, payload, created_at FROM conversation_events WHERE conversation_id = ? AND id > ? ORDER BY id")
      .all(conversationId, afterId) as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      runId: row.run_id ?? undefined,
      kind: row.kind,
      event: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  setActiveConversation(workspace: string, conversationId: string | null) {
    const absolute = path.resolve(workspace);
    if (conversationId) {
      const row = this.db
        .prepare("SELECT id FROM conversations WHERE id = ? AND workspace = ? AND archived = 0")
        .get(conversationId, absolute);
      if (!row) return false;
    }
    this.db
      .prepare(`
        INSERT INTO workspace_state (workspace, active_conversation_id, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(workspace) DO UPDATE SET
          active_conversation_id = excluded.active_conversation_id,
          updated_at = excluded.updated_at
      `)
      .run(absolute, conversationId);
    return true;
  }

  getActiveConversation(workspace: string): StoredConversation | null {
    const absolute = path.resolve(workspace);
    const row = this.db
      .prepare("SELECT active_conversation_id FROM workspace_state WHERE workspace = ?")
      .get(absolute) as { active_conversation_id: string | null } | undefined;
    if (!row?.active_conversation_id) return this.latestConversation(absolute);
    const conversation = this.getConversation(row.active_conversation_id);
    if (!conversation || conversation.archived) return this.latestConversation(absolute);
    return conversation;
  }

  listProviderProfiles(): StoredProviderProfile[] {
    const rows = this.db
      .prepare("SELECT id, type, name, model, base_url, api_key, enabled, is_default, created_at, updated_at FROM provider_profiles ORDER BY is_default DESC, updated_at DESC, rowid DESC")
      .all() as ProviderProfileRow[];
    return rows.map((row) => this.hydrateProviderProfile(row));
  }

  getProviderProfile(id: string): StoredProviderProfile | null {
    const row = this.getProviderProfileRow(id);
    return row ? this.hydrateProviderProfile(row) : null;
  }

  getProviderProfileWithSecret(id: string): ProviderProfileSecret | null {
    const row = this.getProviderProfileRow(id);
    return row ? this.hydrateProviderProfile(row, true) : null;
  }

  getDefaultProviderProfile(): StoredProviderProfile | null {
    const row = this.db
      .prepare("SELECT id, type, name, model, base_url, api_key, enabled, is_default, created_at, updated_at FROM provider_profiles WHERE is_default = 1 LIMIT 1")
      .get() as ProviderProfileRow | undefined;
    return row ? this.hydrateProviderProfile(row) : null;
  }

  getDefaultProviderProfileWithSecret(): ProviderProfileSecret | null {
    const row = this.db
      .prepare("SELECT id, type, name, model, base_url, api_key, enabled, is_default, created_at, updated_at FROM provider_profiles WHERE is_default = 1 LIMIT 1")
      .get() as ProviderProfileRow | undefined;
    return row ? this.hydrateProviderProfile(row, true) : null;
  }

  createProviderProfile(input: ProviderProfileInput): StoredProviderProfile {
    const normalized = normalizeProviderProfile(input);
    const id = randomUUID();
    const shouldDefault = Boolean(normalized.isDefault) || this.listProviderProfiles().length === 0;
    const transaction = this.db.transaction(() => {
      if (shouldDefault) this.clearDefaultProvider();
      this.db
        .prepare(`
          INSERT INTO provider_profiles (id, type, name, model, base_url, api_key, enabled, is_default)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          normalized.type,
          normalized.name,
          normalized.model,
          normalized.baseUrl ?? null,
          normalized.apiKey ?? null,
          normalized.enabled ? 1 : 0,
          shouldDefault ? 1 : 0,
        );
    });
    transaction();
    return this.getProviderProfile(id)!;
  }

  updateProviderProfile(id: string, input: ProviderProfileUpdate): StoredProviderProfile | null {
    const existing = this.getProviderProfileWithSecret(id);
    if (!existing) return null;
    const merged = normalizeProviderProfile({
      type: input.type ?? existing.type,
      name: input.name ?? existing.name,
      model: input.model ?? existing.model,
      baseUrl: "baseUrl" in input ? input.baseUrl : existing.baseUrl,
      apiKey: "apiKey" in input ? input.apiKey : existing.apiKey,
      enabled: input.enabled ?? existing.enabled,
      isDefault: input.isDefault ?? existing.isDefault,
    });
    const transaction = this.db.transaction(() => {
      if (merged.isDefault) this.clearDefaultProvider();
      this.db
        .prepare(`
          UPDATE provider_profiles
          SET type = ?, name = ?, model = ?, base_url = ?, api_key = ?, enabled = ?, is_default = ?, updated_at = datetime('now')
          WHERE id = ?
        `)
        .run(
          merged.type,
          merged.name,
          merged.model,
          merged.baseUrl ?? null,
          merged.apiKey ?? null,
          merged.enabled ? 1 : 0,
          merged.isDefault ? 1 : 0,
          id,
        );
    });
    transaction();
    return this.getProviderProfile(id);
  }

  deleteProviderProfile(id: string): boolean {
    const existing = this.getProviderProfile(id);
    if (!existing) return false;
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM provider_profiles WHERE id = ?").run(id);
      if (existing.isDefault) {
        const next = this.db
          .prepare("SELECT id FROM provider_profiles WHERE enabled = 1 ORDER BY updated_at DESC, rowid DESC LIMIT 1")
          .get() as { id: string } | undefined;
        if (next) this.db.prepare("UPDATE provider_profiles SET is_default = 1, updated_at = datetime('now') WHERE id = ?").run(next.id);
      }
    });
    transaction();
    return true;
  }

  setDefaultProviderProfile(id: string): StoredProviderProfile | null {
    const existing = this.getProviderProfile(id);
    if (!existing) return null;
    const transaction = this.db.transaction(() => {
      this.clearDefaultProvider();
      this.db.prepare("UPDATE provider_profiles SET is_default = 1, enabled = 1, updated_at = datetime('now') WHERE id = ?").run(id);
    });
    transaction();
    return this.getProviderProfile(id);
  }

  private getProviderProfileRow(id: string): ProviderProfileRow | undefined {
    return this.db
      .prepare("SELECT id, type, name, model, base_url, api_key, enabled, is_default, created_at, updated_at FROM provider_profiles WHERE id = ?")
      .get(id) as ProviderProfileRow | undefined;
  }

  private clearDefaultProvider() {
    this.db.prepare("UPDATE provider_profiles SET is_default = 0 WHERE is_default = 1").run();
  }

  private hydrateProviderProfile(row: ProviderProfileRow, includeSecret: true): ProviderProfileSecret;
  private hydrateProviderProfile(row: ProviderProfileRow, includeSecret?: false): StoredProviderProfile;
  private hydrateProviderProfile(row: ProviderProfileRow, includeSecret = false): StoredProviderProfile | ProviderProfileSecret {
    const profile = {
      id: row.id,
      type: row.type,
      name: row.name,
      model: row.model,
      baseUrl: row.base_url,
      hasApiKey: Boolean(row.api_key),
      enabled: Boolean(row.enabled),
      isDefault: Boolean(row.is_default),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    return includeSecret ? { ...profile, apiKey: row.api_key } : profile;
  }

  private hydrateConversation(row: ConversationRow): StoredConversation {
    const messages = this.db
      .prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id")
      .all(row.id) as Array<{ role: "user" | "assistant"; content: string }>;
    return {
      id: row.id,
      workspace: row.workspace,
      title: row.title,
      messages,
      archived: Boolean(row.archived),
      providerProfileId: row.provider_profile_id,
      model: row.model,
      updatedAt: row.updated_at,
    };
  }

  startTask(runId: string, conversationId: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO tasks (run_id, conversation_id, status, started_at, completed_at, error) VALUES (?, ?, 'running', datetime('now'), NULL, NULL)")
      .run(runId, conversationId);
  }

  finishTask(runId: string, status: "done" | "failed" | "cancelled", error?: string) {
    this.db
      .prepare("UPDATE tasks SET status = ?, error = ?, completed_at = datetime('now') WHERE run_id = ?")
      .run(status, error ?? null, runId);
  }

  close() {
    this.db.close();
  }
}

type ConversationRow = {
  id: string;
  workspace: string;
  title: string;
  archived: number;
  provider_profile_id: string | null;
  model: string | null;
  updated_at: string;
};

type EventRow = {
  id: number;
  conversation_id: string;
  run_id: string | null;
  kind: string;
  payload: string;
  created_at: string;
};

type WorkspaceMetadataRow = {
  path: string;
  granted_at: string;
  active_conversation_id: string | null;
  updated_at: string | null;
  session_count: number;
  archived_session_count: number;
};

type ProviderProfileRow = {
  id: string;
  type: ProviderType;
  name: string;
  model: string;
  base_url: string | null;
  api_key: string | null;
  enabled: number;
  is_default: number;
  created_at: string;
  updated_at: string;
};

function normalizeProviderProfile(input: ProviderProfileInput): Required<ProviderProfileInput> {
  if (!isProviderType(input.type)) throw new Error("Unsupported provider type");
  const name = input.name.trim().slice(0, 80);
  const model = input.model.trim().slice(0, 120);
  if (!name) throw new Error("Provider name is required");
  if (!model) throw new Error("Provider model is required");
  const baseUrl = input.baseUrl === undefined || input.baseUrl === null
    ? null
    : input.baseUrl.trim().slice(0, 300) || null;
  const apiKey = input.apiKey === undefined || input.apiKey === null
    ? null
    : input.apiKey.trim() || null;
  return {
    type: input.type,
    name,
    model,
    baseUrl,
    apiKey,
    enabled: input.enabled ?? true,
    isDefault: input.isDefault ?? false,
  };
}

function isProviderType(value: string): value is ProviderType {
  return value === "claude" || value === "openai-compatible" || value === "ollama" || value === "mock";
}

function normalizeOptionalText(value: string | null | undefined, maxLength: number) {
  if (value === undefined || value === null) return null;
  return value.trim().slice(0, maxLength) || null;
}
