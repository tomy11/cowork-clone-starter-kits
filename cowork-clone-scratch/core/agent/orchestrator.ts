import { SubAgent, type ConfirmationRequest, type SubAgentResult } from "./subagent.js";
import type { LLMProvider, Message } from "../llm/provider.js";
import type { PermissionACL } from "../permissions/acl.js";
import type { AuditLog } from "../permissions/audit.js";
import type { Skill, SkillMetadata } from "../skills/loader.js";
import { ToolRegistry } from "./tools/registry.js";

export type OrchestratorConfig = {
  llm: LLMProvider;
  acl: PermissionACL;
  audit: AuditLog;
  tools: ToolRegistry;
  maxConcurrentSubagents?: number;
  systemPrompt?: string;
};

export type OrchestratorEvent =
  | { kind: "thinking"; content: string }
  | { kind: "plan"; steps: PlanStep[] }
  | { kind: "subagent_spawned"; id: string; task: string }
  | { kind: "subagent_progress"; id: string; content: string }
  | { kind: "subagent_done"; id: string; result: SubAgentResult }
  | { kind: "skill_activated"; id: string; skill: string }
  | { kind: "tool_call"; id: string; name: string; args: unknown }
  | { kind: "tool_result"; id: string; name: string; result: unknown }
  | { kind: "final"; content: string }
  | { kind: "error"; message: string };

export type PlanStep = {
  id: string;
  task: string;
  dependsOn: string[];
  skills: string[];
  status: "pending" | "running" | "done" | "failed";
};

export type RunOptions = {
  signal?: AbortSignal;
  availableSkills?: SkillMetadata[];
  loadSkill?: (name: string) => Promise<Skill>;
  requestConfirmation?: (request: ConfirmationRequest) => Promise<boolean>;
  onEvent?: (event: OrchestratorEvent) => void;
};

export class Orchestrator {
  private cfg: Required<OrchestratorConfig>;

  constructor(cfg: OrchestratorConfig) {
    this.cfg = {
      maxConcurrentSubagents: 4,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      ...cfg,
    };
  }

  async *run(
    userMessage: string,
    history: Message[] = [],
    options: RunOptions = {},
  ): AsyncGenerator<OrchestratorEvent> {
    try {
      this.throwIfAborted(options.signal);
      yield { kind: "thinking", content: "Analyzing task..." };

      const plan = await this.plan(userMessage, history, options.availableSkills ?? [], options.signal);
      this.throwIfAborted(options.signal);
      yield { kind: "plan", steps: plan };

      const results = await this.executePlan(userMessage, history, plan, options);
      this.throwIfAborted(options.signal);
      yield { kind: "thinking", content: "Synthesizing final answer..." };

      const final = await this.synthesize(userMessage, history, results, options.signal);
      this.throwIfAborted(options.signal);
      yield { kind: "final", content: final };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { kind: "error", message };
    }
  }

  private async plan(
    userMessage: string,
    history: Message[],
    availableSkills: SkillMetadata[],
    signal?: AbortSignal,
  ): Promise<PlanStep[]> {
    const skillList = availableSkills.length
      ? availableSkills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")
      : "(no skills available)";
    const plannerPrompt: Message = {
      role: "user",
      content: `วางแผนสำหรับ task นี้: "${userMessage}"

Skills ที่เลือกใช้ได้:
${skillList}

ตอบเป็น JSON เท่านั้น:
{
  "steps": [
    { "id": "s1", "task": "สิ่งที่ต้องทำ", "dependsOn": [], "skills": ["ชื่อ skill ที่จำเป็น"] }
  ]
}

กฎ:
- แตก task เท่าที่จำเป็น งานเล็กใช้ step เดียว
- เลือกเฉพาะ skill ที่เกี่ยวข้องจริงและมีอยู่ในรายการ
- dependsOn ใช้เมื่อ step ต้องรอผลจาก step อื่น`,
    };

    const response = await this.cfg.llm.chat({
      messages: [...history, plannerPrompt],
      system: "You are a planning agent. Output valid JSON only.",
      maxTokens: 1800,
      signal,
    });
    const availableNames = new Set(availableSkills.map((skill) => skill.name));

    try {
      const json = extractJson(response);
      const steps = Array.isArray(json.steps) ? json.steps : [];
      if (steps.length === 0) throw new Error("Planner returned no steps");
      return steps.map((step: Record<string, unknown>, index: number) => ({
        id: typeof step.id === "string" ? step.id : `s${index + 1}`,
        task: typeof step.task === "string" ? step.task : userMessage,
        dependsOn: Array.isArray(step.dependsOn)
          ? step.dependsOn.filter((value): value is string => typeof value === "string")
          : [],
        skills: Array.isArray(step.skills)
          ? step.skills.filter((value): value is string => typeof value === "string" && availableNames.has(value))
          : [],
        status: "pending" as const,
      }));
    } catch {
      const mentionedSkills = availableSkills
        .filter((skill) => userMessage.toLowerCase().includes(skill.name.toLowerCase()))
        .map((skill) => skill.name);
      return [{
        id: "s1",
        task: userMessage,
        dependsOn: [],
        skills: mentionedSkills,
        status: "pending",
      }];
    }
  }

