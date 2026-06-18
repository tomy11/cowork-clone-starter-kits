/**
 * Agent Orchestrator
 *
 * รับ task จาก user → วางแผน → แตกเป็น sub-agent → รวมผล
 *
 * หลักการ:
 *  1. รับ user message
 *  2. ส่งให้ "planner agent" วิเคราะห์ task แล้วแตกเป็น sub-tasks
 *  3. sub-task ที่ independent → spawn sub-agent ทำขนาน
 *  4. sub-task ที่ depend on อื่น → รอ แล้วค่อยทำ
 *  5. รวมผลลัพธ์กลับเป็น final answer
 */

import { SubAgent, type SubAgentTask, type SubAgentResult } from "./subagent.js";
import type { LLMProvider, Message, Tool } from "../llm/provider.js";
import type { PermissionACL } from "../permissions/acl.js";
import type { AuditLog } from "../permissions/audit.js";
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
  | { kind: "tool_call"; name: string; args: unknown }
  | { kind: "tool_result"; name: string; result: unknown }
  | { kind: "final"; content: string }
  | { kind: "error"; message: string };

export type PlanStep = {
  id: string;
  task: string;
  dependsOn?: string[];
  status: "pending" | "running" | "done" | "failed";
  agentId?: string;
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

  /**
   * รัน task หลัก — เป็น streaming API ส่ง event ออกมาเรื่อยๆ
   */
  async *run(userMessage: string, history: Message[] = []): AsyncGenerator<OrchestratorEvent> {
    yield { kind: "thinking", content: "Analyzing task..." };

    // Step 1: Plan
    const plan = await this.plan(userMessage, history);
    yield { kind: "plan", steps: plan };

    // Step 2: Execute plan with parallel sub-agents
    const results = await this.executePlan(userMessage, history, plan);
    for (const r of results) {
      yield { kind: "subagent_done", id: r.agentId, result: r };
    }

    // Step 3: Synthesize final answer
    yield { kind: "thinking", content: "Synthesizing final answer..." };
    const final = await this.synthesize(userMessage, history, plan, results);
    yield { kind: "final", content: final };
  }

  private async plan(userMessage: string, history: Message[]): Promise<PlanStep[]> {
    const plannerPrompt: Message = {
      role: "user",
      content: `วางแผนสำหรับ task นี้: "${userMessage}"

ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น:
{
  "steps": [
    { "id": "s1", "task": "อธิบายสั้นๆ ว่าต้องทำอะไร", "dependsOn": [] },
    { "id": "s2", "task": "...", "dependsOn": ["s1"] }
  ]
}

กฎ:
- แตกให้พอเหมาะ ไม่ต้องแตกเยอะถ้า task เล็ก
- dependsOn ใช้กรณีต้องรอ step อื่น
- ถ้า task เล็กพอ ให้มีแค่ 1 step`,
    };

    const resp = await this.cfg.llm.chat({
      messages: [...history, plannerPrompt],
      system: "You are a planning agent. Output JSON only.",
      maxTokens: 1500,
    });

    try {
      const json = extractJson(resp);
      return (json.steps ?? []).map((s: any) => ({
        id: s.id,
        task: s.task,
        dependsOn: s.dependsOn ?? [],
        status: "pending" as const,
      }));
    } catch (e) {
      // Fallback: ถ้า LLM ไม่ตอบ JSON ให้ทำทั้งหมดใน step เดียว
      return [{ id: "s1", task: userMessage, dependsOn: [], status: "pending" }];
    }
  }

  private async executePlan(
    userMessage: string,
    history: Message[],
    plan: PlanStep[],
  ): Promise<SubAgentResult[]> {
    const results = new Map<string, SubAgentResult>();
    const inFlight = new Map<string, Promise<void>>();
    const queue = [...plan];

    while (queue.some((s) => s.status === "pending") || inFlight.size > 0) {
      // หา step ที่ ready (pending + dependencies done)
      const ready = queue.filter(
        (s) =>
          s.status === "pending" &&
          (s.dependsOn ?? []).every((d) => results.has(d)),
      );

      // spawn ตาม concurrency limit
      while (
        ready.length > 0 &&
        inFlight.size < this.cfg.maxConcurrentSubagents
      ) {
        const step = ready.shift()!;
        step.status = "running";

        const agent = new SubAgent({
          llm: this.cfg.llm,
          acl: this.cfg.acl,
          audit: this.cfg.audit,
          tools: this.cfg.tools,
          systemPrompt: this.cfg.systemPrompt,
        });

        const task: SubAgentTask = {
          id: step.id,
          instruction: step.task,
          context: userMessage,
        };

        const p = (async () => {
          const events = agent.run(task, history);
          for await (const ev of events) {
            if (ev.kind === "content") {
              // ส่งต่อ progress (optional: ใช้ callback)
            } else if (ev.kind === "done") {
              results.set(step.id, ev.result);
              step.status = ev.result.success ? "done" : "failed";
            } else if (ev.kind === "error") {
              results.set(step.id, {
                agentId: step.id,
                success: false,
                output: "",
                error: ev.message,
                toolCalls: 0,
              });
              step.status = "failed";
            }
          }
        })();

        inFlight.set(step.id, p);
      }

      // รอ agent ตัวใดตัวหนึ่งเสร็จ
      if (inFlight.size > 0) {
        await Promise.race(inFlight.values());
        // ลบตัวที่เสร็จแล้วออก
        for (const [id, p] of inFlight) {
          const step = queue.find((s) => s.id === id)!;
          if (step.status === "done" || step.status === "failed") {
            inFlight.delete(id);
          } else {
            // รอตัวนี้ต่อ
            await p.catch(() => {});
            inFlight.delete(id);
          }
        }
      } else if (ready.length === 0) {
        // Deadlock (shouldn't happen) — break to avoid infinite loop
        break;
      }
    }

    return [...results.values()];
  }

  private async synthesize(
    userMessage: string,
    history: Message[],
    plan: PlanStep[],
    results: SubAgentResult[],
  ): Promise<string> {
    const summary = results
      .map((r) => `[${r.agentId}] ${r.success ? "✓" : "✗"}: ${r.output || r.error}`)
      .join("\n\n");

    const resp = await this.cfg.llm.chat({
      messages: [
        ...history,
        { role: "user", content: userMessage },
        {
          role: "user",
          content: `ผลลัพธ์จาก sub-agents:\n\n${summary}\n\nช่วยสรุปคำตอบสุดท้ายให้ user เป็นภาษาเดียวกับที่ user ถาม กระชับ เข้าใจง่าย`,
        },
      ],
      system: "You are a helpful coworker. Summarize the sub-agent results into a clear final answer.",
      maxTokens: 2000,
    });

    return resp;
  }
}

const DEFAULT_SYSTEM_PROMPT = `คุณคือ AI coworker ทำงานร่วมกับ user บน local files
- ใช้ภาษาเดียวกับ user
- ก่อนทำ action ที่ destructive (ลบ, เขียนทับ, ย้ายไฟล์เยอะๆ) → ต้องขอ confirm
- ถ้าไม่แน่ใจ → ถาม user
- สรุปสั้นๆ ไม่ต้องยาวเกินจำเป็น`;

function extractJson(text: string): any {
  // พยายาม parse JSON ตรงๆ ก่อน
  try {
    return JSON.parse(text);
  } catch {}

  // หา JSON block ใน markdown
  const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {}
  }

  // หา {...} แรกที่ parse ได้
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }

  throw new Error("No valid JSON found in response");
}
