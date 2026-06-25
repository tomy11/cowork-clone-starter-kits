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
  updatedAt: string;
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
      CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace, updated_at);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
    `);
    this.ensureColumn("conversations", "archived", "INTEGER NOT NULL DEFAULT 0");
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

  ensureConversation(workspace: string, title: string, conversationId?: string): string {
    if (conversationId) {
      const existing = this.db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId);
      if (existing) return conversationId;
    }

    const id = conversationId ?? randomUUID();
    this.db
      .prepare("INSERT INTO conversations (id, workspace, title) VALUES (?, ?, ?)")
      .run(id, path.resolve(workspace), title.slice(0, 120) || "New task");
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
      .prepare("SELECT id, workspace, title, archived, updated_at FROM conversations WHERE workspace = ? AND archived = 0 ORDER BY updated_at DESC, rowid DESC LIMIT 1")
      .get(path.resolve(workspace)) as ConversationRow | undefined;
    return row ? this.hydrateConversation(row) : null;
  }

  listConversations(workspace?: unknown, options: { includeArchived?: boolean } = {}): StoredConversation[] {
    const hasWorkspace = typeof workspace === "string" && workspace.trim().length > 0;
    const archiveFilter = options.includeArchived ? "" : " AND archived = 0";
    const rows = hasWorkspace
      ? this.db
        .prepare(`SELECT id, workspace, title, archived, updated_at FROM conversations WHERE workspace = ?${archiveFilter} ORDER BY updated_at DESC, rowid DESC`)
        .all(path.resolve(workspace)) as ConversationRow[]
      : this.db
        .prepare(`SELECT id, workspace, title, archived, updated_at FROM conversations WHERE 1 = 1${archiveFilter} ORDER BY updated_at DESC, rowid DESC`)
        .all() as ConversationRow[];
    return rows.map((row) => this.hydrateConversation(row));
  }

  getConversation(id: string): StoredConversation | null {
    const row = this.db
      .prepare("SELECT id, workspace, title, archived, updated_at FROM conversations WHERE id = ?")
      .get(id) as ConversationRow | undefined;
    return row ? this.hydrateConversation(row) : null;
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
    const result = this.db
      .prepare("UPDATE conversations SET archived = ?, updated_at = datetime('now') WHERE id = ?")
      .run(archived ? 1 : 0, id);
    return result.changes > 0 ? this.getConversation(id) : null;
  }

  deleteConversation(id: string): boolean {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM tasks WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
      return this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id).changes > 0;
    });
    return transaction();
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
  updated_at: string;
};
