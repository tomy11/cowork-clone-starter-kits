/**
 * Claude LLM Provider
 *
 * ใช้ @anthropic-ai/sdk ตรงๆ
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  ChatOptions,
  ChatWithToolsOptions,
  ChatResponse,
  Message,
  Tool,
  ToolUse,
} from "./provider.js";

export type ClaudeConfig = {
  apiKey: string;
  model?: string;
  baseURL?: string;
};

export class ClaudeProvider implements LLMProvider {
  readonly name = "claude";
  private client: Anthropic;
  private model: string;

  constructor(cfg: ClaudeConfig) {
    this.client = new Anthropic({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
    });
    this.model = cfg.model ?? "claude-sonnet-4-5";
  }

  async chat(opts: ChatOptions): Promise<string> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.7,
      system: opts.system ?? "",
      messages: this.formatMessages(opts.messages) as any,
    }, { signal: opts.signal });

    return resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  async chatWithTools(opts: ChatWithToolsOptions): Promise<ChatResponse> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.7,
      system: opts.system ?? "",
      tools: this.formatTools(opts.tools) as any,
      messages: this.formatMessages(opts.messages) as any,
    }, { signal: opts.signal });

    return this.parseResponse(resp);
  }

  private formatMessages(messages: Message[]): unknown[] {
    return messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        if (m.role === "user") {
          const content: any[] = [];

          if (m.content) {
            content.push({ type: "text", text: m.content });
          }

          if (m.toolResults && m.toolResults.length > 0) {
            for (const tr of m.toolResults) {
              content.push({
                type: "tool_result",
                tool_use_id: tr.tool_use_id,
                content: tr.content,
                is_error: tr.is_error,
              });
            }
          }

          return { role: "user", content };
        }

        if (m.role === "assistant") {
          const content: any[] = [];
          if (m.content) {
            content.push({ type: "text", text: m.content });
          }
          if (m.toolUses) {
            for (const tu of m.toolUses) {
              content.push({
                type: "tool_use",
                id: tu.id,
                name: tu.name,
                input: tu.input,
              });
            }
          }
          return { role: "assistant", content };
        }

        return { role: m.role, content: m.content };
      });
  }

  private formatTools(tools: Tool[]): unknown[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }

  private parseResponse(resp: Anthropic.Message): ChatResponse {
    let text = "";
    const toolUses: ToolUse[] = [];

    for (const block of resp.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolUses.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return { text, toolUses };
  }
}
