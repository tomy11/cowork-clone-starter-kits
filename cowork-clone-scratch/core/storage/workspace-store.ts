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
      .prepare("SELECT id, workspace, title, updated_at FROM conversations WHERE workspace = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1")
      .get(path.resolve(workspace)) as { id: string; workspace: string; title: string; updated_at: string } | undefined;
    return row ? this.hydrateConversation(row) : null;
  }

  getConversation(id: string): StoredConversation | null {
    const row = this.db
      .prepare("SELECT id, workspace, title, updated_at FROM conversations WHERE id = ?")
      .get(id) as { id: string; workspace: string; title: string; updated_at: string } | undefined;
    return row ? this.hydrateConversation(row) : null;
  }

  private hydrateConversation(row: { id: string; workspace: string; title: string; updated_at: string }): StoredConversation {
    const messages = this.db
      .prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id")
      .all(row.id) as Array<{ role: "user" | "assistant"; content: string }>;
    return {
      id: row.id,
      workspace: row.workspace,
      title: row.title,
      messages,
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
