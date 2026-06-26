import * as fs from "node:fs/promises";
import * as path from "node:path";

export type ExtensionStatus = "ready" | "needs_setup" | "disabled" | "invalid";

export type ExtensionCommand = {
  id: string;
  label: string;
  command: string;
  description: string;
  workingDir: string | null;
};

export type ExtensionResources = {
  skills: string[];
  mcpServers: string[];
  commands: ExtensionCommand[];
};

export type ExtensionSetup = {
  requiredEnv: string[];
  missingEnv: string[];
  instructions: string;
};

export type ExtensionResourceCheck = {
  type: "skill" | "mcpServer";
  name: string;
  ok: boolean;
  path: string | null;
  message: string | null;
};

export type ExtensionChecks = {
  ready: boolean;
  missingEnv: string[];
  missingResources: ExtensionResourceCheck[];
  resources: ExtensionResourceCheck[];
};

export type ExtensionManifest = {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  source: "local";
  status: ExtensionStatus;
  valid: boolean;
  errors: string[];
  rootPath: string;
  manifestPath: string;
  resources: ExtensionResources;
  setup: ExtensionSetup;
  checks: ExtensionChecks;
};

type JsonObject = Record<string, unknown>;

type ExtensionsLoaderOptions = {
  env?: Record<string, string | undefined>;
  resourceRoot?: string;
  mcpConfigPath?: string;
};

export class ExtensionsLoader {
  constructor(
    private extensionsRoot: string,
    private options: ExtensionsLoaderOptions = {},
  ) {}

  async list(): Promise<ExtensionManifest[]> {
    const manifestPaths = await this.discoverManifestPaths();
    const manifests = await Promise.all(manifestPaths.map((manifestPath) => this.loadManifestFile(manifestPath)));
    return manifests.sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<ExtensionManifest | null> {
    const manifests = await this.list();
    return manifests.find((manifest) => manifest.id === id) ?? null;
  }

  private async discoverManifestPaths(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.extensionsRoot, { withFileTypes: true });
      const manifestPaths: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const manifestPath = path.join(this.extensionsRoot, entry.name, "extension.json");
          if (await fileExists(manifestPath)) manifestPaths.push(manifestPath);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          manifestPaths.push(path.join(this.extensionsRoot, entry.name));
        }
      }
      return manifestPaths;
    } catch {
      return [];
    }
  }

  private async loadManifestFile(manifestPath: string): Promise<ExtensionManifest> {
    const fallbackId = inferFallbackId(manifestPath);
    let raw: JsonObject = {};
    const errors: string[] = [];
    try {
      const content = await fs.readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(content) as unknown;
      if (isObject(parsed)) raw = parsed;
      else errors.push("Manifest must be a JSON object");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    const id = readRequiredString(raw, "id", fallbackId, errors);
    const name = readRequiredString(raw, "name", id, errors);
    const description = readOptionalString(raw, "description");
    const version = readOptionalString(raw, "version") || "0.0.0";
    const enabled = readEnabled(raw, errors);
    const resources = normalizeResources(raw.resources, errors);
    const setup = normalizeSetup(raw.setup, errors);
    const checks = await this.checkReadiness(path.dirname(manifestPath), resources, setup);
    const valid = errors.length === 0;

    return {
      id,
      name,
      description,
      version,
      enabled,
      source: "local",
      status: resolveStatus(valid, enabled, checks),
      valid,
      errors,
      rootPath: path.dirname(manifestPath),
      manifestPath,
      resources,
      setup: { ...setup, missingEnv: checks.missingEnv },
      checks,
    };
  }

  private async checkReadiness(
    manifestRoot: string,
    resources: ExtensionResources,
    setup: ExtensionSetup,
  ): Promise<ExtensionChecks> {
    const env = this.options.env ?? process.env;
    const missingEnv = setup.requiredEnv.filter((name) => {
      const value = env[name];
      return value === undefined || value === "";
    });
    const resourceChecks = [
      ...await Promise.all(resources.skills.map((name) => this.checkSkillResource(manifestRoot, name))),
      ...await Promise.all(resources.mcpServers.map((name) => this.checkMcpResource(name))),
    ];
    const missingResources = resourceChecks.filter((check) => !check.ok);
    return {
      ready: missingEnv.length === 0 && missingResources.length === 0,
      missingEnv,
      missingResources,
      resources: resourceChecks,
    };
  }

  private async checkSkillResource(manifestRoot: string, name: string): Promise<ExtensionResourceCheck> {
    const candidates = uniquePaths(skillCandidates(name, manifestRoot, this.resourceRoot()));
    for (const candidate of candidates) {
      if (await skillExists(candidate)) {
        return { type: "skill", name, ok: true, path: candidate, message: null };
      }
    }
    return {
      type: "skill",
      name,
      ok: false,
      path: null,
      message: "Skill resource not found",
    };
  }

  private async checkMcpResource(name: string): Promise<ExtensionResourceCheck> {
    const servers = await this.readMcpServerNames();
    if (servers.has(name)) {
      return { type: "mcpServer", name, ok: true, path: this.mcpConfigPath(), message: null };
    }
    return {
      type: "mcpServer",
      name,
      ok: false,
      path: this.mcpConfigPath(),
      message: "MCP server not found in mcp.json",
    };
  }

  private async readMcpServerNames(): Promise<Set<string>> {
    try {
      const raw = await fs.readFile(this.mcpConfigPath(), "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isObject(parsed) || !isObject(parsed.servers)) return new Set();
      return new Set(Object.keys(parsed.servers));
    } catch {
      return new Set();
    }
  }

  private resourceRoot() {
    return this.options.resourceRoot ?? path.dirname(this.extensionsRoot);
  }

  private mcpConfigPath() {
    return this.options.mcpConfigPath ?? path.join(this.resourceRoot(), "mcp.json");
  }
}

function inferFallbackId(manifestPath: string) {
  const basename = path.basename(manifestPath);
  if (basename === "extension.json") return path.basename(path.dirname(manifestPath));
  return basename.replace(/\.json$/i, "");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(filePath: string) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function skillExists(candidate: string) {
  if (path.basename(candidate) === "SKILL.md") return pathExists(candidate);
  return pathExists(path.join(candidate, "SKILL.md"));
}

function skillCandidates(name: string, manifestRoot: string, resourceRoot: string) {
  if (path.isAbsolute(name)) return [name];
  return [
    path.join(manifestRoot, name),
    path.join(resourceRoot, name),
    path.join(resourceRoot, "skills", name),
  ];
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.map((item) => path.normalize(item)))];
}