  private async executePlan(
    userMessage: string,
    history: Message[],
    plan: PlanStep[],
    options: RunOptions,
  ): Promise<SubAgentResult[]> {
    const results = new Map<string, SubAgentResult>();
    const inFlight = new Map<string, Promise<void>>();

    const startStep = (step: PlanStep) => {
      step.status = "running";
      options.onEvent?.({ kind: "subagent_spawned", id: step.id, task: step.task });

      const promise = (async () => {
        try {
          const loadedSkills = options.loadSkill
            ? await Promise.all(step.skills.map(async (name) => {
                const skill = await options.loadSkill!(name);
                options.onEvent?.({ kind: "skill_activated", id: step.id, skill: name });
                return skill;
              }))
            : [];
          const skillInstructions = loadedSkills
            .map((skill) => `# ${skill.name}\n${skill.instructions}`)
            .join("\n\n");

          const agent = new SubAgent({
            llm: this.cfg.llm,
            acl: this.cfg.acl,
            audit: this.cfg.audit,
            tools: this.cfg.tools,
            systemPrompt: this.cfg.systemPrompt,
            signal: options.signal,
            requestConfirmation: options.requestConfirmation,
          });

          for await (const event of agent.run({
            id: step.id,
            instruction: step.task,
            context: userMessage,
            skillInstructions,
          }, history)) {
            if (event.kind === "content") {
              options.onEvent?.({ kind: "subagent_progress", id: step.id, content: event.content });
            } else if (event.kind === "tool_call") {
              options.onEvent?.({ kind: "tool_call", id: step.id, name: event.name, args: event.args });
            } else if (event.kind === "tool_result") {
              options.onEvent?.({ kind: "tool_result", id: step.id, name: event.name, result: event.result });
            } else if (event.kind === "done") {
              results.set(step.id, event.result);
              step.status = event.result.success ? "done" : "failed";
              options.onEvent?.({ kind: "subagent_done", id: step.id, result: event.result });
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const result: SubAgentResult = {
            agentId: step.id,
            success: false,
            output: "",
            error: message,
            toolCalls: 0,
          };
          results.set(step.id, result);
          step.status = "failed";
          options.onEvent?.({ kind: "subagent_done", id: step.id, result });
        }
      })();
      inFlight.set(step.id, promise);
    };

    while (plan.some((step) => step.status === "pending") || inFlight.size > 0) {
      this.throwIfAborted(options.signal);
      const ready = plan.filter((step) =>
        step.status === "pending" && step.dependsOn.every((dependency) => results.get(dependency)?.success),
      );

      for (const step of ready) {
        if (inFlight.size >= this.cfg.maxConcurrentSubagents) break;
        startStep(step);
      }

      if (inFlight.size > 0) {
        const completedId = await Promise.race(
          [...inFlight.entries()].map(([id, promise]) => promise.then(() => id)),
        );
        inFlight.delete(completedId);
        continue;
      }

      const blocked = plan.filter((step) => step.status === "pending");
      for (const step of blocked) {
        const result: SubAgentResult = {
          agentId: step.id,
          success: false,
          output: "",
          error: "Blocked by a failed or missing dependency",
          toolCalls: 0,
        };
        step.status = "failed";
        results.set(step.id, result);
        options.onEvent?.({ kind: "subagent_done", id: step.id, result });
      }
    }

    return plan.map((step) => results.get(step.id)).filter((result): result is SubAgentResult => Boolean(result));
  }

  private async synthesize(userMessage: string, history: Message[], results: SubAgentResult[], signal?: AbortSignal) {
    const summary = results
      .map((result) => `[${result.agentId}] ${result.success ? "✓" : "✗"}: ${result.output || result.error}`)
      .join("\n\n");
    return this.cfg.llm.chat({
      messages: [
        ...history,
        { role: "user", content: userMessage },
        { role: "user", content: `ผลลัพธ์จาก sub-agents:\n\n${summary}\n\nสรุปคำตอบสุดท้ายเป็นภาษาเดียวกับผู้ใช้` },
      ],
      system: "You are a helpful coworker. Synthesize a clear final answer from the agent results.",
      maxTokens: 2200,
      signal,
    });
  }

  private throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("Task cancelled");
  }
}

const DEFAULT_SYSTEM_PROMPT = `คุณคือ AI coworker ทำงานร่วมกับ user บน local files
- ใช้ภาษาเดียวกับ user
- ใช้ skill instructions ที่ได้รับอย่างเคร่งครัด
- action ที่เขียน ลบ หรือย้ายไฟล์ต้องผ่าน permission flow
- ถ้าไม่แน่ใจให้ถาม user และสรุปผลให้ชัดเจน`;

function extractJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced) return JSON.parse(fenced[1]) as Record<string, unknown>;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    throw new Error("No valid JSON found in response");
  }
}
