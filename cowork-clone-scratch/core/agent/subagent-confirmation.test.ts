import { describe, expect, it } from "vitest";
import type { ChatOptions, ChatResponse, ChatWithToolsOptions, LLMProvider } from "../llm/provider.js";
import { AuditLog } from "../permissions/audit.js";
import { PermissionACL } from "../permissions/acl.js";
import { ToolRegistry } from "./tools/registry.js";
import { SubAgent } from "./subagent.js";

class ToolCallingProvider implements LLMProvider {
  readonly name = "test";
  private round = 0;

  async chat(_options: ChatOptions) {
    return "done";
  }

  async chatWithTools(_options: ChatWithToolsOptions): Promise<ChatResponse> {
    this.round++;
    return this.round === 1
      ? { text: "", toolUses: [{ id: "tool-1", name: "write_file", input: { path: "/tmp/workspace/file.txt" } }] }
      : { text: "finished", toolUses: [] };
  }
}

describe("SubAgent confirmation", () => {
  it("pauses for confirmation and executes after approval", async () => {
    const acl = new PermissionACL();
    acl.grantFolder("/tmp/workspace");
    const audit = new AuditLog(":memory:");
    const tools = new ToolRegistry();
    let executed = false;
    let confirmationRequested = false;
    tools.register({
      name: "write_file",
      description: "test writer",
      input_schema: { type: "object" },
      async execute(_args, context) {
        executed = Boolean(context.confirmationApproved);
        return "written";
      },
    });

    const agent = new SubAgent({
      llm: new ToolCallingProvider(),
      acl,
      audit,
      tools,
      requestConfirmation: async () => {
        confirmationRequested = true;
        return true;
      },
    });
    const events = [];
    for await (const event of agent.run({ id: "s1", instruction: "write" })) events.push(event);

    expect(confirmationRequested).toBe(true);
    expect(executed).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "done", result: { success: true } });
    audit.close();
  });
});