function resolveStatus(valid: boolean, enabled: boolean, checks: ExtensionChecks): ExtensionStatus {
  if (!valid) return "invalid";
  if (!enabled) return "disabled";
  return checks.ready ? "ready" : "needs_setup";
}

function readRequiredString(raw: JsonObject, key: string, fallback: string, errors: string[]) {
  const value = raw[key];
  if (typeof value === "string" && value.trim()) {
    const normalized = value.trim();
    if (key === "id" && !/^[a-zA-Z0-9._-]+$/.test(normalized)) {
      errors.push("id may only contain letters, numbers, dots, underscores, and dashes");
    }
    return normalized;
  }
  errors.push(`${key} is required`);
  return fallback;
}

function readOptionalString(raw: JsonObject, key: string) {
  const value = raw[key];
  return typeof value === "string" ? value.trim() : "";
}

function readEnabled(raw: JsonObject, errors: string[]) {
  if (raw.enabled === undefined) return true;
  if (typeof raw.enabled === "boolean") return raw.enabled;
  errors.push("enabled must be a boolean");
  return true;
}

function normalizeResources(value: unknown, errors: string[]): ExtensionResources {
  const raw = isObject(value) ? value : {};
  if (value !== undefined && !isObject(value)) errors.push("resources must be an object");
  return {
    skills: normalizeStringArray(raw.skills, "resources.skills", errors),
    mcpServers: normalizeStringArray(raw.mcpServers ?? raw.mcp, "resources.mcpServers", errors),
    commands: normalizeCommands(raw.commands, errors),
  };
}

function normalizeSetup(value: unknown, errors: string[]): ExtensionSetup {
  const raw = isObject(value) ? value : {};
  if (value !== undefined && !isObject(value)) errors.push("setup must be an object");
  return {
    requiredEnv: normalizeStringArray(raw.requiredEnv, "setup.requiredEnv", errors),
    missingEnv: [],
    instructions: typeof raw.instructions === "string" ? raw.instructions.trim() : "",
  };
}

function normalizeStringArray(value: unknown, label: string, errors: string[]) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      result.push(item.trim());
    } else {
      errors.push(`${label} must contain only non-empty strings`);
    }
  }
  return result;
}

function normalizeCommands(value: unknown, errors: string[]) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push("resources.commands must be an array");
    return [];
  }

  const commands: ExtensionCommand[] = [];
  for (const item of value) {
    if (!isObject(item)) {
      errors.push("resources.commands must contain command objects");
      continue;
    }
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const command = typeof item.command === "string" ? item.command.trim() : "";
    if (!id || !label || !command) {
      errors.push("resources.commands entries require id, label, and command");
      continue;
    }
    commands.push({
      id,
      label,
      command,
      description: typeof item.description === "string" ? item.description.trim() : "",
      workingDir: typeof item.workingDir === "string" && item.workingDir.trim() ? item.workingDir.trim() : null,
    });
  }
  return commands;
}
