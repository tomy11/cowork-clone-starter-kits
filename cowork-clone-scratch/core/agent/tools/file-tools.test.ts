import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionACL } from "../../permissions/acl.js";
import { builtInFileTools } from "./file-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("built-in file tools", () => {
  it("rejects generated document helper scripts in the workspace", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "cowork-file-tools-"));
    temporaryDirectories.push(workspace);
    const writeFile = builtInFileTools.find((tool) => tool.name === "write_file");
    if (!writeFile) throw new Error("write_file tool missing");

    const acl = new PermissionACL();
    acl.grantFolder(workspace, { write: "allow" });

    await expect(writeFile.execute({
      path: path.join(workspace, "setup_and_generate.py"),
      content: "print('create report')",
    }, {
      agentId: "test",
      acl,
    })).rejects.toThrow("Refusing to create helper script");

    await expect(writeFile.execute({
      path: path.join(workspace, "run.sh"),
      content: "python3 -m pip install reportlab\npython3 -c 'generate pdf'",
    }, {
      agentId: "test",
      acl,
    })).rejects.toThrow("Refusing to create run.sh");
  });

  it("still allows user-requested source files that are not generated document helpers", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "cowork-file-tools-"));
    temporaryDirectories.push(workspace);
    const writeFile = builtInFileTools.find((tool) => tool.name === "write_file");
    if (!writeFile) throw new Error("write_file tool missing");

    const acl = new PermissionACL();
    acl.grantFolder(workspace, { write: "allow" });
    const target = path.join(workspace, "hello.py");

    await writeFile.execute({
      path: target,
      content: "print('hello')\n",
    }, {
      agentId: "test",
      acl,
    });

    await expect(readFile(target, "utf-8")).resolves.toBe("print('hello')\n");
  });
});
