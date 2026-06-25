/**
 * Permission ACL
 *
 * กำหนดสิทธิ์การเข้าถึง folder + tool ในระดับ granular
 * รองรับ 3 states: allow / deny / require_confirm
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { realpath } from "node:fs/promises";

export type PermissionRule = {
  pattern: string; // glob pattern สำหรับ path
  read?: "allow" | "deny" | "confirm";
  write?: "allow" | "deny" | "confirm";
  delete?: "allow" | "deny" | "confirm";
};

export type PermissionDecision = {
  allowed: boolean;
  requiresConfirm: boolean;
  reason?: string;
  confirmPrompt?: string;
};

export type PermissionCheckInput = {
  path: string;
  operation: "read" | "write" | "delete";
};

export class PermissionACL {
  private rules: PermissionRule[] = [];
  private grantedFolders: string[] = [];

  /**
   * Grant การเข้าถึง folder + ใส่ default rule
   */
  grantFolder(folder: string, defaults: Partial<PermissionRule> = {}) {
    const abs = this.canonicalizeGrantedFolder(folder);
    if (!this.grantedFolders.includes(abs)) this.grantedFolders.push(abs);
    this.rules.push({
      pattern: abs + "/**",
      read: "allow",
      write: "confirm", // default: write ต้อง confirm
      delete: "confirm", // default: delete ต้อง confirm
      ...defaults,
    });
  }

  revokeFolder(folder: string) {
    const abs = this.canonicalizeGrantedFolder(folder);
    this.grantedFolders = this.grantedFolders.filter((f) => f !== abs);
    this.rules = this.rules.filter((r) => !r.pattern.startsWith(abs));
  }

  /**
   * Check permission สำหรับ file operation
   */
  async check(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    // แยก tool ตาม operation
    const operation = this.inferOperation(toolName, args);
    if (!operation) {
      // tool ที่ไม่เกี่ยว file system → allow (ขึ้นกับ rule)
      return { allowed: true, requiresConfirm: false };
    }

    const targetPath = String(args.path ?? args.file_path ?? args.filepath ?? "");
    if (!targetPath) {
      return { allowed: false, requiresConfirm: false, reason: "No path provided" };
    }

    let abs: string;
    try {
      abs = await this.canonicalizeTarget(targetPath);
    } catch (error) {
      return {
        allowed: false,
        requiresConfirm: false,
        reason: `Unable to resolve path safely: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // 1. ตรวจว่าอยู่ใน granted folder ไหม
    const inGranted = this.grantedFolders.some((folder) => {
      const relative = path.relative(folder, abs);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
    if (!inGranted) {
      return {
        allowed: false,
        requiresConfirm: false,
        reason: `Path "${abs}" is not in any granted folder. Grant folder access first.`,
      };
    }

    // 2. หา rule ที่ match
    const rule = this.rules.find((r) => this.matchPath(abs, r.pattern));
    if (!rule) {
      return {
        allowed: false,
        requiresConfirm: false,
        reason: "No matching rule for this path",
      };
    }

    const decision = rule[operation] ?? "deny";

    if (decision === "deny") {
      return {
        allowed: false,
        requiresConfirm: false,
        reason: `Rule denies ${operation} on ${abs}`,
      };
    }

    if (decision === "confirm") {
      return {
        allowed: true,
        requiresConfirm: true,
        reason: `User confirmation required for ${operation}`,
        confirmPrompt: `Allow ${operation} on ${abs}?`,
      };
    }

    return { allowed: true, requiresConfirm: false };
  }

  private inferOperation(
    toolName: string,
    args: Record<string, unknown>,
  ): "read" | "write" | "delete" | null {
    if (/(read|cat|view|list|find|search)/i.test(toolName)) return "read";
    if (/(write|edit|create|move|rename|copy)/i.test(toolName)) return "write";
    if (/(delete|remove|rm)/i.test(toolName)) return "delete";
    // fallback: ดูจาก args
    if (args.operation) {
      return args.operation as any;
    }
    return null;
  }

  private matchPath(target: string, pattern: string): boolean {
    // Simple glob: pattern ลงท้าย /** = recursive
    if (pattern.endsWith("/**")) {
      const base = pattern.slice(0, -3);
      const relative = path.relative(base, target);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    }
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return target.startsWith(prefix);
    }
    return target === pattern;
  }

  private canonicalizeGrantedFolder(folder: string) {
    const absolute = path.resolve(folder);
    let candidate = absolute;
    const missingSegments: string[] = [];
    while (true) {
      try {
        return path.resolve(fs.realpathSync.native(candidate), ...missingSegments);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return absolute;
        const parent = path.dirname(candidate);
        if (parent === candidate) return absolute;
        missingSegments.unshift(path.basename(candidate));
        candidate = parent;
      }
    }
  }

  private async canonicalizeTarget(target: string) {
    const absolute = path.resolve(target);
    let candidate = absolute;
    const missingSegments: string[] = [];

    while (true) {
      try {
        const resolved = await realpath(candidate);
        return path.resolve(resolved, ...missingSegments);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(candidate);
        if (parent === candidate) return absolute;
        missingSegments.unshift(path.basename(candidate));
        candidate = parent;
      }
    }
  }

  listGrantedFolders(): string[] {
    return [...this.grantedFolders];
  }

  listRules(): PermissionRule[] {
    return [...this.rules];
  }
}
