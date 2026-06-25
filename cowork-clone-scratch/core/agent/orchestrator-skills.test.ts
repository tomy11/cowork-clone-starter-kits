import { describe, expect, it } from "vitest";
import type { ChatOptions, ChatResponse, ChatWithToolsOptions, LLMProvider } from "../llm/provider.js";
import { AuditLog } from "../permissions/audit.js";
import { PermissionACL } from "../permissions/acl.js";
import type { Skill } from "../skills/loader.js";
import { Orchestrator, type OrchestratorEvent } from "./orchestrator.js";
import { ToolRegistry } from "./tools/registry.js";

class PlanningProvider implements LLMProvider {
  readonly name = "test";
  private chatRound = 0;

  async chat(_options: ChatOptions) {
    this.chatRound++;
    return this.chatRound === 1
      ? JSON.stringify({ steps: [{ id: "s1", task: "test it", dependsOn: [], skills: ["test-skill"] }] })
      : "final answer";
  }

  async chatWithTools(_options: ChatWithToolsOptions): Promise<ChatResponse> {
    return { text: "agent result", toolUses: [] };
  }
}

describe("Orchestrator skills", () => {
  it("loads planner-selected skills and reports activation", async () => {
    const audit = new AuditLog(":memory:");
    const orchestrator = new Orchestrator({
      llm: new PlanningProvider(),
      acl: new PermissionACL(),
      audit,
      tools: new ToolRegistry(),
    });
    const streamed: OrchestratorEvent[] = [];
    const skill: Skill = {
      name: "test-skill",
      description: "Testing workflow",
      path: "/skills/test-skill",
      raw: {},
      instructions: "Always verify the result.",
      resources: [],
    };

    for await (const event of orchestrator.run("test this", [], {
      availableSkills: [skill],
      loadSkill: async () => skill,
      onEvent: (event) => streamed.push(event),
    })) streamed.push(event);

    expect(streamed).toContainEqual({ kind: "skill_activated", id: "s1", skill: "test-skill" });
    expect(streamed.some((event) => event.kind === "subagent_done")).toBe(true);
    expect(streamed.at(-1)).toEqual({ kind: "final", content: "final answer" });
    audit.close();
  });
});
