/**
 * SubAgent
 *
 * Agent ตัวเล็กที่ทำ task เดียวจบ — ใช้ LLM + tools + permission
 * รันแบบ streaming event
 */

import type { LLMProvider, Message, ToolUse } from "../llm/provider.js";
import type { PermissionACL } from "../permissions/acl.js";
import type { AuditLog } from "../permissions/audit.js";
import type { ToolRegistry } from "./tools/registry.js";

export type SubAgentTask = {
  id: string;
  instruction: string;
  context?: string;
};

export type SubAgentResult = {
  agentId: string;
  success: boolean;
  output: string;
  error?: string;
  toolCalls: number;
};

export type SubAgentEvent =
  | { kind: "content"; content: string }
  | { kind: "tool_call"; name: string; args: unknown }
  | { kind: "tool_result"; name: string; result: unknown }
  | { kind: "done"; result: SubAgentResult }
  | { kind: "error"; message: string };

export type SubAgentConfig = {
  llm: LLMProvider;
  acl: PermissionACL;
  audit: AuditLog;
  tools: ToolRegistry;
  systemPrompt?: string;
  maxToolRounds?: number;
};

export class SubAgent {
  private cfg: Required<SubAgentConfig>;

  constructor(cfg: SubAgentConfig) {
    this.cfg = {
      systemPrompt: "You are a focused sub-agent. Complete the given task and return a clear result.",
      maxToolRounds: 15,
      ...cfg,
    };
  }

  async *run(task: SubAgentTask, history: Message[] = []): AsyncGenerator<SubAgentEvent> {
    const messages: Message[] = [
      ...history,
      {
        role: "user",
        content: task.context
          ? `${task.context}\n\n---\n\nSub-task ของคุณ: ${task.instruction}\n\nตอบเป็น concise report เมื่อทำเสร็จ — ไม่ต้องสวยงาม ขอให้ครบถ้วน`
          : `Task: ${task.instruction}\n\nตอบเป็น concise report เมื่อทำเสร็จ`,
      },
    ];

    let toolCallCount = 0;
    const usedToolIds = new Set<string>();

    try {
      for (let round = 0; round < this.cfg.maxToolRounds; round++) {
        const tools = this.cfg.tools.list();

        const resp = await this.cfg.llm.chatWithTools({
          messages,
          system: this.cfg.systemPrompt,
          tools,
        });

        // เพิ่ม assistant message
        messages.push({
          role: "assistant",
          content: resp.text ?? "",
          toolUses: resp.toolUses,
        });

        if (resp.text) {
          yield { kind: "content", content: resp.text };
        }

        // ถ้าไม่มี tool call → จบ
        if (!resp.toolUses || resp.toolUses.length === 0) {
          yield {
            kind: "done",
            result: {
              agentId: task.id,
              success: true,
              output: resp.text ?? "",
              toolCalls: toolCallCount,
            },
          };
          return;
        }

        // Execute tools
        const toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];

        for (const tu of resp.toolUses) {
          if (usedToolIds.has(tu.id)) {
            // Avoid infinite loop
            toolResults.push({
              tool_use_id: tu.id,
              content: "Error: tool already used, skipping duplicate",
              is_error: true,
            });
            continue;
          }
          usedToolIds.add(tu.id);
          toolCallCount++;

          yield { kind: "tool_call", name: tu.name, args: tu.input };

          // Permission check
          const permResult = await this.cfg.acl.check(tu.name, tu.input);
          if (!permResult.allowed) {
            this.cfg.audit.log({
              agentId: task.id,
              tool: tu.name,
              args: tu.input,
              decision: "denied",
              reason: permResult.reason,
            });
            toolResults.push({
              tool_use_id: tu.id,
              content: `Permission denied: ${permResult.reason}`,
              is_error: true,
            });
            yield { kind: "tool_result", name: tu.name, result: "denied" };
            continue;
          }

          // ถ้าต้อง confirm → throw ไปให้ orchestrator handle (pause + ask user)
          if (permResult.requiresConfirm) {
            this.cfg.audit.log({
              agentId: task.id,
              tool: tu.name,
              args: tu.input,
              decision: "pending_confirm",
            });
            toolResults.push({
              tool_use_id: tu.id,
              content: `CONFIRM_REQUIRED: ${permResult.confirmPrompt ?? "User confirmation required"}`,
              is_error: true,
            });
            yield { kind: "tool_result", name: tu.name, result: "confirm_required" };
            continue;
          }

          // Execute
          try {
            const tool = this.cfg.tools.get(tu.name);
            const result = await tool.execute(tu.input, {
              agentId: task.id,
              acl: this.cfg.acl,
            });

            this.cfg.audit.log({
              agentId: task.id,
              tool: tu.name,
              args: tu.input,
              decision: "allowed",
            });

            const resultStr = typeof result === "string" ? result : JSON.stringify(result);
            toolResults.push({ tool_use_id: tu.id, content: resultStr });
            yield { kind: "tool_result", name: tu.name, result };
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.cfg.audit.log({
              agentId: task.id,
              tool: tu.name,
              args: tu.input,
              decision: "error",
              reason: errMsg,
            });
            toolResults.push({
              tool_use_id: tu.id,
              content: `Error: ${errMsg}`,
              is_error: true,
            });
            yield { kind: "tool_result", name: tu.name, result: errMsg };
          }
        }

        messages.push({ role: "user", content: "", toolResults });
      }

      // Hit max rounds
      yield {
        kind: "done",
        result: {
          agentId: task.id,
          success: false,
          output: "Reached max tool rounds without final answer",
          error: "max_rounds",
          toolCalls: toolCallCount,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { kind: "error", message: msg };
      yield {
        kind: "done",
        result: {
          agentId: task.id,
          success: false,
          output: "",
          error: msg,
          toolCalls: toolCallCount,
        },
      };
    }
  }
}
