import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtInFileTools } from "./agent/tools/file-tools.js";
import { ToolRegistry, type ToolImpl } from "./agent/tools/registry.js";
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

class CommandOutputProvider implements LLMProvider {
  readonly name = "command-output-test";
  private toolRound = 0;

  async chat(_options: ChatOptions) {
    return JSON.stringify({ steps: [{ id: "s1", task: "generate the output", dependsOn: [], skills: [] }] });
  }

  async chatWithTools(_options: ChatWithToolsOptions): Promise<ChatResponse> {
    this.toolRound++;
    if (this.toolRound === 1) {
      return {
        text: "Generating file",
        toolUses: [{
          id: "tool-1",
          name: "run_command",
          input: {
            command: "generate report",
            write: true,
            outputs: ["/workspace/generated/report.txt"],
          },
        }],
      };
    }
    return { text: "done", toolUses: [] };
  }
}

class DirectDocumentProvider implements LLMProvider {
  readonly name = "direct-document-test";
  private toolRound = 0;

  constructor(private targetPath: string) {}

  async chat(_options: ChatOptions) {
    return JSON.stringify({ steps: [{ id: "s1", task: "create the document", dependsOn: [], skills: [] }] });
  }

  async chatWithTools(_options: ChatWithToolsOptions): Promise<ChatResponse> {
    this.toolRound++;
    if (this.toolRound === 1) {
      return {
        text: "Creating document",
        toolUses: [{
          id: "tool-1",
          name: "create_document",
          input: {
            path: this.targetPath,
            sections: [{ type: "paragraph", text: "hello" }],
          },
        }],
      };
    }
    return { text: "done", toolUses: [] };
  }
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
        exists: true,
      },
    ]);
    expect((result.result as { events: AppEvent[] }).events.map((event) => event.kind)).toContain("artifact_created");
    expect(streamed.map((event) => event.kind)).toContain("artifact_created");
    expect(runtime.listConversationEvents(conversationId).map((event) => event.kind)).toContain("artifact_created");
    expect(runtime.listConversationEvents(conversationId).map((event) => event.kind)).toContain("file_created");
    expect(runtime.getConversation(conversationId)?.messages).toMatchObject([
      { role: "user", content: "write an artifact", runId: "artifact-run" },
      { role: "assistant", runId: "artifact-run" },
    ]);
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
      exists: true,
    });
    await rm(targetPath);
    expect(runtime.listArtifacts(conversationId).find((item) => item.id === artifact?.id))
      .toMatchObject({ exists: false });
    expect(streamed).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "artifact_attached", conversationId, artifact: expect.objectContaining({ id: artifact?.id }) }),
      expect.objectContaining({ kind: "file_attached", conversationId, artifactId: artifact?.id }),
    ]));
    expect(runtime.listConversationEvents(conversationId).map((event) => event.kind)).toContain("artifact_attached");
  });

  it("records run_command outputs as session artifacts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cowork-runtime-command-artifacts-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    const outputPath = path.join(workspace, "generated", "report.txt");
    const runtime = createCommandRuntime(workspace, outputPath, directory);
    runtimes.push(runtime);
    const created = await runtime.handle({
      id: "create",
      method: "create_conversation",
      params: { workspace, title: "Command outputs" },
    });
    const conversationId = (created.result as { conversation: { id: string } }).conversation.id;

    const result = await runtime.handle({
      id: "run",
      method: "run",
      params: {
        conversationId,
        workspace,
        message: "generate a file",
        runId: "command-artifact-run",
      },
    });

    expect(result.error).toBeUndefined();
    expect(runtime.listArtifacts(conversationId)).toMatchObject([
      {
        conversationId,
        runId: "command-artifact-run",
        kind: "created",
        path: outputPath,
        name: "report.txt",
        fileType: "txt",
        mimeType: "text/plain",
        sizeBytes: 16,
        toolName: "run_command",
      },
    ]);
    expect((result.result as { events: AppEvent[] }).events.map((event) => event.kind)).toContain("artifact_created");
    expect(runtime.listConversationEvents(conversationId).map((event) => event.kind)).toContain("file_created");
  });

  it("records direct document tool outputs as session artifacts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cowork-runtime-document-artifacts-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    const targetPath = path.join(workspace, "summary.docx");
    const runtime = createDirectDocumentRuntime(workspace, targetPath, directory);
    runtimes.push(runtime);
    const created = await runtime.handle({
      id: "create",
      method: "create_conversation",
      params: { workspace, title: "Document output" },
    });
    const conversationId = (created.result as { conversation: { id: string } }).conversation.id;

    const result = await runtime.handle({
      id: "run",
      method: "run",
      params: {
        conversationId,
        workspace,
        message: "create a document",
        runId: "document-artifact-run",
      },
    });

    expect(result.error).toBeUndefined();
    expect(runtime.listArtifacts(conversationId)).toMatchObject([
      {
        conversationId,
        runId: "document-artifact-run",
        kind: "created",
        path: targetPath,
        name: "summary.docx",
        fileType: "docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 13,
        toolName: "create_document",
      },
    ]);
    expect((result.result as { events: AppEvent[] }).events.map((event) => event.kind)).toContain("artifact_created");
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

function createCommandRuntime(workspace: string, outputPath: string, directory: string) {
  const acl = new PermissionACL();
  acl.grantFolder(workspace, { write: "allow" });
  const tools = new ToolRegistry();
  tools.register(commandOutputTool(outputPath));
  return new AppRuntime({
    llm: new CommandOutputProvider(),
    acl,
    audit: new AuditLog(":memory:"),
    store: new WorkspaceStore(":memory:"),
    tools,
    skills: new SkillsLoader(path.join(directory, "skills")),
    extensions: new ExtensionsLoader(path.join(directory, "extensions"), { env: {}, resourceRoot: directory }),
    mcp: new McpManager(path.join(directory, "mcp.json"), tools),
  });
}

function createDirectDocumentRuntime(workspace: string, targetPath: string, directory: string) {
  const acl = new PermissionACL();
  acl.grantFolder(workspace, { write: "allow" });
  const tools = new ToolRegistry();
  tools.register(directDocumentTool(targetPath));
  return new AppRuntime({
    llm: new DirectDocumentProvider(targetPath),
    acl,
    audit: new AuditLog(":memory:"),
    store: new WorkspaceStore(":memory:"),
    tools,
    skills: new SkillsLoader(path.join(directory, "skills")),
    extensions: new ExtensionsLoader(path.join(directory, "extensions"), { env: {}, resourceRoot: directory }),
    mcp: new McpManager(path.join(directory, "mcp.json"), tools),
  });
}

function commandOutputTool(outputPath: string): ToolImpl {
  return {
    name: "run_command",
    description: "Test command output tool",
    input_schema: { type: "object" },
    async execute(_args, ctx) {
      if (!ctx.workspace) throw new Error("workspace missing");
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, "generated report");
      return "generated";
    },
  };
}

function directDocumentTool(targetPath: string): ToolImpl {
  return {
    name: "create_document",
    description: "Test document tool",
    input_schema: { type: "object" },
    async execute() {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, "fake doc data");
      return `Created ${targetPath} (1 sections)`;
    },
  };
}
