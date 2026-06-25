import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionACL } from "../permissions/acl.js";
import { ToolRegistry } from "../agent/tools/registry.js";
import { McpManager } from "./manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("McpManager", () => {
  it("connects to a stdio server, discovers tools, and calls them", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cowork-mcp-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "mcp.json");
    const serverPath = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
    await writeFile(configPath, JSON.stringify({
      servers: {
        echo: {
          command: process.execPath,
          args: [serverPath],
          enabled: true,
          confirmTools: false,
        },
      },
    }));

    const registry = new ToolRegistry();
    const manager = new McpManager(configPath, registry);
    const statuses = await manager.connectEnabled("/tmp/workspace");
    expect(statuses).toMatchObject([{ name: "echo", connected: true }]);

    const result = await registry.get("mcp__echo__echo").execute(
      { text: "hello" },
      { agentId: "test", acl: new PermissionACL() },
    );
    expect(result).toBe("echo:hello");
    await manager.close();
  }, 15_000);
});
