import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Icon, type IconName } from "./Icon";

type Message = { role: "user" | "assistant"; content: string };
type AgentEvent = { kind: string; runId?: string; [key: string]: unknown };
type BridgeEvent = { requestId: string; event: AgentEvent };
type Confirmation = { id: string; prompt: string };
type AgentProgress = {
  id: string;
  task: string;
  status: "pending" | "running" | "done" | "failed";
  detail?: string;
  skills: string[];
};
type Props = { folder: string | null; resumeLatest: boolean };

const quickActions: Array<{ label: string; icon: IconName; prompt: string }> = [
  { label: "Document", icon: "document", prompt: "ช่วยสร้างเอกสารสรุปจากไฟล์ใน workspace นี้" },
  { label: "Website", icon: "code", prompt: "ช่วยวิเคราะห์และพัฒนาเว็บไซต์ใน workspace นี้" },
  { label: "Image", icon: "image", prompt: "ช่วยวางแผนและเตรียมภาพประกอบสำหรับโปรเจกต์นี้" },
  { label: "Spreadsheet", icon: "spreadsheet", prompt: "ช่วยวิเคราะห์ข้อมูลตารางใน workspace นี้" },
];

export function Chat({ folder, resumeLatest }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [agents, setAgents] = useState<Record<string, AgentProgress>>({});
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeRunId = useRef<string | null>(null);

  const hasConversation = messages.length > 0;

  useEffect(() => {
    let disposed = false;
    void listen<BridgeEvent>("agent-event", ({ payload }) => {
      const event = payload.event;
      if (disposed || !activeRunId.current || event.runId !== activeRunId.current) return;
      setEvents((current) => [...current, event]);
      applyAgentEvent(event);

      if (event.kind === "final" && typeof event.content === "string") {
        const content = event.content;
        setMessages((current) => [...current, { role: "assistant", content }]);
      } else if (event.kind === "confirmation_requested") {
        if (typeof event.confirmationId === "string" && typeof event.prompt === "string") {
          setConfirmation({ id: event.confirmationId, prompt: event.prompt });
        }
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

  useEffect(() => {
    setMessages([]);
    setConversationId(null);
    setEvents([]);
    setAgents({});
    if (!folder || !resumeLatest) return;

    invoke<{ conversation: { id: string; messages: Message[] } | null }>("call_sidecar", {
      method: "latest_conversation",
      params: { workspace: folder },
    }).then((result) => {
      if (result.conversation) {
        setConversationId(result.conversation.id);
        setMessages(result.conversation.messages);
      }
    }).catch((error) => console.error("Failed to load conversation", error));
  }, [folder, resumeLatest]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, events]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [folder]);

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
    await invoke("call_sidecar", {
      method: "cancel_run",
      params: { runId: activeRunId.current },
    });
  }

  async function respondToConfirmation(approved: boolean) {
    if (!confirmation) return;
    const id = confirmation.id;
    setConfirmation(null);
    await invoke("call_sidecar", {
      method: "respond_confirmation",
      params: { confirmationId: id, approved },
    });
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
              onChange={setInput} onInput={resizeInput} onKeyDown={handleKeyDown}
              onSend={send} onCancel={cancelRun}
            />
          </div>
        </>
      )}

      {confirmation && (
        <div className="confirmation-bar" role="alert">
          <div><strong>Permission required</strong><span>{confirmation.prompt}</span></div>
          <button type="button" className="button-secondary" onClick={() => void respondToConfirmation(false)}>Deny</button>
          <button type="button" className="button-primary" onClick={() => void respondToConfirmation(true)}>Allow once</button>
        </div>
      )}
    </div>
  );
}

type ComposerProps = {
  folder: string | null;
  input: string;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  running: boolean;
  onChange: (value: string) => void;
  onInput: (event: React.FormEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => Promise<void>;
  onCancel: () => Promise<void>;
};

function Composer({ folder, input, inputRef, running, onChange, onInput, onKeyDown, onSend, onCancel }: ComposerProps) {
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
          <button type="button" className="model-selector">Auto<Icon name="chevronDown" size={14} /></button>
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
