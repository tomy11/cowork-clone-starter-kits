/**
 * OpenAI-compatible LLM Provider
 *
 * ใช้ได้กับ: OpenAI, Gemini (ผ่าน OpenAI-compat endpoint), Ollama, GLM, DeepSeek ฯลฯ
 */

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  LLMProvider,
  ChatOptions,
  ChatWithToolsOptions,
  ChatResponse,
  Message,
  Tool,
  ToolUse,
} from "./provider.js";

export type OpenAICompatConfig = {
  apiKey: string;
  baseURL?: string;
  model: string;
};

export class OpenAICompatProvider implements LLMProvider {
  readonly name = "openai-compat";
  private client: OpenAI;
  private model: string;

  constructor(cfg: OpenAICompatConfig) {
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
    });
    this.model = cfg.model;
  }

  async chat(opts: ChatOptions): Promise<string> {
    const resp = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.7,
      messages: this.formatMessages(opts.messages, opts.system),
    }, { signal: opts.signal });
    return resp.choices[0]?.message?.content ?? "";
  }

  async chatWithTools(opts: ChatWithToolsOptions): Promise<ChatResponse> {
    const resp = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.7,
      messages: this.formatMessages(opts.messages, opts.system),
      tools: this.formatTools(opts.tools),
    }, { signal: opts.signal });

    return this.parseResponse(resp);
  }

  private formatMessages(messages: Message[], system?: string): ChatCompletionMessageParam[] {
    const out: ChatCompletionMessageParam[] = [];
    if (system) {
      out.push({ role: "system", content: system });
    }
    for (const m of messages) {
      if (m.role === "system") continue;

      if (m.role === "user") {
        // ถ้ามี tool results → ต้อง push แยก
        if (m.toolResults && m.toolResults.length > 0) {
          for (const tr of m.toolResults) {
            out.push({
              role: "tool",
              tool_call_id: tr.tool_use_id,
              content: tr.content,
            });
          }
        } else {
          out.push({ role: "user", content: m.content });
        }
      } else if (m.role === "assistant") {
        const msg: any = { role: "assistant", content: m.content || null };
        if (m.toolUses && m.toolUses.length > 0) {
          msg.tool_calls = m.toolUses.map((tu) => ({
            id: tu.id,
            type: "function" as const,
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input),
            },
          }));
        }
        out.push(msg);
      }
    }
    return out;
  }

  private formatTools(tools: Tool[]): ChatCompletionTool[] {
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  private parseResponse(resp: OpenAI.Chat.ChatCompletion): ChatResponse {
    const choice = resp.choices[0];
    if (!choice) return { text: "", toolUses: [] };

    const text = choice.message?.content ?? "";
    const toolUses: ToolUse[] = [];

    if (choice.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        if (tc.type === "function") {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = { _raw: tc.function.arguments };
          }
          toolUses.push({
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }
    }

    return { text, toolUses };
  }
}
