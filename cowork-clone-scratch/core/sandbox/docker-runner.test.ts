import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDockerSandboxArgs } from "./docker-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("docker sandbox runner", () => {
  it("builds a locked-down read-only Docker command by default", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "cowork-docker-runner-"));
    temporaryDirectories.push(workspace);
    const args = buildDockerSandboxArgs({ workspace, command: ["npm", "test"] });
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

  it("allows an explicit writable workspace and sandbox workdir", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "cowork-docker-runner-"));
    temporaryDirectories.push(workspace);
    const args = buildDockerSandboxArgs({
      workspace,
      command: ["sh", "-c", "echo ok"],
      write: true,
      workdir: "/workspace/reports",
      network: "bridge",
      env: ["CI=1"],
    });
    const realWorkspace = realpathSync(workspace);

    expect(args).not.toContain("--read-only");
    expect(args).toContain("bridge");
    expect(args).toContain("/workspace/reports");
    expect(args).toContain(`type=bind,source=${realWorkspace},target=/workspace`);
    expect(args).toContain("CI=1");
    expect(args.slice(-4)).toEqual(["node:22-bookworm-slim", "sh", "-c", "echo ok"]);
  });
});
