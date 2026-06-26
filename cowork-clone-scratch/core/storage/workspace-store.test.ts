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
    expect(store.listWorkspaceMetadata()).toMatchObject([
      {
        path: "/tmp/example-workspace",
        name: "example-workspace",
        activeConversationId: conversationId,
        sessionCount: 1,
        archivedSessionCount: 0,
      },
    ]);
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

  it("stores replayable events and active conversations", () => {
    const store = new WorkspaceStore(":memory:");
    store.grantWorkspace("/tmp/example-workspace");
    const first = store.ensureConversation("/tmp/example-workspace", "First task");
    const second = store.ensureConversation("/tmp/example-workspace", "Second task");

    expect(store.getActiveConversation("/tmp/example-workspace")?.id).toBe(second);
    expect(store.setActiveConversation("/tmp/example-workspace", first)).toBe(true);
    expect(store.getActiveConversation("/tmp/example-workspace")?.id).toBe(first);

    store.addEvent(first, { kind: "run_started", runId: "run-1", conversationId: first });
    store.addEvent(first, { kind: "final", runId: "run-1", conversationId: first, content: "Done" });

    const events = store.listEvents(first);
    expect(events.map((event) => event.kind)).toEqual(["run_started", "final"]);
    expect(events[1].event).toMatchObject({ kind: "final", content: "Done" });
    expect(store.listEvents(first, { afterId: events[0].id }).map((event) => event.kind)).toEqual(["final"]);

    expect(store.archiveConversation(first, true)?.archived).toBe(true);
    expect(store.getActiveConversation("/tmp/example-workspace")?.id).toBe(second);
    store.close();
  });
});
