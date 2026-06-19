/**
 * Main entry — assemble everything
 *
 * Run as: tsx core/index.ts
 *
 * This is the sidecar that Tauri/Rust shell spawns to do all the actual work.
 * Communication is via stdio JSON-RPC.
 */

import { Orchestrator } from "./agent/orchestrator.js";
import { ToolRegistry } from "./agent/tools/registry.js";
import { builtInFileTools } from "./agent/tools/file-tools.js";
import { PermissionACL } from "./permissions/acl.js";
import { AuditLog } from "./permissions/audit.js";
import { ClaudeProvider } from "./llm/claude.js";
import { OpenAICompatProvider } from "./llm/openai-compatible.js";
import { SkillsLoader } from "./skills/loader.js";
import * as path from "node:path";

// ---------- Setup ----------
const acl = new PermissionACL();
const audit = new AuditLog();
const tools = new ToolRegistry();
for (const t of builtInFileTools) tools.register(t);

const skills = new SkillsLoader(
  path.join(process.cwd(), "skills"),
);

// LLM provider — เลือกจาก env
const provider = process.env.LLM_PROVIDER ?? "claude";
let llm;
if (provider === "claude") {
  llm = new ClaudeProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5",
  });
} else {
  llm = new OpenAICompatProvider({
    apiKey: process.env.LLM_API_KEY!,
    baseURL: process.env.LLM_BASE_URL,
    model: process.env.LLM_MODEL ?? "gpt-4o",
  });
}

const orchestrator = new Orchestrator({ llm, acl, audit, tools });

// ---------- stdio JSON-RPC ----------
type RpcRequest = {
  id: string;
  method: string;
  params: any;
};

type RpcResponse = {
  id: string;
  result?: any;
  error?: { message: string; code?: number };
};

process.stdin.setEncoding("utf-8");
let buf = "";

process.stdin.on("data", async (chunk) => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const req: RpcRequest = JSON.parse(line);
      const resp = await handle(req);
      process.stdout.write(JSON.stringify(resp) + "\n");
    } catch (err) {
      const resp: RpcResponse = {
        id: "unknown",
        error: { message: err instanceof Error ? err.message : String(err) },
      };
      process.stdout.write(JSON.stringify(resp) + "\n");
    }
  }
});

async function handle(req: RpcRequest): Promise<RpcResponse> {
  try {
    switch (req.method) {
      case "grant_folder":
        acl.grantFolder(req.params.folder, req.params.defaults);
        return { id: req.id, result: { ok: true } };

      case "list_granted_folders":
        return { id: req.id, result: { folders: acl.listGrantedFolders() } };

      case "list_skills":
        return { id: req.id, result: { skills: await skills.list() } };

      case "load_skill":
        return { id: req.id, result: { skill: await skills.load(req.params.name) } };

      case "list_tools":
        return { id: req.id, result: { tools: tools.names() } };

      case "run": {
        const events: any[] = [];
        for await (const ev of orchestrator.run(req.params.message, req.params.history ?? [])) {
          events.push(ev);
          // stream event แต่ละ event ออกมาทันที
          process.stdout.write(
            JSON.stringify({ id: req.id, event: ev }) + "\n",
          );
        }
        return { id: req.id, result: { events } };
      }

      case "audit_recent":
        return { id: req.id, result: { entries: audit.recent(req.params.limit) } };

      case "ping":
        return { id: req.id, result: { pong: true, version: "0.1.0" } };

      default:
        return { id: req.id, error: { message: `Unknown method: ${req.method}`, code: 404 } };
    }
  } catch (err) {
    return { id: req.id, error: { message: err instanceof Error ? err.message : String(err) } };
  }
}
