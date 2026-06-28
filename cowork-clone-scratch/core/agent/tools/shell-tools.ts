/**
 * Shell Execution Tool
 *
 * run_command — รัน shell command ใน Docker sandbox ที่ mount workspace เป็น /workspace
 * ต้อง require confirmation จาก user เสมอ (destructive)
 */

import * as path from "node:path";
import { runDockerSandbox } from "../../sandbox/docker-runner.js";
import type { ToolImpl } from "./registry.js";

const runCommand: ToolImpl = {
  name: "run_command",
  description:
    "รัน shell command หรือ Python script ใน Docker sandbox โดย mount workspace เป็น /workspace " +
    "ใช้สำหรับ: สร้างไฟล์ PDF, รัน Python/Node script, ติดตั้ง dependency, รัน test " +
    "ไฟล์ output ต้องเขียนใต้ /workspace เท่านั้น; temp files ให้ใช้ /tmp — ต้องขอ confirm จาก user ก่อนทุกครั้ง",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "คำสั่งที่จะรัน เช่น 'python3 -c \"...\"' หรือ 'python3 script.py'",
      },
      cwd: {
        type: "string",
        description: "Working directory ใน sandbox เช่น /workspace หรือ /workspace/reports — ถ้าไม่ระบุใช้ /workspace",
      },
      write: {
        type: "boolean",
        description: "ตั้งเป็น true เมื่อ command ต้องสร้างหรือแก้ไฟล์ใน /workspace (default false = read-only workspace)",
      },
      outputs: {
        type: "array",
        items: { type: "string" },
        description: "ไฟล์ output ที่คาดว่าจะสร้างใต้ /workspace เช่น ['report.pdf', '/workspace/reports/report.pdf']",
      },
      network: {
        type: "string",
        enum: ["none", "bridge"],
        description: "Docker network mode (default none)",
      },
      timeout: {
        type: "number",
        description: "Timeout เป็นวินาที (default 30, max 120)",
      },
    },
    required: ["command"],
  },
  requiresConfirmation: true,
  async execute(args, ctx) {
    if (!ctx.confirmationApproved) {
      throw new Error(`CONFIRM_REQUIRED: รัน command: ${String(args.command)}`);
    }

    const command = String(args.command);
    const workspace = ctx.workspace;
    if (!workspace) {
      throw new Error("Sandbox workspace is unavailable; refusing to run command on the host");
    }
    const write = Boolean(args.write);
    const cwd = containerWorkdir(args.cwd, workspace);
    const network = typeof args.network === "string" ? args.network : "none";
    if (!["none", "bridge"].includes(network)) {
      throw new Error("network must be one of: none, bridge");
    }
    const timeoutMs = Math.min(Number(args.timeout ?? 30), 120) * 1000;

    const decision = await ctx.acl.check("run_command", {
      path: workspace,
      operation: write ? "write" : "read",
    });
    if (!decision.allowed) throw new Error(decision.reason ?? "Permission denied");
    if (decision.requiresConfirm && !ctx.confirmationApproved) {
      throw new Error(`CONFIRM_REQUIRED: ${decision.confirmPrompt}`);
    }

    const result = await runDockerSandbox({
      workspace,
      command: ["sh", "-c", command],
      workdir: cwd,
      write,
      network,
      timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    return output || "(no output)";
  },
};

export const builtInShellTools: ToolImpl[] = [runCommand];

function containerWorkdir(value: unknown, workspace: string) {
  if (typeof value !== "string" || !value.trim()) return "/workspace";
  const raw = value.trim();
  if (raw === "/workspace" || raw.startsWith("/workspace/")) {
    const normalized = path.posix.normalize(raw);
    if (normalized === "/workspace" || normalized.startsWith("/workspace/")) return normalized;
  }
  if (!path.isAbsolute(raw)) {
    const normalized = path.posix.normalize(path.posix.join("/workspace", raw));
    if (normalized === "/workspace" || normalized.startsWith("/workspace/")) return normalized;
  }
  const relative = path.relative(path.resolve(workspace), path.resolve(raw));
  if (relative === "") return "/workspace";
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return path.posix.join("/workspace", relative.split(path.sep).join("/"));
  }
  throw new Error("cwd must be inside the workspace and will be mounted at /workspace in the sandbox");
}
