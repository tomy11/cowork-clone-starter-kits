/**
 * Tool Registry
 *
 * เก็บ tools ทั้งหมดที่ agent ใช้ได้
 */

import type { Tool } from "../../llm/provider.js";
import type { PermissionACL } from "../../permissions/acl.js";

export type ToolContext = {
  agentId: string;
  acl: PermissionACL;
  confirmationApproved?: boolean;
  workspace?: string;
};

export type ToolImpl = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  requiresConfirmation?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
};

export class ToolRegistry {
  private tools = new Map<string, ToolImpl>();

  register(tool: ToolImpl) {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string) {
    this.tools.delete(name);
  }

  get(name: string): ToolImpl {
    const t = this.tools.get(name);
    if (!t) throw new Error(`Tool not found: ${name}`);
    return t;
  }

  list(): Tool[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}
