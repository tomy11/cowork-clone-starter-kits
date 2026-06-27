import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PermissionACL } from "./acl.js";

describe("PermissionACL", () => {
  it("allows reads inside a granted folder", async () => {
    const acl = new PermissionACL();
    const folder = path.resolve("/tmp/cowork-project");
    acl.grantFolder(folder);

    const decision = await acl.check("read_file", {
      path: path.join(folder, "notes.md"),
    });

    expect(decision).toMatchObject({ allowed: true, requiresConfirm: false });
  });

  it("requires confirmation for writes by default", async () => {
    const acl = new PermissionACL();
    const folder = path.resolve("/tmp/cowork-project");
    acl.grantFolder(folder);

    const decision = await acl.check("write_file", {
      path: path.join(folder, "notes.md"),
    });

    expect(decision).toMatchObject({ allowed: true, requiresConfirm: true });
  });

  it("recognizes file path aliases and explicit operations", async () => {
    const acl = new PermissionACL();
    const folder = path.resolve("/tmp/cowork-project");
    acl.grantFolder(folder, { write: "allow" });

    const aliasDecision = await acl.check("custom_tool", {
      file_path: path.join(folder, "notes.md"),
      operation: "read",
    });
    const writeAliasDecision = await acl.check("custom_tool", {
      filepath: path.join(folder, "notes.md"),
      operation: "write",
    });

    expect(aliasDecision).toMatchObject({ allowed: true, requiresConfirm: false });
    expect(writeAliasDecision).toMatchObject({ allowed: true, requiresConfirm: false });
  });

  it("denies files outside the granted folder", async () => {
    const acl = new PermissionACL();
    acl.grantFolder(path.resolve("/tmp/cowork-project"));

    const decision = await acl.check("read_file", {
      path: path.resolve("/tmp/other-project/secrets.txt"),
    });

    expect(decision.allowed).toBe(false);
  });

  it("does not confuse a sibling with a matching path prefix", async () => {
    const acl = new PermissionACL();
    acl.grantFolder(path.resolve("/tmp/cowork-project"));

    const decision = await acl.check("read_file", {
      path: path.resolve("/tmp/cowork-project-private/secrets.txt"),
    });

    expect(decision.allowed).toBe(false);
  });

  it("denies parent traversal out of a granted folder", async () => {
    const acl = new PermissionACL();
    const folder = path.resolve("/tmp/cowork-project");
    acl.grantFolder(folder);

    const decision = await acl.check("read_file", {
      path: path.join(folder, "..", "other-project", "secrets.txt"),
    });

    expect(decision.allowed).toBe(false);
  });

  it.skipIf(process.platform === "win32")("denies symlinks that escape a granted folder", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cowork-acl-"));
    const workspace = path.join(directory, "workspace");
    const outside = path.join(directory, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(workspace, "link"));

    const acl = new PermissionACL();
    acl.grantFolder(workspace);
    const readDecision = await acl.check("read_file", { path: path.join(workspace, "link", "secret.txt") });
    const writeDecision = await acl.check("write_file", { path: path.join(workspace, "link", "new.txt") });

    expect(readDecision.allowed).toBe(false);
    expect(writeDecision.allowed).toBe(false);
    await rm(directory, { recursive: true, force: true });
  });
});
