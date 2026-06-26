import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "./agent/tools/registry.js";
import { ExtensionsLoader } from "./extensions/loader.js";
import { MockProvider } from "./llm/mock.js";
import { McpManager } from "./mcp/manager.js";
import { AuditLog } from "./permissions/audit.js";
import { PermissionACL } from "./permissions/acl.js";
import { AppRuntime } from "./runtime.js";
import { SkillsLoader } from "./skills/loader.js";
import { WorkspaceStore } from "./storage/workspace-store.js";

const temporaryDirectories: string[] = [];
const runtimes: AppRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("runtime extension skills", () => {
  it("adds ready extension skills to the runtime skill catalog", async () => {
    const { directory, runtime } = await createRuntime();
    await writeSkill(path.join(directory, "skills", "base-skill"), "base-skill", "Base skill", "Base instructions.");
    await writeSkill(
      path.join(directory, "extensions", "webapp", "skills", "webapp-testing"),
      "webapp-testing",
      "Webapp Testing",
      "Always test the UI.",
    );
    await writeManifest(path.join(directory, "extensions", "webapp", "extension.json"), {
      id: "webapp",
      name: "Webapp",
      resources: { skills: ["skills/webapp-testing"] },
    });

    const listed = await runtime.handle({ id: "1", method: "list_skills", params: {} });
    expect(listed.result).toMatchObject({
      skills: [
        { name: "base-skill", description: "Base skill" },
        { name: "webapp-testing", description: "Webapp Testing" },
      ],
    });

    const loaded = await runtime.handle({ id: "2", method: "load_skill", params: { name: "webapp-testing" } });
    expect(loaded.result).toMatchObject({
      skill: {
        name: "webapp-testing",
        instructions: "Always test the UI.\n",
      },
    });
  });

  it("does not inject extension skills until setup is ready", async () => {
    const { directory, runtime } = await createRuntime();
    await writeSkill(
      path.join(directory, "extensions", "blocked", "skills", "blocked-skill"),
      "blocked-skill",
      "Blocked skill",
      "Needs setup.",
    );
    await writeManifest(path.join(directory, "extensions", "blocked", "extension.json"), {
      id: "blocked",
      name: "Blocked",
      resources: { skills: ["skills/blocked-skill"] },
      setup: { requiredEnv: ["BLOCKED_TOKEN"] },
    });

    const listed = await runtime.handle({ id: "1", method: "list_skills", params: {} });
    expect(listed.result).toEqual({ skills: [] });
  });
});

async function createRuntime() {
  const directory = await mkdtemp(path.join(tmpdir(), "cowork-runtime-extensions-"));
  temporaryDirectories.push(directory);
  const runtime = new AppRuntime({
    llm: new MockProvider(),
    acl: new PermissionACL(),
    audit: new AuditLog(":memory:"),
    store: new WorkspaceStore(":memory:"),
    tools: new ToolRegistry(),
    skills: new SkillsLoader(path.join(directory, "skills")),
    extensions: new ExtensionsLoader(path.join(directory, "extensions"), { env: {}, resourceRoot: directory }),
    mcp: new McpManager(path.join(directory, "mcp.json"), new ToolRegistry()),
  });
  runtimes.push(runtime);
  return { directory, runtime };
}

async function writeSkill(skillPath: string, name: string, description: string, instructions: string) {
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    path.join(skillPath, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${instructions}\n`,
    "utf-8",
  );
}

async function writeManifest(filePath: string, manifest: Record<string, unknown>) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}
