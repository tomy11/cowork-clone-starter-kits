import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { ToolRegistry } from "../agent/tools/registry.js";

const ServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().optional(),
  enabled: z.boolean().default(false),
  confirmTools: z.boolean().default(true),
});

const McpConfigSchema = z.object({
  servers: z.record(ServerConfigSchema).default({}),
});

type ServerConfig = z.infer<typeof ServerConfigSchema>;
type Connection = {
  client: Client;
  transport: StdioClientTransport;
  toolNames: string[];
};

export type McpServerStatus = {
  name: string;
  enabled: boolean;
  connected: boolean;
  tools: string[];
  error?: string;
};

export class McpManager {
  private connections = new Map<string, Connection>();
  private errors = new Map<string, string>();

  constructor(
    private configPath: string,
    private registry: ToolRegistry,
  ) {}

  async connectEnabled(workspace?: string): Promise<McpServerStatus[]> {
    const config = await this.loadConfig();
    await Promise.all(Object.entries(config.servers).map(async ([name, server]) => {
      if (!server.enabled || this.connections.has(name)) return;
      try {
        await this.connect(name, workspace);
      } catch (error) {
        this.errors.set(name, error instanceof Error ? error.message : String(error));
      }
    }));
    return this.status();
  }

  async connect(name: string, workspace?: string) {
    if (this.connections.has(name)) return;
    const config = await this.loadConfig();
    const server = config.servers[name];
    if (!server) throw new Error(`Unknown MCP server: ${name}`);

    const expanded = this.expandServerConfig(server, workspace);
    const client = new Client({ name: "cowork-clone", version: "0.2.0" });
    const transport = new StdioClientTransport({
      command: expanded.command,
      args: expanded.args,
      env: { ...getDefaultEnvironment(), ...expanded.env },
      cwd: expanded.cwd,
      stderr: "pipe",
    });
    client.onerror = (error) => this.errors.set(name, error.message);
    client.onclose = () => this.markDisconnected(name);

    await client.connect(transport);
    const response = await client.listTools();
    const toolNames: string[] = [];
    for (const tool of response.tools) {
      const registeredName = `mcp__${sanitizeName(name)}__${sanitizeName(tool.name)}`;
      toolNames.push(registeredName);
      this.registry.register({
        name: registeredName,
        description: `[MCP:${name}] ${tool.description ?? tool.name}`,
        input_schema: tool.inputSchema as Record<string, unknown>,
        requiresConfirmation: server.confirmTools,
        execute: async (args) => {
          const result = await client.callTool({ name: tool.name, arguments: args });
          return normalizeToolResult(result.content);
        },
      });
    }
    this.connections.set(name, { client, transport, toolNames });
    this.errors.delete(name);
  }

  async disconnect(name: string) {
    const connection = this.connections.get(name);
    if (!connection) return;
    this.connections.delete(name);
    for (const toolName of connection.toolNames) this.registry.unregister(toolName);
    await connection.client.close();
  }

  async status(): Promise<McpServerStatus[]> {
    const config = await this.loadConfig();
    return Object.entries(config.servers).map(([name, server]) => ({
      name,
      enabled: server.enabled,
      connected: this.connections.has(name),
      tools: this.connections.get(name)?.toolNames ?? [],
      error: this.errors.get(name),
    }));
  }

  async close() {
    await Promise.all([...this.connections.keys()].map((name) => this.disconnect(name)));
  }

  private async loadConfig() {
    try {
      const raw = await readFile(this.configPath, "utf-8");
      return McpConfigSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: {} };
      throw error;
    }
  }

  private expandServerConfig(server: ServerConfig, workspace?: string): ServerConfig {
    const expand = (value: string) => value.replace(/\$\{([^}]+)\}/g, (_match, variable: string) => {
      if (variable === "workspace") {
        if (!workspace) throw new Error("This MCP server requires an active workspace");
        return path.resolve(workspace);
      }
      return process.env[variable] ?? "";
    });
    return {
      ...server,
      command: expand(server.command),
      args: server.args.map(expand),
      env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, expand(value)])),
      cwd: server.cwd ? expand(server.cwd) : undefined,
    };
  }

  private markDisconnected(name: string) {
    const connection = this.connections.get(name);
    if (!connection) return;
    this.connections.delete(name);
    for (const toolName of connection.toolNames) this.registry.unregister(toolName);
  }
}

function sanitizeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function normalizeToolResult(content: unknown) {
  if (!Array.isArray(content)) return content;
  return content.map((item) => {
    if (typeof item === "object" && item && "text" in item) return String(item.text);
    return JSON.stringify(item);
  }).join("\n");
}
