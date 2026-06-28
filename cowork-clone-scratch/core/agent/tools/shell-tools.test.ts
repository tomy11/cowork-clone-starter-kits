import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionACL } from "../../permissions/acl.js";
import { runDockerSandbox } from "../../sandbox/docker-runner.js";
import { builtInShellTools } from "./shell-tools.js";

vi.mock("../../sandbox/docker-runner.js", () => ({
  runDockerSandbox: vi.fn(async () => ({
    stdout: "created\n",
    stderr: "",
    command: "docker run ...",
  })),
}));

const temporaryDirectories: string[] = [];
const runDockerSandboxMock = vi.mocked(runDockerSandbox);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

beforeEach(() => {
  runDockerSandboxMock.mockClear();
});

describe("run_command tool", () => {
  it("requires a runtime workspace instead of falling back to the host", async () => {
    const tool = shellTool();
    const acl = new PermissionACL();

    await expect(tool.execute({
      command: "echo unsafe",
    }, {
      agentId: "test",
      acl,
      confirmationApproved: true,
    })).rejects.toThrow("refusing to run command on the host");

    expect(runDockerSandboxMock).not.toHaveBeenCalled();
  });

  it("runs commands through the Docker sandbox with the workspace mounted at /workspace", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "cowork-shell-tools-"));
    temporaryDirectories.push(workspace);
    const acl = new PermissionACL();
    acl.grantFolder(workspace, { write: "allow" });
    const tool = shellTool();

    await expect(tool.execute({
      command: "python3 -c \"open('/workspace/report.txt','w').write('ok')\"",
      cwd: path.join(workspace, "reports"),
      write: true,
      timeout: 5,
    }, {
      agentId: "test",
      acl,
      confirmationApproved: true,
      workspace,
    })).resolves.toBe("created");

    expect(runDockerSandboxMock).toHaveBeenCalledWith(expect.objectContaining({
      workspace,
      command: ["sh", "-c", "python3 -c \"open('/workspace/report.txt','w').write('ok')\""],
      workdir: "/workspace/reports",
      write: true,
      network: "none",
      timeoutMs: 5000,
    }));
  });
});

function shellTool() {
  const tool = builtInShellTools.find((candidate) => candidate.name === "run_command");
  if (!tool) throw new Error("run_command tool missing");
  return tool;
}
