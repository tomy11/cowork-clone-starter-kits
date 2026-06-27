import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDockerArgs, parseSandboxArgs } from "./sandbox-command.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("sandbox-command", () => {
  it("builds a locked-down Docker command by default", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "cowork-sandbox-"));
    temporaryDirectories.push(workspace);

    const { options, command } = parseSandboxArgs(["--workspace", workspace, "--", "npm", "test"]);
    const args = buildDockerArgs(options, command);
    const realWorkspace = realpathSync(workspace);

    expect(args).toContain("--network");
    expect(args).toContain("none");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop");
    expect(args).toContain("ALL");
    expect(args).toContain("--security-opt");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain(`type=bind,source=${realWorkspace},target=/workspace,readonly`);
    expect(args.slice(-3)).toEqual(["node:22-bookworm-slim", "npm", "test"]);
  });

  it("allows explicit writable workspace and env passthrough", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "cowork-sandbox-"));
    temporaryDirectories.push(workspace);

    const { options, command } = parseSandboxArgs([
      "--workspace",
      workspace,
      "--write",
      "--env",
      "CI=1",
      "--image",
      "node:22",
      "--",
      "npm",
      "run",
      "build",
    ]);
    const args = buildDockerArgs(options, command);
    const realWorkspace = realpathSync(workspace);

    expect(args).not.toContain("--read-only");
    expect(args).toContain(`type=bind,source=${realWorkspace},target=/workspace`);
    expect(args).not.toContain(`type=bind,source=${realWorkspace},target=/workspace,readonly`);
    expect(args).toContain("CI=1");
    expect(args.slice(-4)).toEqual(["node:22", "npm", "run", "build"]);
  });

  it("requires the command separator", () => {
    expect(() => parseSandboxArgs(["npm", "test"])).toThrow("Command is required after --");
  });
});
