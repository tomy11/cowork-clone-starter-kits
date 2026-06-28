import type { LLMProvider, Message } from "../llm/provider.js";
import type { PermissionACL, PermissionDecision } from "../permissions/acl.js";
import type { AuditLog } from "../permissions/audit.js";
import type { ToolRegistry } from "./tools/registry.js";

export type SubAgentTask = {
  id: string;
  instruction: string;
  context?: string;
  skillInstructions?: string;
};

export type SubAgentResult = {
  agentId: string;
  success: boolean;
  output: string;
  error?: string;
  toolCalls: number;
};

export type ConfirmationRequest = {
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  prompt: string;
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
  workspace?: string;
  systemPrompt?: string;
  maxToolRounds?: number;
  signal?: AbortSignal;
  requestConfirmation?: (request: ConfirmationRequest) => Promise<boolean>;
};

export class SubAgent {
  private cfg: SubAgentConfig & { systemPrompt: string; maxToolRounds: number };

  constructor(cfg: SubAgentConfig) {
    this.cfg = {
      systemPrompt: "You are a focused sub-agent. Complete the given task and return a clear result.",
      maxToolRounds: 15,
      ...cfg,
    };
  }

  async *run(task: SubAgentTask, history: Message[] = []): AsyncGenerator<SubAgentEvent> {
    const skillContext = task.skillInstructions
      ? `\n\nActive skill instructions:\n${task.skillInstructions}`
      : "";
    const messages: Message[] = [
      ...history,
      {
        role: "user",
        content: task.context
          ? `${task.context}\n\n---\n\nSub-task ของคุณ: ${task.instruction}${skillContext}\n\nตอบเป็น concise report เมื่อทำเสร็จ — ไม่ต้องสวยงาม ขอให้ครบถ้วน`
          : `Task: ${task.instruction}${skillContext}\n\nตอบเป็น concise report เมื่อทำเสร็จ`,
      },
    ];

    let toolCallCount = 0;
    const usedToolIds = new Set<string>();

    try {
      for (let round = 0; round < this.cfg.maxToolRounds; round++) {
        this.throwIfAborted();
        const resp = await this.cfg.llm.chatWithTools({
          messages,
          system: this.cfg.systemPrompt,
          tools: this.cfg.tools.list(),
          signal: this.cfg.signal,
        });
        this.throwIfAborted();

        messages.push({ role: "assistant", content: resp.text ?? "", toolUses: resp.toolUses });
        if (resp.text) yield { kind: "content", content: resp.text };

        if (!resp.toolUses || resp.toolUses.length === 0) {
          yield {
            kind: "done",
            result: { agentId: task.id, success: true, output: resp.text ?? "", toolCalls: toolCallCount },
          };
          return;
        }

        const toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];

        for (const toolUse of resp.toolUses) {
          this.throwIfAborted();
          if (usedToolIds.has(toolUse.id)) {
            toolResults.push({
              tool_use_id: toolUse.id,
              content: "Error: tool already used, skipping duplicate",
              is_error: true,
            });
            continue;
          }

          usedToolIds.add(toolUse.id);
          toolCallCount++;
          yield { kind: "tool_call", name: toolUse.name, args: toolUse.input };

          const registeredTool = this.cfg.tools.get(toolUse.name);
          let permission = await this.checkPermission(toolUse.name, toolUse.input);
          if (permission.allowed && registeredTool.requiresConfirmation) {
            permission = {
              allowed: true,
              requiresConfirm: true,
              confirmPrompt: `Allow external tool ${toolUse.name}?`,
            };
          }
          if (!permission.allowed) {
            this.cfg.audit.log({
              agentId: task.id,
              tool: toolUse.name,
              args: toolUse.input,
              decision: "denied",
              reason: permission.reason,
            });
            toolResults.push({
              tool_use_id: toolUse.id,
              content: `Permission denied: ${permission.reason}`,
              is_error: true,
            });
            yield { kind: "tool_result", name: toolUse.name, result: "denied" };
            continue;
          }

          let confirmationApproved = false;
          if (permission.requiresConfirm) {
            this.cfg.audit.log({
              agentId: task.id,
              tool: toolUse.name,
              args: toolUse.input,
              decision: "pending_confirm",
            });
            confirmationApproved = this.cfg.requestConfirmation
              ? await this.cfg.requestConfirmation({
                  agentId: task.id,
                  tool: toolUse.name,
                  args: toolUse.input,
                  prompt: permission.confirmPrompt ?? `Allow ${toolUse.name}?`,
                })
              : false;
            this.throwIfAborted();

            if (!confirmationApproved) {
              this.cfg.audit.log({
                agentId: task.id,
                tool: toolUse.name,
                args: toolUse.input,
                decision: "denied",
                reason: "User denied confirmation",
              });
              toolResults.push({
                tool_use_id: toolUse.id,
                content: "Permission denied by user",
                is_error: true,
              });
              yield { kind: "tool_result", name: toolUse.name, result: "denied_by_user" };
              continue;
            }
          }

          try {
            const result = await registeredTool.execute(toolUse.input, {
              agentId: task.id,
              acl: this.cfg.acl,
              confirmationApproved,
              workspace: this.cfg.workspace,
            });
            this.cfg.audit.log({
              agentId: task.id,
              tool: toolUse.name,
              args: toolUse.input,
              decision: "allowed",
            });
            const resultText = typeof result === "string" ? result : JSON.stringify(result);
            toolResults.push({ tool_use_id: toolUse.id, content: resultText });
            yield { kind: "tool_result", name: toolUse.name, result };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.cfg.audit.log({
              agentId: task.id,
              tool: toolUse.name,
              args: toolUse.input,
              decision: "error",
              reason: message,
            });
            toolResults.push({ tool_use_id: toolUse.id, content: `Error: ${message}`, is_error: true });
            yield { kind: "tool_result", name: toolUse.name, result: message };
          }
        }

        messages.push({ role: "user", content: "", toolResults });
      }

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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { kind: "error", message };
      yield {
        kind: "done",
        result: {
          agentId: task.id,
          success: false,
          output: "",
          error: message,
          toolCalls: toolCallCount,
        },
      };
    }
  }

  private async checkPermission(tool: string, args: Record<string, unknown>): Promise<PermissionDecision> {
    const paths = tool === "move_file"
      ? [String(args.from ?? ""), String(args.to ?? "")]
      : [String(args.path ?? args.file_path ?? args.filepath ?? "")];

    if (paths.every((value) => !value)) return this.cfg.acl.check(tool, args);

    let confirmation: PermissionDecision | null = null;
    for (const targetPath of paths) {
      const decision = await this.cfg.acl.check(tool, { ...args, path: targetPath });
      if (!decision.allowed) return decision;
      if (decision.requiresConfirm) confirmation = decision;
    }
    return confirmation ?? { allowed: true, requiresConfirm: false };
  }

  private throwIfAborted() {
    if (this.cfg.signal?.aborted) throw new Error("Task cancelled");
  }
}
