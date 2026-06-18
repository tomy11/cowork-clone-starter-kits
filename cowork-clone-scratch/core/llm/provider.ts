/**
 * LLM Provider abstraction
 *
 * รองรับ Claude + OpenAI-compatible (GPT, Gemini, Ollama, GLM ฯลฯ)
 */

export type Message = {
  role: "user" | "assistant" | "system";
  content: string;
  toolUses?: ToolUse[];
  toolResults?: Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
};

export type ToolUse = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type Tool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ChatOptions = {
  messages: Message[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
};

export type ChatWithToolsOptions = ChatOptions & {
  tools: Tool[];
};

export type ChatResponse = {
  text: string;
  toolUses: ToolUse[];
};

export interface LLMProvider {
  readonly name: string;
  chat(opts: ChatOptions): Promise<string>;
  chatWithTools(opts: ChatWithToolsOptions): Promise<ChatResponse>;
}

/**
 * Adapter — convert internal Message format ให้ provider-specific
 */
export interface ProviderAdapter {
  formatMessages(messages: Message[]): unknown[];
  formatTools(tools: Tool[]): unknown[];
  parseResponse(raw: unknown): ChatResponse;
  parseTextResponse(raw: unknown): string;
}
