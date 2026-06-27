import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Icon, type IconName } from "./Icon";
import type {
  AgentEvent,
  ArtifactPreviewResult,
  ArtifactSummary,
  LocalApiClient,
  Message,
  ProviderProfile,
  SessionSummary,
} from "../lib/local-api";

type BridgeEvent = { requestId: string; event: AgentEvent };
type Confirmation = {
  id: string;
  prompt: string;
  tool: string | null;
  agentId: string | null;
  args: Record<string, unknown> | null;
};
type AgentProgress = {
  id: string;
  task: string;
  status: "pending" | "running" | "done" | "failed";
  detail?: string;
  skills: string[];
};
type Props = {
  folder: string | null;
  sessionId: string | null;
  resumeLatest: boolean;
  localApi: LocalApiClient | null;
  focusFilesKey?: number;
  providers: ProviderProfile[];
  selectedProviderId: string | null;
  onSelectProvider: (providerId: string | null) => void;
  onGrantWorkspace: () => void;
  onOpenProviderSettings: () => void;
  onSessionCreated?: (session: SessionSummary) => void;
};

export function Chat({
  folder,
  sessionId,
  resumeLatest,
  localApi,
  focusFilesKey = 0,
  providers,
  selectedProviderId,
  onSelectProvider,
  onGrantWorkspace,
  onOpenProviderSettings,
  onSessionCreated,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [agents, setAgents] = useState<Record<string, AgentProgress>>({});
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreviewResult | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeRunId = useRef<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const hasConversation = messages.length > 0 || Boolean(conversationId);
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId && provider.enabled) ?? null;

  useEffect(() => {
    let disposed = false;
    void listen<BridgeEvent>("agent-event", ({ payload }) => {
      const event = payload.event;
      if (disposed || !activeRunId.current || event.runId !== activeRunId.current) return;
      setEvents((current) => [...current, event]);
      dispatchEvent(event);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else cleanupListener.current = unlisten;
    });

    return () => {
      disposed = true;
      cleanupListener.current?.();
      cleanupListener.current = null;
    };
  }, []);

  const cleanupListener = useRef<null | (() => void)>(null);

  useEffect(() => () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  useEffect(() => {
    let disposed = false;
    setMessages([]);
    setConversationId(null);
    setEvents([]);
    setAgents({});
    setArtifacts([]);
    setArtifactPreview(null);
    setPreviewLoadingId(null);
    if (!folder || !localApi) return () => { disposed = true; };

    const loader = sessionId
      ? localApi.getSession(sessionId)
      : resumeLatest
        ? localApi.activeSession(folder)
        : Promise.resolve(null);

    loader
      .then(async (session) => {
        if (disposed) return;
        if (session) {
          const replayed = await localApi.listSessionEvents(session.id);
          const sessionArtifacts = await localApi.listArtifacts(session.id);
          if (disposed) return;
          setConversationId(session.id);
          setMessages(session.messages);
          setArtifacts(sessionArtifacts);
          if (session.providerProfileId) onSelectProvider(session.providerProfileId);
          replayEvents(replayed.map((entry) => entry.event));
        }
      })
      .catch((error) => {
        if (!disposed) console.error("Failed to load conversation", error);
      });
    return () => { disposed = true; };
  }, [folder, sessionId, resumeLatest, localApi]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, events]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [folder]);

  useEffect(() => {
    if (filesRef.current) {
      filesRef.current.scrollIntoView({ block: "start", behavior: "smooth" });
    } else {
      inputRef.current?.focus();
    }
  }, [focusFilesKey]);

  function applyAgentEvent(event: AgentEvent) {
    if (event.kind === "plan" && Array.isArray(event.steps)) {
      const planned: Record<string, AgentProgress> = {};
      for (const rawStep of event.steps) {
        const step = rawStep as Record<string, unknown>;
        if (typeof step.id !== "string" || typeof step.task !== "string") continue;
        planned[step.id] = {
          id: step.id,
          task: step.task,
          status: "pending",
          skills: Array.isArray(step.skills) ? step.skills.filter((value): value is string => typeof value === "string") : [],
        };
      }
      setAgents(planned);
      return;
    }

    if (typeof event.id !== "string") return;
    const id = event.id;
    setAgents((current) => {
      const previous = current[id] ?? { id, task: "Agent task", status: "pending", skills: [] };
      if (event.kind === "subagent_spawned") {
        return { ...current, [id]: { ...previous, task: typeof event.task === "string" ? event.task : previous.task, status: "running" } };
      }
      if (event.kind === "subagent_progress") {
        return { ...current, [id]: { ...previous, status: "running", detail: typeof event.content === "string" ? event.content : previous.detail } };
      }
      if (event.kind === "skill_activated" && typeof event.skill === "string") {
        return { ...current, [id]: { ...previous, skills: [...new Set([...previous.skills, event.skill])] } };
      }
      if (event.kind === "tool_call" && typeof event.name === "string") {
        return { ...current, [id]: { ...previous, status: "running", detail: `Using ${event.name}` } };
      }
      if (event.kind === "subagent_done") {
        const result = event.result as { success?: boolean } | undefined;
        return { ...current, [id]: { ...previous, status: result?.success ? "done" : "failed" } };
      }
      return current;
    });
  }

  function dispatchEvent(event: AgentEvent) {
    applyAgentEvent(event);
    applyArtifactEvent(event);
    if (event.kind === "final" && typeof event.content === "string") {
      const content = event.content;
      setMessages((current) => [...current, { role: "assistant", content }]);
    } else if (event.kind === "confirmation_requested") {
      setConfirmation(confirmationFromEvent(event));
    } else if (event.kind === "confirmation_resolved") {
      setConfirmation(null);
    }
  }

  function handleAgentEvent(event: AgentEvent) {
    if (!activeRunId.current || event.runId !== activeRunId.current) return;
    setEvents((current) => [...current, event]);
    dispatchEvent(event);
  }

  function replayEvents(replayed: AgentEvent[]) {
    setEvents(replayed);
    setConfirmation(null);
    for (const event of replayed) dispatchEvent(event);
  }

  async function ensureHttpSession(title: string) {
    if (!folder || !localApi) throw new Error("Local API is not ready");
    if (conversationId) return conversationId;
    const session = await localApi.createSession(folder, title, {
      providerProfileId: selectedProvider?.id ?? null,
      model: selectedProvider?.model ?? null,
    });
    setConversationId(session.id);
    setArtifacts([]);
    onSessionCreated?.(session);
    return session.id;
  }

  async function sendViaHttp(content: string, runId: string) {
    if (!folder || !localApi) throw new Error("Local API is not ready");
    const sessionId = await ensureHttpSession(content);
    eventSourceRef.current?.close();
    eventSourceRef.current = localApi.openSessionEvents(sessionId, handleAgentEvent);
    await waitForEventSourceOpen(eventSourceRef.current);
    const result = await localApi.sendMessage(sessionId, {
      message: content,
      workspace: folder,
      runId,
      providerProfileId: selectedProvider?.id ?? null,
      model: selectedProvider?.model ?? null,
    });
    setConversationId(result.conversationId);
    if (result.status === "cancelled") {
      setMessages((current) => [...current, { role: "assistant", content: "Task cancelled." }]);
    }
  }

  async function sendViaRpc(content: string, runId: string) {
    const result = await invoke<{
      events: AgentEvent[];
      runId: string;
      conversationId: string;
      status: string;
    }>("run", {
      message: content,
      history: messages,
      workspace: folder,
      runId,
      conversationId,
      providerProfileId: selectedProvider?.id ?? null,
      model: selectedProvider?.model ?? null,
    });
    setConversationId(result.conversationId);
    if (result.status === "cancelled") {
      setMessages((current) => [...current, { role: "assistant", content: "Task cancelled." }]);
    }
  }

  async function send(contentOverride?: string) {
    const content = (contentOverride ?? input).trim();
    if (!content || running || !folder) return;
    const isRetry = contentOverride !== undefined;

    const runId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    activeRunId.current = runId;
    setMessages((current) => [...current, { role: "user", content }]);
    if (!isRetry) setInput("");
    setRunning(true);
    setEvents([]);
    setAgents({});

    try {
      if (localApi) await sendViaHttp(content, runId);
      else await sendViaRpc(content, runId);
    } catch (error) {
      setMessages((current) => [
        ...current,
        { role: "assistant", content: `Unable to complete this task: ${String(error)}` },
      ]);
    } finally {
      activeRunId.current = null;
      setRunning(false);
      setConfirmation(null);
    }
  }

  async function copyMessage(content: string) {
    try {
      await navigator.clipboard.writeText(content);
    } catch (error) {
      console.error("Unable to copy message", error);
    }
  }

  function editMessage(content: string) {
    setInput(content);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function cancelRun() {
    if (!activeRunId.current) return;
    if (localApi) {
      await localApi.cancelRun(activeRunId.current);
    } else {
      await invoke("call_sidecar", {
        method: "cancel_run",
        params: { runId: activeRunId.current },
      });
    }
  }

  async function respondToConfirmation(approved: boolean) {
    if (!confirmation) return;
    const id = confirmation.id;
    setConfirmation(null);
    if (localApi) {
      await localApi.respondApproval(id, approved);
    } else {
      await invoke("call_sidecar", {
        method: "respond_confirmation",
        params: { confirmationId: id, approved },
      });
    }
  }

  async function attachFile() {
    if (!localApi || !conversationId) return;
    try {
      const selected = await open({ multiple: false, directory: false });
      const filePath = Array.isArray(selected) ? selected[0] : selected;
      if (!filePath) return;
      const artifact = await localApi.attachArtifact(conversationId, filePath);
      setArtifacts((current) => upsertArtifact(current, artifact));
    } catch (error) {
      setMessages((current) => [
        ...current,
        { role: "assistant", content: `Unable to attach file: ${error instanceof Error ? error.message : String(error)}` },
      ]);
    }
  }

  async function previewArtifact(artifact: ArtifactSummary) {
    if (!localApi) return;
    setPreviewLoadingId(artifact.id);
    try {
      setArtifactPreview(await localApi.previewArtifact(artifact.id));
    } catch (error) {
      addAssistantError("Unable to preview file", error);
    } finally {
      setPreviewLoadingId(null);
    }
  }

  async function openArtifact(artifact: ArtifactSummary) {
    try {
      await invoke("open_path", { path: artifact.path });
    } catch (error) {
      addAssistantError("Unable to open file", error);
    }
  }

  async function revealArtifact(artifact: ArtifactSummary) {
    try {
      await invoke("reveal_path", { path: artifact.path });
    } catch (error) {
      addAssistantError("Unable to reveal file", error);
    }
  }

  function addAssistantError(prefix: string, error: unknown) {
    setMessages((current) => [
      ...current,
      { role: "assistant", content: `${prefix}: ${error instanceof Error ? error.message : String(error)}` },
    ]);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  function resizeInput(event: React.FormEvent<HTMLTextAreaElement>) {
    const textarea = event.currentTarget;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 152)}px`;
  }

  const agentList = Object.values(agents);

  return (
    <div className={`chat-layout${hasConversation ? " chat-layout--active" : ""}`}>
      {!folder ? (
        <section className="welcome-panel welcome-panel--workspace">
          <div className="welcome-kicker">WORKSPACE REQUIRED</div>
          <h1>Select a workspace</h1>
          <p>Grant a local folder so Cowork can create sessions, read files, and keep artifacts in one place.</p>
          <button className="workspace-cta" type="button" onClick={onGrantWorkspace}>
            <Icon name="folder" size={17} />
            Grant workspace
          </button>
        </section>
      ) : !hasConversation ? (
        <section className="welcome-panel">
          <div className="welcome-kicker">YOUR AI WORKSPACE</div>
          <h1>What can we work on?</h1>
          <p>Plan, build, and finish real work with your agent team.</p>
          <Composer
            folder={folder} input={input} inputRef={inputRef} running={running}
            providers={providers} selectedProviderId={selectedProviderId} onSelectProvider={onSelectProvider}
            onChange={setInput} onInput={resizeInput} onKeyDown={handleKeyDown}
            onSend={send} onCancel={cancelRun}
            onOpenProviderSettings={onOpenProviderSettings}
          />
        </section>
      ) : (
        <>
          <div className="conversation" ref={scrollRef}>
            <div className="conversation-inner">
              {agentList.length > 0 && (
                <section className="task-activity" aria-label="Agent progress">
                  <div className="task-activity-heading"><span>Agent team</span><small>{agentList.filter((agent) => agent.status === "done").length}/{agentList.length} complete</small></div>
                  {agentList.map((agent) => (
                    <div className="agent-progress-row" key={agent.id}>
                      <i className={`agent-status agent-status--${agent.status}`} />
                      <div><strong>{agent.task}</strong><span>{agent.detail ?? agent.skills.join(" · ") ?? ""}</span></div>
                    </div>
                  ))}
                </section>
              )}

              {(artifacts.length > 0 || (conversationId && localApi)) && (
                <div ref={filesRef}>
                  <ArtifactPanel
                    artifacts={artifacts}
                    loadingPreviewId={previewLoadingId}
                    previewId={artifactPreview?.artifact.id ?? null}
                    onAttach={conversationId && localApi ? attachFile : undefined}
                    onPreview={localApi ? previewArtifact : undefined}
                    onOpen={openArtifact}
                    onReveal={revealArtifact}
                  />
                </div>
              )}
              {artifactPreview && <ArtifactPreviewPanel result={artifactPreview} onClose={() => setArtifactPreview(null)} />}

              {messages.map((message, index) => (
                <article className={`message message--${message.role}`} key={`${message.role}-${index}`}>
                  {message.role === "assistant" && <div className="message-avatar">C</div>}
                  <div className="message-content">
                    <span>{message.role === "user" ? "You" : "Cowork"}</span>
                    {message.role === "assistant" ? (
                      <MarkdownMessage content={message.content} />
                    ) : (
                      <>
                        <p>{message.content}</p>
                        <MessageActions
                          disabled={running}
                          onCopy={() => void copyMessage(message.content)}
                          onEdit={() => editMessage(message.content)}
                          onRetry={() => void send(message.content)}
                        />
                      </>
                    )}
                  </div>
                </article>
              ))}

              {running && <div className="agent-working"><i /><i /><i /><span>Agent team is working</span></div>}
              {events.length > 0 && (
                <details className="event-details">
                  <summary>View task activity ({events.length})</summary>
                  <ActivityTimeline events={events} />
                </details>
              )}
            </div>
          </div>
          <div className="composer-dock">
            <Composer
              folder={folder} input={input} inputRef={inputRef} running={running}
              providers={providers} selectedProviderId={selectedProviderId} onSelectProvider={onSelectProvider}
              onChange={setInput} onInput={resizeInput} onKeyDown={handleKeyDown}
              onSend={send} onCancel={cancelRun}
              onOpenProviderSettings={onOpenProviderSettings}
            />
          </div>
        </>
      )}

      {confirmation && (
        <PermissionApprovalModal
          confirmation={confirmation}
          onRespond={(approved) => void respondToConfirmation(approved)}
        />
      )}
    </div>
  );

  function applyArtifactEvent(event: AgentEvent) {
    if (!isArtifactEvent(event)) return;
    setArtifacts((current) => upsertArtifact(current, event.artifact));
  }
}

function MessageActions({
  disabled,
  onCopy,
  onEdit,
  onRetry,
}: {
  disabled: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="message-actions" aria-label="Message actions">
      <button type="button" title="Copy" aria-label="Copy message" disabled={disabled} onClick={onCopy}>
        <Icon name="copy" size={13} />
      </button>
      <button type="button" title="Edit" aria-label="Edit message" disabled={disabled} onClick={onEdit}>
        <Icon name="edit" size={13} />
      </button>
      <button type="button" title="Retry" aria-label="Retry message" disabled={disabled} onClick={onRetry}>
        <Icon name="refresh" size={13} />
      </button>
    </div>
  );
}

type ActivityTone = "info" | "running" | "done" | "warning" | "error";
type ActivityCategory = "all" | "tools" | "files" | "permissions" | "errors";
type ActivityItem = {
  title: string;
  detail?: string;
  meta?: string;
  chip?: string;
  icon: IconName;
  category: ActivityCategory;
  raw?: AgentEvent[];
  tone: ActivityTone;
};

function ActivityTimeline({ events }: { events: AgentEvent[] }) {
  const [filter, setFilter] = useState<ActivityCategory>("all");
  const items = compactActivityItems(events);
  const summary = summarizeActivity(events, items);
  const visibleItems = filter === "all" ? items : items.filter((item) => item.category === filter);
  return (
    <div className="activity-panel">
      <div className="activity-summary">
        <strong>Activity</strong>
        <span>{summary}</span>
      </div>
      <div className="activity-filters" aria-label="Activity filters">
        {(["all", "tools", "files", "permissions", "errors"] as ActivityCategory[]).map((item) => (
          <button
            type="button"
            key={item}
            className={filter === item ? "is-selected" : ""}
            onClick={() => setFilter(item)}
          >
            {activityFilterLabel(item)}
          </button>
        ))}
      </div>
      <div className="activity-timeline">
        {visibleItems.map((item, index) => (
          <details className={`activity-row activity-row--${item.tone}`} key={`${item.title}-${index}`}>
            <summary>
              <i><Icon name={item.icon} size={11} /></i>
              <div>
                <strong>{item.title}</strong>
                {item.detail && <span>{item.detail}</span>}
              </div>
              <div className="activity-row-meta">
                {item.chip && <em>{item.chip}</em>}
                {item.meta && <small>{item.meta}</small>}
              </div>
            </summary>
            {item.raw && item.raw.length > 0 && (
              <pre>{JSON.stringify(item.raw.length === 1 ? item.raw[0] : item.raw, null, 2)}</pre>
            )}
          </details>
        ))}
        {visibleItems.length === 0 && <p className="activity-empty">No activity in this filter</p>}
      </div>
    </div>
  );
}

function compactActivityItems(events: AgentEvent[]) {
  const items: ActivityItem[] = [];
  const pendingToolCalls = new Map<string, AgentEvent>();

  for (const event of events) {
    if (event.kind === "tool_call") {
      pendingToolCalls.set(toolEventKey(event), event);
      continue;
    }
    if (event.kind === "tool_result") {
      const key = toolEventKey(event);
      const call = pendingToolCalls.get(key);
      if (call) pendingToolCalls.delete(key);
      items.push(toolActivityItem(event, call));
      continue;
    }
    const item = activityFromEvent(event);
    if (item) items.push(item);
  }

  for (const call of pendingToolCalls.values()) {
    const item = activityFromEvent(call);
    if (item) items.push(item);
  }

  return items;
}

function summarizeActivity(events: AgentEvent[], items: ActivityItem[]) {
  const tools = items.filter((item) => item.category === "tools").length;
  const files = items.filter((item) => item.category === "files").length;
  const permissions = items.filter((item) => item.category === "permissions").length;
  const errors = items.filter((item) => item.category === "errors").length;
  return compactParts([
    `${events.length} events`,
    tools ? `${tools} tools` : undefined,
    files ? `${files} files` : undefined,
    permissions ? `${permissions} permissions` : undefined,
    errors ? `${errors} errors` : undefined,
  ]);
}

function activityFilterLabel(filter: ActivityCategory) {
  if (filter === "all") return "All";
  if (filter === "tools") return "Tools";
  if (filter === "files") return "Files";
  if (filter === "permissions") return "Permissions";
  return "Errors";
}

function toolEventKey(event: AgentEvent) {
  return `${stringValue(event.id) ?? "agent"}:${stringValue(event.name) ?? "tool"}`;
}

function toolActivityItem(result: AgentEvent, call?: AgentEvent): ActivityItem {
  const name = stringValue(result.name) ?? stringValue(call?.name) ?? "tool";
  return {
    title: `${name} completed`,
    detail: summarizeToolPayload(result.result) ?? summarizeToolPayload(call?.args),
    meta: stringValue(result.id),
    chip: "tool",
    icon: "code",
    category: "tools",
    tone: "done",
    raw: call ? [call, result] : [result],
  };
}

function activityFromEvent(event: AgentEvent): ActivityItem | null {
  if (event.kind === "run_started") {
    return {
      title: "Run started",
      detail: compactParts([stringValue(event.providerName), stringValue(event.model)]),
      chip: "run",
      icon: "arrowUp",
      category: "all",
      raw: [event],
      tone: "running",
    };
  }
  if (event.kind === "mcp_status") {
    const servers = Array.isArray(event.servers) ? event.servers : [];
    const connected = servers.filter((server) => isRecord(server) && server.connected === true).length;
    return {
      title: "MCP checked",
      detail: servers.length > 0 ? `${connected}/${servers.length} servers connected` : "No MCP servers connected",
      chip: "mcp",
      icon: "plug",
      category: "all",
      raw: [event],
      tone: connected > 0 ? "done" : "info",
    };
  }
  if (event.kind === "thinking") {
    return null;
  }
  if (event.kind === "plan") {
    const steps = Array.isArray(event.steps) ? event.steps : [];
    return { title: "Plan created", detail: `${steps.length} step${steps.length === 1 ? "" : "s"}`, chip: "plan", icon: "document", category: "all", tone: "done", raw: [event] };
  }
  if (event.kind === "subagent_spawned") {
    return { title: "Agent started", detail: stringValue(event.task), meta: stringValue(event.id), chip: "agent", icon: "team", category: "all", tone: "running", raw: [event] };
  }
  if (event.kind === "subagent_progress") {
    return null;
  }
  if (event.kind === "subagent_done") {
    const result = isRecord(event.result) ? event.result : {};
    const success = result.success !== false;
    return {
      title: success ? "Agent completed" : "Agent failed",
      detail: summarizeUnknown(result.summary ?? result.error ?? result),
      meta: stringValue(event.id),
      chip: "agent",
      icon: "team",
      category: success ? "all" : "errors",
      tone: success ? "done" : "error",
      raw: [event],
    };
  }
  if (event.kind === "skill_activated") {
    return { title: "Skill loaded", detail: stringValue(event.skill), meta: stringValue(event.id), chip: "skill", icon: "book", category: "all", tone: "done", raw: [event] };
  }
  if (event.kind === "tool_call") {
    return {
      title: `Using ${stringValue(event.name) ?? "tool"}`,
      detail: summarizeToolPayload(event.args),
      meta: stringValue(event.id),
      chip: "tool",
      icon: "code",
      category: "tools",
      tone: "running",
      raw: [event],
    };
  }
  if (event.kind === "confirmation_requested") {
    return {
      title: "Permission requested",
      detail: compactParts([stringValue(event.tool), stringValue(event.prompt)]),
      meta: stringValue(event.agentId),
      chip: "permission",
      icon: "shield",
      category: "permissions",
      tone: "warning",
      raw: [event],
    };
  }
  if (event.kind === "confirmation_resolved") {
    return {
      title: event.approved ? "Permission approved" : "Permission denied",
      meta: stringValue(event.confirmationId),
      chip: "permission",
      icon: "shield",
      category: "permissions",
      tone: event.approved ? "done" : "warning",
      raw: [event],
    };
  }
  if (isArtifactEvent(event)) {
    return {
      title: artifactActivityTitle(event.kind),
      detail: `${event.artifact.name} - ${shortPath(event.artifact.path)}`,
      meta: formatBytes(event.artifact.sizeBytes),
      chip: "file",
      icon: artifactActivityIcon(event.artifact),
      category: "files",
      tone: "done",
      raw: [event],
    };
  }
  if (event.kind === "final") {
    return { title: "Final answer", detail: summarizeUnknown(event.content), chip: "final", icon: "document", category: "all", tone: "done", raw: [event] };
  }
  if (event.kind === "run_cancelled") {
    return { title: "Run cancelled", meta: stringValue(event.runId), chip: "run", icon: "alert", category: "errors", tone: "warning", raw: [event] };
  }
  if (event.kind === "error") {
    return { title: "Error", detail: stringValue(event.message), chip: "error", icon: "alert", category: "errors", tone: "error", raw: [event] };
  }
  return { title: humanizeEventKind(event.kind), detail: summarizeToolPayload(event), chip: "event", icon: "clock", category: "all", tone: "info", raw: [event] };
}

function artifactActivityTitle(kind: string) {
  if (kind === "artifact_created") return "File created";
  if (kind === "artifact_attached") return "File attached";
  if (kind === "artifact_updated") return "File updated";
  if (kind === "artifact_moved") return "File moved";
  return "File event";
}

function artifactActivityIcon(artifact: ArtifactSummary): IconName {
  return artifactIcon(artifact);
}

function summarizeToolPayload(value: unknown) {
  if (!isRecord(value)) return summarizeUnknown(value);
  const preferred = ["path", "previousPath", "targetPath", "filePath", "query", "pattern", "command", "workspace", "folder", "name"];
  const parts = preferred
    .filter((key) => typeof value[key] === "string" || typeof value[key] === "number" || typeof value[key] === "boolean")
    .map((key) => `${key}: ${String(value[key])}`);
  if (parts.length > 0) return truncateText(parts.join(" - "), 180);
  return summarizeUnknown(value);
}

function summarizeUnknown(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return truncateText(value, 180);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return truncateText(JSON.stringify(value), 180);
  } catch {
    return String(value);
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compactParts(parts: Array<string | undefined>) {
  const compacted = parts.filter((part): part is string => Boolean(part));
  return compacted.length > 0 ? truncateText(compacted.join(" - "), 180) : undefined;
}

function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function humanizeEventKind(kind: string) {
  return kind
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

type MarkdownBlock =
  | { kind: "code"; language: string; content: string }
  | { kind: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

function MarkdownMessage({ content }: { content: string }) {
  const blocks = parseMarkdown(content);
  return (
    <div className="markdown-message">
      {blocks.map((block, index) => renderMarkdownBlock(block, index))}
    </div>
  );
}

function parseMarkdown(content: string): MarkdownBlock[] {
  const lines = normalizeInlineMarkdownTables(content.replace(/\r\n/g, "\n")).split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```(\S*)\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language: fence[1] ?? "", content: codeLines.join("\n") });
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4,
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    const table = parseMarkdownTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(/^[-*]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(/^\d+[.)]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const next = lines[index];
      const nextTrimmed = next.trim();
      if (
        !nextTrimmed
        || /^```/.test(nextTrimmed)
        || /^#{1,4}\s+/.test(nextTrimmed)
        || parseMarkdownTable(lines, index)
        || /^[-*]\s+/.test(nextTrimmed)
        || /^\d+[.)]\s+/.test(nextTrimmed)
      ) break;
      paragraphLines.push(nextTrimmed);
      index += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraphLines });
  }

  return blocks;
}

function normalizeInlineMarkdownTables(content: string) {
  return content
    .split("\n")
    .flatMap((line) => {
      if (!looksLikeInlineTable(line)) return [line];
      return splitInlineTableRows(line);
    })
    .join("\n");
}

function looksLikeInlineTable(line: string) {
  const trimmed = line.trim();
  return trimmed.includes("|") && /\|\s*:?-{3,}:?\s*\|/.test(trimmed) && (trimmed.match(/\|/g)?.length ?? 0) >= 8;
}

function splitInlineTableRows(line: string) {
  const separated = line.replace(/\|\s+\|/g, "|\n|");
  if (separated === line) return [line];

  return separated.split("\n").flatMap((piece) => {
    const trimmed = piece.trim();
    if (!trimmed) return [];
    const firstPipe = trimmed.indexOf("|");
    const lastPipe = trimmed.lastIndexOf("|");
    if (firstPipe < 0 || lastPipe <= firstPipe) return [trimmed];

    const prefix = trimmed.slice(0, firstPipe).trim();
    const row = trimmed.slice(firstPipe, lastPipe + 1).trim();
    const suffix = trimmed.slice(lastPipe + 1).trim();
    return [
      ...(prefix ? [prefix] : []),
      row,
      ...(suffix ? [suffix] : []),
    ];
  });
}

function parseMarkdownTable(lines: string[], index: number): { block: MarkdownBlock; nextIndex: number } | null {
  if (index + 1 >= lines.length) return null;
  const header = parseTableRow(lines[index]);
  const separator = parseTableRow(lines[index + 1]);
  if (!header || !separator || !separator.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) return null;

  const rows: string[][] = [];
  let nextIndex = index + 2;
  while (nextIndex < lines.length) {
    const row = parseTableRow(lines[nextIndex]);
    if (!row) break;
    rows.push(padTableRow(row, header.length));
    nextIndex += 1;
  }

  return {
    block: { kind: "table", headers: header, rows },
    nextIndex,
  };
}

function parseTableRow(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function padTableRow(row: string[], length: number) {
  if (row.length >= length) return row.slice(0, length);
  return [...row, ...Array.from({ length: length - row.length }, () => "")];
}

function renderMarkdownBlock(block: MarkdownBlock, index: number) {
  if (block.kind === "code") {
    return (
      <div className="markdown-code" key={index}>
        {block.language && <span>{block.language}</span>}
        <pre><code>{block.content}</code></pre>
      </div>
    );
  }
  if (block.kind === "heading") {
    const Tag = (`h${Math.min(block.level + 1, 4)}`) as "h2" | "h3" | "h4";
    return <Tag key={index}>{renderInlineMarkdown(block.text)}</Tag>;
  }
  if (block.kind === "table") {
    return (
      <div className="markdown-table-wrap" key={index}>
        <table>
          <thead>
            <tr>{block.headers.map((header, cellIndex) => <th key={cellIndex}>{renderInlineMarkdown(header)}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => <td key={cellIndex}>{renderInlineMarkdown(cell)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.kind === "ul") {
    return (
      <ul key={index}>
        {block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}
      </ul>
    );
  }
  if (block.kind === "ol") {
    return (
      <ol key={index}>
        {block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}
      </ol>
    );
  }
  return (
    <p key={index}>
      {block.lines.map((line, lineIndex) => (
        <span key={lineIndex}>
          {lineIndex > 0 && <br />}
          {renderInlineMarkdown(line)}
        </span>
      ))}
    </p>
  );
}

function renderInlineMarkdown(text: string) {
  const parts: Array<string | JSX.Element> = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push(<code key={parts.length}>{token.slice(1, -1)}</code>);
    } else {
      parts.push(<strong key={parts.length}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function PermissionApprovalModal({
  confirmation,
  onRespond,
}: {
  confirmation: Confirmation;
  onRespond: (approved: boolean) => void;
}) {
  return (
    <div className="permission-overlay" role="dialog" aria-modal="true" aria-label="Permission approval">
      <section className="permission-modal">
        <header>
          <div className="permission-icon"><Icon name="settings" size={18} /></div>
          <div>
            <strong>Permission Required</strong>
            <span>{confirmation.tool ?? "Tool request"}{confirmation.agentId ? ` · ${confirmation.agentId}` : ""}</span>
          </div>
        </header>
        <p>{confirmation.prompt}</p>
        {confirmation.args && (
          <details className="permission-details">
            <summary>Request details</summary>
            <pre>{formatConfirmationArgs(confirmation.args)}</pre>
          </details>
        )}
        <footer>
          <button type="button" className="button-secondary" onClick={() => onRespond(false)}>Deny</button>
          <button type="button" className="button-primary" onClick={() => onRespond(true)}>Allow once</button>
        </footer>
      </section>
    </div>
  );
}

function ArtifactPanel({
  artifacts,
  loadingPreviewId,
  previewId,
  onAttach,
  onPreview,
  onOpen,
  onReveal,
}: {
  artifacts: ArtifactSummary[];
  loadingPreviewId: string | null;
  previewId: string | null;
  onAttach?: () => Promise<void>;
  onPreview?: (artifact: ArtifactSummary) => Promise<void>;
  onOpen?: (artifact: ArtifactSummary) => Promise<void>;
  onReveal?: (artifact: ArtifactSummary) => Promise<void>;
}) {
  return (
    <section className="artifact-panel" aria-label="Session files">
      <div className="task-activity-heading">
        <span>Files</span>
        <div className="artifact-panel-actions">
          <small>{artifacts.length}</small>
          {onAttach && (
            <button type="button" aria-label="Attach file" onClick={() => void onAttach()}>
              <Icon name="plus" size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="artifact-list">
        {artifacts.length === 0 ? (
          <div className="artifact-empty">No files attached yet</div>
        ) : (
          artifacts.map((artifact) => (
            <div className={`artifact-row${previewId === artifact.id ? " artifact-row--selected" : ""}`} key={artifact.id} title={artifact.path}>
              <div className="artifact-icon"><Icon name={artifactIcon(artifact)} size={16} /></div>
              <div>
                <strong>{artifact.name}</strong>
                <span>{artifactKindLabel(artifact)} · {formatBytes(artifact.sizeBytes)} · {shortPath(artifact.path)}</span>
              </div>
              <small>{artifact.fileType}</small>
              <div className="artifact-row-actions">
                {onPreview && (
                  <button
                    type="button"
                    aria-label={`Preview ${artifact.name}`}
                    disabled={loadingPreviewId === artifact.id}
                    onClick={() => void onPreview(artifact)}
                  >
                    <Icon name="eye" size={13} />
                  </button>
                )}
                {onOpen && (
                  <button type="button" aria-label={`Open ${artifact.name}`} onClick={() => void onOpen(artifact)}>
                    <Icon name="external" size={13} />
                  </button>
                )}
                {onReveal && (
                  <button type="button" aria-label={`Reveal ${artifact.name}`} onClick={() => void onReveal(artifact)}>
                    <Icon name="folder" size={13} />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function ArtifactPreviewPanel({ result, onClose }: { result: ArtifactPreviewResult; onClose: () => void }) {
  const { artifact, preview } = result;
  return (
    <section className="artifact-preview" aria-label="File preview">
      <div className="artifact-preview-heading">
        <div>
          <strong>{artifact.name}</strong>
          <span>{formatBytes(artifact.sizeBytes)} · {shortPath(artifact.path)}</span>
        </div>
        <button type="button" aria-label="Close preview" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      {preview.kind === "text" && (() => {
        const mime = artifact.mimeType;
        if (mime === "text/markdown" || artifact.name.endsWith(".md")) {
          return <MarkdownPreview content={preview.content} truncated={preview.truncated} limitBytes={preview.limitBytes} />;
        }
        if (mime === "text/csv" || artifact.name.endsWith(".csv")) {
          return <CsvPreview content={preview.content} truncated={preview.truncated} limitBytes={preview.limitBytes} />;
        }
        return (
          <>
            <pre>{preview.content}</pre>
            {preview.truncated && <small>Preview truncated at {formatBytes(preview.limitBytes)}</small>}
          </>
        );
      })()}
      {preview.kind === "image" && <img src={preview.dataUrl} alt={artifact.name} />}
      {preview.kind === "document" && <DocumentPreview dataBase64={preview.dataBase64} mimeType={preview.mimeType} name={artifact.name} />}
      {(preview.kind === "binary" || preview.kind === "missing") && <p>{preview.message}</p>}
    </section>
  );
}

function MarkdownPreview({ content, truncated, limitBytes }: { content: string; truncated: boolean; limitBytes: number }) {
  const html = marked.parse(content, { async: false }) as string;
  return (
    <div className="artifact-preview-md">
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {truncated && <small>Preview truncated at {formatBytes(limitBytes)}</small>}
    </div>
  );
}

function CsvPreview({ content, truncated, limitBytes }: { content: string; truncated: boolean; limitBytes: number }) {
  const rows = parseCsvPreview(content);
  const [headers, ...body] = rows;
  return (
    <div className="artifact-preview-csv">
      <div className="artifact-preview-csv-scroll">
        <table>
          <thead><tr>{headers?.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>{body.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {truncated && <small>Preview truncated at {formatBytes(limitBytes)} — showing first {body.length} rows</small>}
    </div>
  );
}

function parseCsvPreview(content: string): string[][] {
  return content.split("\n").filter(Boolean).map((line) => {
    const cells: string[] = [];
    let cur = "", inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === "," && !inQuote) {
        cells.push(cur); cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    return cells;
  });
}

function DocumentPreview({ dataBase64, mimeType, name }: { dataBase64: string; mimeType: string; name: string }) {
  const [content, setContent] = useState<{ kind: "html"; html: string } | { kind: "table"; headers: string[]; rows: string[][] } | { kind: "pdf"; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bytes = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));

    if (mimeType === "application/pdf") {
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      setContent({ kind: "pdf", url });
      return () => URL.revokeObjectURL(url);
    }

    if (
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      || mimeType === "application/msword"
    ) {
      mammoth.convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer })
        .then((result) => setContent({ kind: "html", html: result.value }))
        .catch((err) => setError(String(err)));
      return;
    }

    if (
      mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      || mimeType === "application/vnd.ms-excel"
    ) {
      try {
        const wb = XLSX.read(bytes, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
        const [headers = [], ...rows] = data.map((row) => row.map(String));
        setContent({ kind: "table", headers, rows });
      } catch (err) {
        setError(String(err));
      }
      return;
    }

    setError("Unsupported document type");
  }, [dataBase64, mimeType]);

  if (error) return <p className="artifact-preview-doc-error">{error}</p>;
  if (!content) return <p className="artifact-preview-doc-loading">Loading preview…</p>;

  if (content.kind === "pdf") {
    return <iframe className="artifact-preview-pdf" src={content.url} title={name} />;
  }
  if (content.kind === "html") {
    return (
      <div className="artifact-preview-md artifact-preview-docx">
        <div dangerouslySetInnerHTML={{ __html: content.html }} />
      </div>
    );
  }
  return (
    <div className="artifact-preview-csv">
      <div className="artifact-preview-csv-scroll">
        <table>
          <thead><tr>{content.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>{content.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function isArtifactEvent(event: AgentEvent): event is AgentEvent & { artifact: ArtifactSummary } {
  return (
    event.kind === "artifact_created"
    || event.kind === "artifact_attached"
    || event.kind === "artifact_updated"
    || event.kind === "artifact_moved"
  )
    && isArtifact(event.artifact);
}

function isArtifact(value: unknown): value is ArtifactSummary {
  if (!value || typeof value !== "object") return false;
  const artifact = value as Partial<ArtifactSummary>;
  return typeof artifact.id === "string"
    && typeof artifact.path === "string"
    && typeof artifact.name === "string"
    && typeof artifact.kind === "string";
}

function confirmationFromEvent(event: AgentEvent): Confirmation | null {
  if (typeof event.confirmationId !== "string" || typeof event.prompt !== "string") return null;
  return {
    id: event.confirmationId,
    prompt: event.prompt,
    tool: typeof event.tool === "string" ? event.tool : null,
    agentId: typeof event.agentId === "string" ? event.agentId : null,
    args: isRecord(event.args) ? event.args : null,
  };
}

function formatConfirmationArgs(args: Record<string, unknown>) {
  return JSON.stringify(args, null, 2);
}

function upsertArtifact(current: ArtifactSummary[], artifact: ArtifactSummary) {
  const rest = current.filter((item) => item.id !== artifact.id);
  return [artifact, ...rest];
}

function artifactIcon(artifact: ArtifactSummary): IconName {
  if (artifact.mimeType.startsWith("image/")) return "image";
  if (artifact.fileType === "csv") return "spreadsheet";
  if (["css", "html", "js", "json", "ts", "tsx", "xml", "yaml", "yml"].includes(artifact.fileType)) return "code";
  return "document";
}

function artifactKindLabel(artifact: ArtifactSummary) {
  if (artifact.kind === "created") return "Created";
  if (artifact.kind === "attached") return "Attached";
  if (artifact.kind === "updated") return "Updated";
  return "Moved";
}

function formatBytes(size: number | null) {
  if (size === null) return "unknown size";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function shortPath(filePath: string) {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts.slice(-3).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function waitForEventSourceOpen(source: EventSource) {
  if (source.readyState === EventSource.OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for event stream"));
    }, 5_000);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Unable to open event stream"));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      source.removeEventListener("open", onOpen);
      source.removeEventListener("error", onError);
    };
    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);
  });
}

type ComposerProps = {
  folder: string | null;
  input: string;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  running: boolean;
  providers: ProviderProfile[];
  selectedProviderId: string | null;
  onSelectProvider: (providerId: string | null) => void;
  onChange: (value: string) => void;
  onInput: (event: React.FormEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => Promise<void>;
  onCancel: () => Promise<void>;
  onOpenProviderSettings: () => void;
};

function Composer({
  folder,
  input,
  inputRef,
  running,
  providers,
  selectedProviderId,
  onSelectProvider,
  onChange,
  onInput,
  onKeyDown,
  onSend,
  onCancel,
  onOpenProviderSettings,
}: ComposerProps) {
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const selectedEnabledProviderId = enabledProviders.some((provider) => provider.id === selectedProviderId)
    ? selectedProviderId ?? ""
    : "";
  const defaultProvider = enabledProviders.find((provider) => provider.isDefault) ?? enabledProviders[0] ?? null;
  return (
    <div className={`composer${!folder ? " composer--disabled" : ""}`}>
      <textarea
        ref={inputRef} value={input} onChange={(event) => onChange(event.target.value)}
        onInput={onInput} onKeyDown={onKeyDown}
        placeholder={folder ? "Describe a task for this workspace" : "Grant a workspace to begin"}
        disabled={!folder || running} rows={2}
      />
      <div className="composer-toolbar">
        <div className="composer-settings">
          {enabledProviders.length === 0 ? (
            <button type="button" className="provider-setup-button" title="Using the provider configured in .env" onClick={onOpenProviderSettings}>
              <Icon name="settings" size={15} />
              Env provider
            </button>
          ) : (
            <label className="model-selector" aria-label="Model" title={selectedEnabledProviderId ? selectedModelTitle(enabledProviders, selectedEnabledProviderId) : defaultProvider ? `Default: ${defaultProvider.model} via ${defaultProvider.name}` : "Default model"}>
              <select
                value={selectedEnabledProviderId}
                onChange={(event) => onSelectProvider(event.target.value || null)}
              >
                <option value="">{defaultProvider ? `${defaultProvider.model} (default)` : "Default model"}</option>
                {enabledProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.model} — {provider.name}
                  </option>
                ))}
              </select>
              <Icon name="chevronDown" size={14} />
            </label>
          )}
          <button
            type="button"
            className={`send-button${running ? " send-button--stop" : ""}`}
            aria-label={running ? "Stop task" : "Send task"}
            disabled={!running && (!folder || !input.trim())}
            onClick={() => running ? void onCancel() : void onSend()}
          >
            {running ? <span className="stop-icon" /> : <Icon name="arrowUp" size={19} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function selectedModelTitle(providers: ProviderProfile[], providerId: string) {
  const provider = providers.find((item) => item.id === providerId);
  return provider ? `${provider.model} via ${provider.name}` : "Selected model";
}
