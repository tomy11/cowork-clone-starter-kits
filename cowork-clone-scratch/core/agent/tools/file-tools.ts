/**
 * Built-in File Tools
 *
 * read / write / list / move / delete — ทุก tool เช็ค ACL ผ่าน ctx.acl
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolImpl } from "./registry.js";

// ---------- read_file ----------
const readFile: ToolImpl = {
  name: "read_file",
  description: "อ่านเนื้อหาไฟล์ text. ใช้สำหรับไฟล์ที่อ่านง่าย เช่น .txt, .md, .json, .ts, .js",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to file" },
      max_lines: { type: "number", description: "Optional cap on lines" },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const target = String(args.path);
    const decision = await ctx.acl.check("read_file", { path: target, operation: "read" });
    if (!decision.allowed) throw new Error(decision.reason);

    const content = await fs.readFile(target, "utf-8");
    if (args.max_lines) {
      const lines = content.split("\n").slice(0, Number(args.max_lines));
      return lines.join("\n") + `\n... (truncated at ${args.max_lines} lines)`;
    }
    return content;
  },
};

// ---------- write_file ----------
const writeFile: ToolImpl = {
  name: "write_file",
  description: "เขียนไฟล์ใหม่หรือเขียนทับ (จะ require confirm จาก user)",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx) {
    const target = String(args.path);
    const decision = await ctx.acl.check("write_file", { path: target, operation: "write" });
    if (!decision.allowed) throw new Error(decision.reason);
    if (decision.requiresConfirm) {
      throw new Error(`CONFIRM_REQUIRED: ${decision.confirmPrompt}`);
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, String(args.content), "utf-8");
    return `Wrote ${target} (${String(args.content).length} bytes)`;
  },
};

// ---------- list_directory ----------
const listDir: ToolImpl = {
  name: "list_directory",
  description: "List ไฟล์ + folder ใน directory",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      recursive: { type: "boolean", default: false },
      max_depth: { type: "number", default: 3 },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const target = String(args.path);
    const decision = await ctx.acl.check("list_directory", { path: target, operation: "read" });
    if (!decision.allowed) throw new Error(decision.reason);

    const recursive = Boolean(args.recursive);
    const maxDepth = Number(args.max_depth ?? 3);

    async function walk(dir: string, depth: number): Promise<string[]> {
      if (depth > maxDepth) return [];
      const out: string[] = [];
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          out.push(`[D] ${full}`);
          if (recursive) out.push(...(await walk(full, depth + 1)));
        } else {
          out.push(`[F] ${full}`);
        }
      }
      return out;
    }

    const result = await walk(target, 0);
    return result.slice(0, 500).join("\n") + (result.length > 500 ? `\n... (${result.length - 500} more)` : "");
  },
};

// ---------- move_file ----------
const moveFile: ToolImpl = {
  name: "move_file",
  description: "ย้ายหรือเปลี่ยนชื่อไฟล์ (require confirm)",
  input_schema: {
    type: "object",
    properties: {
      from: { type: "string" },
      to: { type: "string" },
    },
    required: ["from", "to"],
  },
  async execute(args, ctx) {
    const from = String(args.from);
    const to = String(args.to);
    const decFrom = await ctx.acl.check("move_file", { path: from, operation: "write" });
    if (!decFrom.allowed) throw new Error(`Source: ${decFrom.reason}`);
    if (decFrom.requiresConfirm) throw new Error(`CONFIRM_REQUIRED: Move from ${from}?`);

    const decTo = await ctx.acl.check("move_file", { path: to, operation: "write" });
    if (!decTo.allowed) throw new Error(`Destination: ${decTo.reason}`);
    if (decTo.requiresConfirm) throw new Error(`CONFIRM_REQUIRED: Move to ${to}?`);

    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    return `Moved ${from} → ${to}`;
  },
};

// ---------- delete_file ----------
const deleteFile: ToolImpl = {
  name: "delete_file",
  description: "ลบไฟล์ (DESTRUCTIVE — require confirm)",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const target = String(args.path);
    const decision = await ctx.acl.check("delete_file", { path: target, operation: "delete" });
    if (!decision.allowed) throw new Error(decision.reason);
    if (decision.requiresConfirm) {
      throw new Error(`CONFIRM_REQUIRED: Delete ${target}? This is destructive.`);
    }

    await fs.unlink(target);
    return `Deleted ${target}`;
  },
};

// ---------- search_files ----------
const searchFiles: ToolImpl = {
  name: "search_files",
  description: "ค้นหาไฟล์ที่มี name ตรงกับ pattern (glob) ใน folder",
  input_schema: {
    type: "object",
    properties: {
      folder: { type: "string" },
      pattern: { type: "string", description: "Substring หรือ glob เช่น '*.pdf'" },
    },
    required: ["folder", "pattern"],
  },
  async execute(args, ctx) {
    const folder = String(args.folder);
    const pattern = String(args.pattern);
    const decision = await ctx.acl.check("search_files", { path: folder, operation: "read" });
    if (!decision.allowed) throw new Error(decision.reason);

    const re = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
      "i",
    );

    const matches: string[] = [];
    async function walk(dir: string, depth: number) {
      if (depth > 5) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (re.test(e.name)) matches.push(full);
        if (e.isDirectory()) await walk(full, depth + 1);
      }
    }
    await walk(folder, 0);
    return matches.slice(0, 200).join("\n") || "(no matches)";
  },
};

export const builtInFileTools: ToolImpl[] = [
  readFile,
  writeFile,
  listDir,
  moveFile,
  deleteFile,
  searchFiles,
];
