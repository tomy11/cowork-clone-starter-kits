import { useEffect, useRef, useState } from "react";
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
  focusInputKey?: number;
  focusFilesKey?: number;
  providers: ProviderProfile[];
  selectedProviderId: string | null;
  onSelectProvider: (providerId: string | null) => void;
  onSessionCreated?: (session: SessionSummary) => void;
};

const quickActions: Array<{ label: string; icon: IconName; prompt: string }> = [
  { label: "Document", icon: "document", prompt: "ช่วยสร้างเอกสารสรุปจากไฟล์ใน workspace นี้" },
  { label: "Website", icon: "code", prompt: "ช่วยวิเคราะห์และพัฒนาเว็บไซต์ใน workspace นี้" },
  { label: "Image", icon: "image", prompt: "ช่วยวางแผนและเตรียมภาพประกอบสำหรับโปรเจกต์นี้" },
  { label: "Spreadsheet", icon: "spreadsheet", prompt: "ช่วยวิเคราะห์ข้อมูลตารางใน workspace นี้" },
];

export function Chat({
  folder,
  sessionId,
  resumeLatest,
  localApi,
  focusInputKey = 0,
  focusFilesKey = 0,
  providers,
  selectedProviderId,
  onSelectProvider,
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
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeRunId = useRef<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const hasConversation = messages.length > 0 || Boolean(conversationId);
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? null;

  useEffect(() => {
    let disposed = false;
    void listen<BridgeEvent>("agent-event", ({ payload }) => {
      const event = payload.event;
      if (disposed || !activeRunId.current || event.runId !== activeRunId.current) return;
      setEvents((current) => [...current, event]);
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
    inputRef.current?.focus();
  }, [focusInputKey]);

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

  function handleAgentEvent(event: AgentEvent) {
    if (!activeRunId.current || event.runId !== activeRunId.current) return;
    setEvents((current) => [...current, event]);
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

  function replayEvents(replayed: AgentEvent[]) {
    setEvents(replayed);
    setConfirmation(null);
    for (const event of replayed) {
      applyAgentEvent(event);
      applyArtifactEvent(event);
      if (event.kind === "confirmation_requested") {
        setConfirmation(confirmationFromEvent(event));
      } else if (event.kind === "confirmation_resolved") {
        setConfirmation(null);
      }
    }
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
    });
    setConversationId(result.conversationId);
    if (result.status === "cancelled") {
      setMessages((current) => [...current, { role: "assistant", content: "Task cancelled." }]);
    }
  }

  async function send() {
    const content = input.trim();
    if (!content || running || !folder) return;

    const runId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    activeRunId.current = runId;
    setMessages((current) => [...current, { role: "user", content }]);
    setInput("");
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

  function chooseQuickAction(prompt: string) {
    setInput(prompt);
    inputRef.current?.focus();
  }

  function resizeInput(event: React.FormEvent<HTMLTextAreaElement>) {
    const textarea = event.currentTarget;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 152)}px`;
  }

  const agentList = Object.values(agents);

  return (
    <div
      className={`chat-layout${hasConversation ? " chat-layout--active" : ""}`}
      onDragEnter={() => setDragging(true)}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); }}
    >
      {dragging && <div className="drop-overlay">Drop files to add context</div>}

      {!hasConversation ? (
        <section className="welcome-panel">
          <div className="welcome-kicker">YOUR AI WORKSPACE</div>
          <h1>What can we work on?</h1>
          <p>Plan, build, and finish real work with your agent team.</p>
          <Composer
            folder={folder} input={input} inputRef={inputRef} running={running}
            providers={providers} selectedProviderId={selectedProviderId} onSelectProvider={onSelectProvider}
            onChange={setInput} onInput={resizeInput} onKeyDown={handleKeyDown}
            onSend={send} onCancel={cancelRun}
          />
          <div className="quick-actions" aria-label="Quick actions">
            {quickActions.map((action) => (
              <button type="button" key={action.label} onClick={() => chooseQuickAction(action.prompt)}>
                <Icon name={action.icon} size={17} />{action.label}
              </button>
            ))}
            <button type="button" onClick={() => inputRef.current?.focus()}>More</button>
          </div>
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
                    <p>{message.content}</p>
                  </div>
                </article>
              ))}

              {running && <div className="agent-working"><i /><i /><i /><span>Agent team is working</span></div>}
              {events.length > 0 && (
                <details className="event-details">
                  <summary>View task activity ({events.length})</summary>
                  <pre>{JSON.stringify(events, null, 2)}</pre>
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
      {preview.kind === "text" && (
        <>
          <pre>{preview.content}</pre>
          {preview.truncated && <small>Preview truncated at {formatBytes(preview.limitBytes)}</small>}
        </>
      )}
      {preview.kind === "image" && <img src={preview.dataUrl} alt={artifact.name} />}
      {(preview.kind === "binary" || preview.kind === "missing") && <p>{preview.message}</p>}
    </section>
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
}: ComposerProps) {
  const enabledProviders = providers.filter((provider) => provider.enabled);
  return (
    <div className={`composer${!folder ? " composer--disabled" : ""}`}>
      <textarea
        ref={inputRef} value={input} onChange={(event) => onChange(event.target.value)}
        onInput={onInput} onKeyDown={onKeyDown}
        placeholder={folder ? "Describe a task or drop files here for a quick start" : "Grant a workspace from the sidebar to begin"}
        disabled={!folder || running} rows={2}
      />
      <div className="composer-toolbar">
        <div className="composer-tools">
          <button className="composer-icon" type="button" aria-label="Add workspace or file"><Icon name="plus" size={21} /></button>
          <button className="team-selector" type="button"><Icon name="team" size={17} />Agent team</button>
        </div>
        <div className="composer-settings">
          <button type="button" className="thinking-mode"><Icon name="brain" size={17} />Thinking</button>
          <span className="toolbar-separator" />
          <label className="model-selector" aria-label="Model">
            <select
              value={selectedProviderId ?? ""}
              disabled={enabledProviders.length === 0}
              onChange={(event) => onSelectProvider(event.target.value || null)}
            >
              <option value="">Auto</option>
              {enabledProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} · {provider.model}
                </option>
              ))}
            </select>
            <Icon name="chevronDown" size={14} />
          </label>
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
