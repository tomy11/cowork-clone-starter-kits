import * as path from "node:path";
import type { ChatOptions, ChatResponse, ChatWithToolsOptions, LLMProvider } from "./provider.js";

/** Deterministic provider available only when the sidecar runs under NODE_ENV=test. */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  private toolRound = 0;

  async chat(options: ChatOptions): Promise<string> {
    if (options.system?.includes("planning agent")) {
      return JSON.stringify({
        steps: [{ id: "s1", task: "Complete the mocked workflow", dependsOn: [], skills: [] }],
      });
    }
    return "Mock task completed.";
  }

  async chatWithTools(options: ChatWithToolsOptions): Promise<ChatResponse> {
    const content = options.messages.map((message) => message.content).join("\n");
    if (content.includes("[MOCK_WRITE]") && this.toolRound++ === 0) {
      const workspace = content.match(/Workspace root: ([^\n]+)/)?.[1]?.trim() ?? process.cwd();
      return {
        text: "",
        toolUses: [{
          id: "mock-write-1",
          name: "write_file",
          input: {
            path: path.join(workspace, "mock-output.txt"),
            content: "created by mock provider",
          },
        }],
      };
    }
    return { text: "Mock agent finished.", toolUses: [] };
  }
}
