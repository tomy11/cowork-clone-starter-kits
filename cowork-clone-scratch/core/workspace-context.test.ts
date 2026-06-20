import { describe, expect, it } from "vitest";
import { withWorkspaceContext } from "./workspace-context.js";

describe("withWorkspaceContext", () => {
  it("adds the selected workspace to the agent task", () => {
    const result = withWorkspaceContext(
      "เขียนเอกสารเทสหน้า login ให้หน่อย",
      "/Users/example/project",
    );

    expect(result).toContain("Workspace root: /Users/example/project");
    expect(result).toContain("This folder is already granted");
    expect(result).toContain("User request: เขียนเอกสารเทสหน้า login ให้หน่อย");
  });

  it("keeps the original message when no workspace is selected", () => {
    expect(withWorkspaceContext("hello", undefined)).toBe("hello");
  });
});
