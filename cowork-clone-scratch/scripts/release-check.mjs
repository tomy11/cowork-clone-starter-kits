#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { argv, cwd, exit } from "node:process";
import YAML from "yaml";

const DEFAULT_ROOT = cwd();

export function runReleaseChecks(root = DEFAULT_ROOT) {
  const failures = [];
  const packageJson = readJson(path.join(root, "package.json"), failures);
  const tauriConfig = readJson(path.join(root, "src-tauri", "tauri.conf.json"), failures);
  const releaseWorkflow = readYaml(path.join(root, "..", ".github", "workflows", "release-build.yml"), failures);
  const ciWorkflow = readYaml(path.join(root, "..", ".github", "workflows", "ci.yml"), failures);

  if (packageJson && tauriConfig) {
    if (packageJson.version !== tauriConfig.version) {
      failures.push(`Version mismatch: package.json=${packageJson.version}, tauri.conf.json=${tauriConfig.version}`);
    }
  }

  if (packageJson) {
    requireScript(packageJson, "test:smoke", failures);
    requireScript(packageJson, "sandbox", failures);
    requireScript(packageJson, "tauri:build", failures);
  }

  if (tauriConfig) {
    if (tauriConfig.bundle?.active !== true) failures.push("Tauri bundle.active must be true");
    if (!tauriConfig.bundle?.externalBin?.includes("binaries/cowork-sidecar")) {
      failures.push("Tauri bundle.externalBin must include binaries/cowork-sidecar");
    }
    const resources = tauriConfig.bundle?.resources ?? {};
    if (!("../skills/" in resources)) failures.push("Tauri bundle.resources must include ../skills/");
    if (!("../mcp.json" in resources)) failures.push("Tauri bundle.resources must include ../mcp.json");
  }

  for (const filePath of ["RELEASE.md", "SANDBOX.md", "SECURITY.md", "SERVER.md"]) {
    if (!existsSync(path.join(root, filePath))) failures.push(`Missing ${filePath}`);
  }

  if (releaseWorkflow) {
    const tags = releaseWorkflow.on?.push?.tags ?? [];
    if (!Array.isArray(tags) || !tags.includes("v*")) failures.push("release-build workflow must run on v* tags");
    const steps = releaseWorkflow.jobs?.bundle?.steps ?? [];
    requireWorkflowRun(steps, "npm run release:check", failures, "release-build");
    requireWorkflowRun(steps, "npm run test:smoke", failures, "release-build");
    if (!steps.some((step) => step.uses === "softprops/action-gh-release@v2")) {
      failures.push("release-build workflow must publish draft GitHub releases");
    }
  }

  if (ciWorkflow) {
    const steps = ciWorkflow.jobs?.test?.steps ?? [];
    requireWorkflowRun(steps, "npm run release:check", failures, "ci");
    requireWorkflowRun(steps, "npm run test:smoke", failures, "ci");
  }

  return failures;
}

function requireScript(packageJson, name, failures) {
  if (!packageJson.scripts?.[name]) failures.push(`package.json missing script: ${name}`);
}

function requireWorkflowRun(steps, command, failures, workflowName) {
  if (!steps.some((step) => step.run === command)) {
    failures.push(`${workflowName} workflow missing: ${command}`);
  }
}

function readJson(filePath, failures) {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (error) {
    failures.push(`Could not read JSON ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function readYaml(filePath, failures) {
  try {
    return YAML.parse(readFileSync(filePath, "utf-8"));
  } catch (error) {
    failures.push(`Could not read YAML ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function main() {
  const root = argv[2] ? path.resolve(argv[2]) : DEFAULT_ROOT;
  const failures = runReleaseChecks(root);
  if (failures.length > 0) {
    console.error("Release preflight failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    exit(1);
  }
  console.log("Release preflight passed");
}

if (import.meta.url === `file://${argv[1]}`) {
  main();
}
