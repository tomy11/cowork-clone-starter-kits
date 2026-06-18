/**
 * Audit Log
 *
 * บันทึกการ action ทุกอย่าง — ใช้ดูย้อนหลัง + debug
 */

import Database from "better-sqlite3";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

export type AuditEntry = {
  agentId: string;
  tool: string;
  args: unknown;
  decision: "allowed" | "denied" | "pending_confirm" | "error";
  reason?: string;
};

export class AuditLog {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const p =
      dbPath ?? path.join(os.homedir(), ".cowork-clone", "audit.db");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    this.db = new Database(p);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT DEFAULT (datetime('now')),
        agent_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        args TEXT,
        decision TEXT NOT NULL,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
      CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit(agent_id);
    `);
  }

  log(entry: AuditEntry) {
    this.db
      .prepare(
        `INSERT INTO audit (agent_id, tool, args, decision, reason) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.agentId,
        entry.tool,
        JSON.stringify(entry.args ?? {}),
        entry.decision,
        entry.reason ?? null,
      );
  }

  recent(limit = 100): AuditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM audit ORDER BY id DESC LIMIT ?`)
      .all(limit) as any[];
    return rows.map((r) => ({
      agentId: r.agent_id,
      tool: r.tool,
      args: JSON.parse(r.args ?? "{}"),
      decision: r.decision,
      reason: r.reason,
    }));
  }

  close() {
    this.db.close();
  }
}
