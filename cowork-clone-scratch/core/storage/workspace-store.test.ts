import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "./workspace-store.js";

describe("WorkspaceStore", () => {
  it("persists workspaces and conversation messages", () => {
    const store = new WorkspaceStore(":memory:");
    store.grantWorkspace("/tmp/example-workspace");
    const conversationId = store.ensureConversation("/tmp/example-workspace", "Plan this project");
    store.addMessage(conversationId, "user", "Plan this project");
    store.addMessage(conversationId, "assistant", "Here is the plan");

    expect(store.listWorkspaces()).toEqual(["/tmp/example-workspace"]);
    expect(store.latestConversation("/tmp/example-workspace")).toMatchObject({
      id: conversationId,
      title: "Plan this project",
      messages: [
        { role: "user", content: "Plan this project" },
        { role: "assistant", content: "Here is the plan" },
      ],
    });
    store.close();
  });

  it("renames, archives, and deletes conversations", () => {
    const store = new WorkspaceStore(":memory:");
    store.grantWorkspace("/tmp/example-workspace");
    const first = store.ensureConversation("/tmp/example-workspace", "First task");
    const second = store.ensureConversation("/tmp/example-workspace", "Second task");

    expect(store.renameConversation(first, "Renamed task")?.title).toBe("Renamed task");
    expect(store.archiveConversation(first, true)?.archived).toBe(true);
    expect(store.listConversations("/tmp/example-workspace").map((session) => session.id)).toEqual([second]);
    expect(store.listConversations("/tmp/example-workspace", { includeArchived: true }).map((session) => session.id)).toContain(first);
    expect(store.deleteConversation(second)).toBe(true);
    expect(store.getConversation(second)).toBeNull();
    store.close();
  });
});
