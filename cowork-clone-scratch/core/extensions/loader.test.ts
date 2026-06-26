import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionsLoader } from "./loader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ExtensionsLoader", () => {
  it("loads local extension manifests from directories and json files", async () => {
    const { projectRoot, extensionsRoot } = await createProject();
    await writeSkill(path.join(projectRoot, "skills", "webapp-testing"));
    await writeManifest(path.join(projectRoot, "mcp.json"), {
      servers: {
        browser: { command: "browser", enabled: false },
        filesystem: { command: "filesystem", enabled: false },
      },
    });
    await writeManifest(path.join(extensionsRoot, "webapp-testing", "extension.json"), {
      id: "webapp-testing",
      name: "Webapp Testing",
      description: "Browser and UI testing helpers",
      version: "1.2.3",
      resources: {
        skills: ["webapp-testing"],
        mcpServers: ["browser"],
        commands: [
          {
            id: "smoke",
            label: "Smoke test",
            command: "npm test",
            description: "Run focused tests",
            workingDir: ".",
          },
        ],
      },
      setup: {
        requiredEnv: ["PLAYWRIGHT_BROWSERS_PATH"],
        instructions: "Install browser dependencies before use.",
      },
    });
    await writeManifest(path.join(extensionsRoot, "quick.json"), {
      id: "quick",
      name: "Quick Commands",
      enabled: false,
      resources: { mcp: ["filesystem"] },
    });

    const extensions = await new ExtensionsLoader(extensionsRoot, {
      env: { PLAYWRIGHT_BROWSERS_PATH: "/tmp/browsers" },
      resourceRoot: projectRoot,
    }).list();

    expect(extensions.map((extension) => extension.id)).toEqual(["quick", "webapp-testing"]);
    expect(extensions[0]).toMatchObject({
      id: "quick",
      status: "disabled",
      valid: true,
      resources: { skills: [], mcpServers: ["filesystem"], commands: [] },
    });
    expect(extensions[1]).toMatchObject({
      id: "webapp-testing",
      name: "Webapp Testing",
      version: "1.2.3",
      status: "ready",
      setup: { requiredEnv: ["PLAYWRIGHT_BROWSERS_PATH"], missingEnv: [] },
      checks: { ready: true, missingEnv: [], missingResources: [] },
    });
  });

  it("reports setup gaps for missing env vars and local resources", async () => {
    const { projectRoot, extensionsRoot } = await createProject();
    await writeManifest(path.join(projectRoot, "mcp.json"), { servers: {} });
    await writeManifest(path.join(extensionsRoot, "needs-setup", "extension.json"), {
      id: "needs-setup",
      name: "Needs Setup",
      resources: {
        skills: ["missing-skill"],
        mcp: ["missing-server"],
      },
      setup: {
        requiredEnv: ["MISSING_TOKEN"],
      },
    });

    const [extension] = await new ExtensionsLoader(extensionsRoot, {
      env: {},
      resourceRoot: projectRoot,
    }).list();

    expect(extension).toMatchObject({
      id: "needs-setup",
      status: "needs_setup",
      valid: true,
      setup: { missingEnv: ["MISSING_TOKEN"] },
      checks: {
        ready: false,
        missingEnv: ["MISSING_TOKEN"],
      },
    });
    expect(extension.checks.missingResources).toMatchObject([
      { type: "skill", name: "missing-skill", ok: false },
      { type: "mcpServer", name: "missing-server", ok: false },
    ]);
  });

  it("returns invalid manifests with normalized fallback fields and errors", async () => {
    const { extensionsRoot } = await createProject();
    await writeManifest(path.join(extensionsRoot, "broken", "extension.json"), {
      name: "",
      enabled: "yes",
      resources: {
        skills: ["ok", 42],
        commands: [{ id: "missing-command", label: "Missing command" }],
      },
    });

    const [extension] = await new ExtensionsLoader(extensionsRoot, { env: {} }).list();

    expect(extension).toMatchObject({
      id: "broken",
      name: "broken",
      status: "invalid",
      valid: false,
      resources: { skills: ["ok"] },
    });
    expect(extension.errors).toEqual(expect.arrayContaining([
      "id is required",
      "name is required",
      "enabled must be a boolean",
      "resources.skills must contain only non-empty strings",
      "resources.commands entries require id, label, and command",
    ]));
  });

  it("returns an empty list when the extensions root is missing", async () => {
    const root = path.join(await createRoot(), "missing");

    await expect(new ExtensionsLoader(root).list()).resolves.toEqual([]);
  });

  it("keeps the bundled QA workflow extension ready", async () => {
    const projectRoot = process.cwd();
    const extension = await new ExtensionsLoader(path.join(projectRoot, "extensions"), {
      env: {},
      resourceRoot: projectRoot,
    }).get("qa-workflow");

    expect(extension).toMatchObject({
      id: "qa-workflow",
      status: "ready",
      checks: { ready: true, missingEnv: [], missingResources: [] },
      resources: { skills: ["webapp-testing", "test-master"] },
    });
  });
});

async function createRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "cowork-extensions-"));
  temporaryDirectories.push(root);
  return root;
}

async function createProject() {
  const projectRoot = await createRoot();
  const extensionsRoot = path.join(projectRoot, "extensions");
  await mkdir(extensionsRoot, { recursive: true });
  return { projectRoot, extensionsRoot };
}

async function writeManifest(filePath: string, manifest: Record<string, unknown>) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

async function writeSkill(skillPath: string) {
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), "---\nname: test\n---\nUse this skill.\n", "utf-8");
}
