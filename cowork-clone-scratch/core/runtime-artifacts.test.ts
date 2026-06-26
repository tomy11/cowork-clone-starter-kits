import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtInFileTools } from "./agent/tools/file-tools.js";
import { ToolRegistry } from "./agent/tools/registry.js";
import { ExtensionsLoader } from "./extensions/loader.js";
import type { ChatOptions, ChatResponse, ChatWithToolsOptions, LLMProvider } from "./llm/provider.js";
import { McpManager } from "./mcp/manager.js";
import { AuditLog } from "./permissions/audit.js";
import { PermissionACL } from "./permissions/acl.js";
import { AppRuntime, type AppEvent } from "./runtime.js";
import { SkillsLoader } from "./skills/loader.js";
import { WorkspaceStore } from "./storage/workspace-store.js";

class WritingProvider implements LLMProvider {
  readonly name = "writing-test";
  private toolRound = 0;

  async chat(_options: ChatOptions) {
    return JSON.stringify({ steps: [{ id: "s1", task: "write the artifact", dependsOn: [], skills: [] }] });
  }

  async chatWithTools(_options: ChatWithToolsOptions): Promise<ChatResponse> {
    this.toolRound++;
    if (this.toolRound === 1) {
      return {
        text: "Writing file",
        toolUses: [{
          id: "tool-1",
          name: "write_file",
          input: { path: this.targetPath, content: "# Artifact\n" },
        }],
      };
    }
    return { text: "done", toolUses: [] };
  }

  constructor(private targetPath: string) {}
}

const temporaryDirectories: string[] = [];
const runtimes: AppRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("runtime artifacts", () => {
  it("records write_file results as session artifacts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cowork-runtime-artifacts-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    const targetPath = path.join(workspace, "artifact.md");
    const runtime = createRuntime(workspace, targetPath, directory);
    runtimes.push(runtime);
    const created = await runtime.handle({
      id: "create",
      method: "create_conversation",
      params: { workspace, title: "Artifacts" },
    });
    const conversationId = (created.result as { conversation: { id: string } }).conversation.id;
    const streamed: AppEvent[] = [];
    const unsubscribe = runtime.subscribeSession(conversationId, (event) => streamed.push(event));

    const result = await runtime.handle({
      id: "run",
      method: "run",
      params: {
        conversationId,
        workspace,
        message: "write an artifact",
        runId: "artifact-run",
      },
    });
    unsubscribe();

    expect(result.error).toBeUndefined();
    expect(runtime.listArtifacts(conversationId)).toMatchObject([
      {
        conversationId,
        runId: "artifact-run",
        kind: "created",
        path: targetPath,
        name: "artifact.md",
        fileType: "md",
        mimeType: "text/markdown",
        sizeBytes: 11,
        toolName: "write_file",
      },
    ]);
    expect((result.result as { events: AppEvent[] }).events.map((event) => event.kind)).toContain("artifact_created");
    expect(streamed.map((event) => event.kind)).toContain("artifact_created");
    expect(runtime.listConversationEvents(conversationId).map((event) => event.kind)).toContain("artifact_created");
    expect(runtime.listConversationEvents(conversationId).map((event) => event.kind)).toContain("file_created");
  });

  it("attaches existing workspace files as replayable session artifacts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cowork-runtime-attach-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    const targetPath = path.join(workspace, "brief.txt");
    await writeFile(targetPath, "attached context");
    const runtime = createRuntime(workspace, targetPath, directory);
    runtimes.push(runtime);
    const created = await runtime.handle({
      id: "create",
      method: "create_conversation",
      params: { workspace, title: "Attach" },
    });
    const conversationId = (created.result as { conversation: { id: string } }).conversation.id;
    const streamed: AppEvent[] = [];
    const unsubscribe = runtime.subscribeSession(conversationId, (event) => streamed.push(event));

    const artifact = runtime.attachArtifact(conversationId, targetPath);
    unsubscribe();

    expect(artifact).toMatchObject({
      conversationId,
      runId: null,
      kind: "attached",
      path: targetPath,
      name: "brief.txt",
      fileType: "txt",
      mimeType: "text/plain",
      sizeBytes: 16,
      toolName: "attach_file",
    });
    expect(streamed).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "artifact_attached", conversationId, artifact: expect.objectContaining({ id: artifact?.id }) }),
      expect.objectContaining({ kind: "file_attached", conversationId, artifactId: artifact?.id }),
    ]));
    expect(runtime.listConversationEvents(conversationId).map((event) => event.kind)).toContain("artifact_attached");
  });
});

function createRuntime(workspace: string, targetPath: string, directory: string) {
  const acl = new PermissionACL();
  acl.grantFolder(workspace, { write: "allow" });
  const tools = new ToolRegistry();
  for (const tool of builtInFileTools) tools.register(tool);
  return new AppRuntime({
    llm: new WritingProvider(targetPath),
    acl,
    audit: new AuditLog(":memory:"),
    store: new WorkspaceStore(":memory:"),
    tools,
    skills: new SkillsLoader(path.join(directory, "skills")),
    extensions: new ExtensionsLoader(path.join(directory, "extensions"), { env: {}, resourceRoot: directory }),
    mcp: new McpManager(path.join(directory, "mcp.json"), tools),
  });
}
