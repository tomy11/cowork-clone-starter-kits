/**
 * Shell Execution Tool
 *
 * run_command — รัน shell command ใน workspace directory
 * ต้อง require confirmation จาก user เสมอ (destructive)
 */

import { execFile } from "node:child_process";
import type { ToolImpl } from "./registry.js";

const runCommand: ToolImpl = {
  name: "run_command",
  description:
    "รัน shell command หรือ Python script ใน workspace directory โดยตรง " +
    "ใช้สำหรับ: สร้างไฟล์ PDF, รัน Python/Node script, ติดตั้ง dependency, รัน test " +
    "command จะรันใน cwd ของ workspace — ต้องขอ confirm จาก user ก่อนทุกครั้ง",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "คำสั่งที่จะรัน เช่น 'python3 -c \"...\"' หรือ 'python3 script.py'",
      },
      cwd: {
        type: "string",
        description: "Working directory (absolute path) — ถ้าไม่ระบุใช้ workspace root",
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
    const cwd = args.cwd ? String(args.cwd) : undefined;
    const timeoutMs = Math.min(Number(args.timeout ?? 30), 120) * 1000;

    // ACL check on cwd if provided
    if (cwd) {
      const decision = await ctx.acl.check("run_command", { path: cwd, operation: "execute" });
      if (!decision.allowed) throw new Error(decision.reason ?? "Permission denied");
    }

    return new Promise<string>((resolve, reject) => {
      // Use sh -c to support pipes, env vars, etc.
      execFile(
        "/bin/sh",
        ["-c", command],
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024, // 2MB output cap
          env: { ...process.env },
        },
        (error, stdout, stderr) => {
          if (error && error.killed) {
            reject(new Error(`Command timed out after ${timeoutMs / 1000}s`));
            return;
          }
          const output = [stdout, stderr].filter(Boolean).join("\n").trim();
          if (error) {
            reject(new Error(`Command failed (exit ${error.code ?? "?"}): ${output || error.message}`));
            return;
          }
          resolve(output || "(no output)");
        },
      );
    });
  },
};

export const builtInShellTools: ToolImpl[] = [runCommand];
