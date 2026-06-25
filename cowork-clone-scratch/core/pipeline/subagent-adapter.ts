import { SubAgent, type ConfirmationRequest } from "../agent/subagent.js";
import type { ToolRegistry } from "../agent/tools/registry.js";
import type { LLMProvider, Message } from "../llm/provider.js";
import type { AuditLog } from "../permissions/audit.js";
import type { PermissionACL } from "../permissions/acl.js";
import type { Skill } from "../skills/loader.js";
import type { PipelineAgent } from "./types.js";

export type SubAgentPipelineConfig = {
  id: string;
  role: string;
  description: string;
  llm: LLMProvider;
  acl: PermissionACL;
  audit: AuditLog;
  tools: ToolRegistry;
  history?: Message[];
  systemPrompt?: string;
  loadSkill?: (name: string) => Promise<Skill>;
  requestConfirmation?: (request: ConfirmationRequest) => Promise<boolean>;
};

export function createSubAgentPipelineAgent(config: SubAgentPipelineConfig): PipelineAgent {
  return {
    id: config.id,
    role: config.role,
    description: config.description,
    async run(input, emit) {
      const skills = await loadSkillInstructions(input.step.skills ?? [], config.loadSkill);
      const previous = input.previousResults
        .map((result) => `[${result.stepId}] ${result.status}: ${result.output || result.error}`)
        .join("\n\n");
      const agent = new SubAgent({
        llm: config.llm,
        acl: config.acl,
        audit: config.audit,
        tools: config.tools,
        systemPrompt: config.systemPrompt,
        signal: input.signal,
        requestConfirmation: config.requestConfirmation,
      });

      let finalOutput = "";
      let success = false;
      let error = "";
      for await (const event of agent.run({
        id: input.step.id,
        instruction: input.step.instruction,
        context: [
          `Pipeline objective: ${input.objective}`,
          previous ? `Previous step results:\n${previous}` : "",
        ].filter(Boolean).join("\n\n"),
        skillInstructions: skills,
      }, config.history ?? [])) {
        if (event.kind === "content") emit({ kind: "agent_progress", content: event.content });
        if (event.kind === "tool_call") emit({ kind: "agent_tool_call", name: event.name, args: event.args });
        if (event.kind === "tool_result") emit({ kind: "agent_tool_result", name: event.name, result: event.result });
        if (event.kind === "error") error = event.message;
        if (event.kind === "done") {
          success = event.result.success;
          finalOutput = event.result.output;
          error = event.result.error ?? error;
        }
      }

      return {
        success,
        output: finalOutput,
        error: success ? undefined : error || "Sub-agent did not complete successfully",
      };
    },
  };
}

async function loadSkillInstructions(names: string[], loadSkill?: (name: string) => Promise<Skill>) {
  if (!loadSkill || names.length === 0) return "";
  const skills = await Promise.all(names.map((name) => loadSkill(name)));
  return skills.map((skill) => `# ${skill.name}\n${skill.instructions}`).join("\n\n");
}
