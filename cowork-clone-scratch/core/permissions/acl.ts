/**
 * Permission ACL
 *
 * กำหนดสิทธิ์การเข้าถึง folder + tool ในระดับ granular
 * รองรับ 3 states: allow / deny / require_confirm
 */

import * as path from "node:path";

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
    const abs = path.resolve(folder);
    this.grantedFolders.push(abs);
    this.rules.push({
      pattern: abs + "/**",
      read: "allow",
      write: "confirm", // default: write ต้อง confirm
      delete: "confirm", // default: delete ต้อง confirm
      ...defaults,
    });
  }

  revokeFolder(folder: string) {
    const abs = path.resolve(folder);
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

    const abs = path.resolve(targetPath);

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
      return target.startsWith(base);
    }
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return target.startsWith(prefix);
    }
    return target === pattern;
  }

  listGrantedFolders(): string[] {
    return [...this.grantedFolders];
  }

  listRules(): PermissionRule[] {
    return [...this.rules];
  }
}
