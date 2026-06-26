import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "./workspace-store.js";

describe("WorkspaceStore", () => {
  it("persists workspaces and conversation messages", () => {
    const store = new WorkspaceStore(":memory:");
    store.grantWorkspace("/tmp/example-workspace");
    const provider = store.createProviderProfile({
      type: "mock",
      name: "Mock",
      model: "mock",
    });
    const conversationId = store.ensureConversation("/tmp/example-workspace", "Plan this project", undefined, {
      providerProfileId: provider.id,
      model: "mock",
    });
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
      providerProfileId: provider.id,
      model: "mock",
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

  it("manages provider profiles and default selection", () => {
    const store = new WorkspaceStore(":memory:");
    const claude = store.createProviderProfile({
      type: "claude",
      name: "Claude",
      model: "claude-sonnet-4-5",
      apiKey: "anthropic-key",
    });
    const ollama = store.createProviderProfile({
      type: "ollama",
      name: "Local Ollama",
      model: "llama3.2",
      baseUrl: "http://localhost:11434/v1",
    });

    expect(claude).toMatchObject({ type: "claude", hasApiKey: true, isDefault: true });
    expect(store.getProviderProfileWithSecret(claude.id)?.apiKey).toBe("anthropic-key");
    expect(store.setDefaultProviderProfile(ollama.id)?.isDefault).toBe(true);
    expect(store.getDefaultProviderProfile()?.id).toBe(ollama.id);

    const updated = store.updateProviderProfile(ollama.id, { name: "Ollama", model: "qwen2.5" });
    expect(updated).toMatchObject({ name: "Ollama", model: "qwen2.5", isDefault: true });

    expect(store.deleteProviderProfile(ollama.id)).toBe(true);
    expect(store.getDefaultProviderProfile()?.id).toBe(claude.id);
    expect(store.listProviderProfiles()).toHaveLength(1);
    store.close();
  });
});
