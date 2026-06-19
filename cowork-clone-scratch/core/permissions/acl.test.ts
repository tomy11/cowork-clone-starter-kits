import { describe, expect, it } from "vitest";
import * as path from "node:path";
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
});
