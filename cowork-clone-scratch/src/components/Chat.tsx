/**
 * Chat component — คุยกับ orchestrator
 */

import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

type Message = { role: "user" | "assistant"; content: string };
type Event = { kind: string; [k: string]: any };

type Props = { folder: string | null };

export function Chat({ folder }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<Event[]>([]);
  const [confirmPrompt, setConfirmPrompt] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages, events]);

  async function send() {
    if (!input.trim() || running) return;
    if (!folder) {
      alert("Grant folder ก่อน (sidebar ซ้าย)");
      return;
    }

    const userMsg: Message = { role: "user", content: input };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setRunning(true);
    setEvents([]);

    try {
      const result = await invoke<{ events: Event[] }>("run", {
        message: input,
        history: messages,
      });

      // Events already streamed via stdout; result.events is the final list
      const finalEvent = result.events?.find((e: Event) => e.kind === "final");
      if (finalEvent) {
        setMessages((m) => [...m, { role: "assistant", content: finalEvent.content }]);
      }
      setEvents(result.events ?? []);
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `❌ Error: ${err}` },
      ]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {messages.length === 0 && (
          <div style={{ color: "#666", textAlign: "center", marginTop: 40 }}>
            👋 บอก Cowork ได้เลย เช่น "จัดระเบียบ downloads folder"
            <br />
            หรือ "เขียน test ให้ function calculateTotal ใน src/utils.ts"
          </div>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              marginBottom: 12,
              padding: "8px 12px",
              borderRadius: 8,
              background: m.role === "user" ? "#2a4a6a" : "#2a2a2a",
              color: "#eee",
              maxWidth: "80%",
              marginLeft: m.role === "user" ? "auto" : 0,
              whiteSpace: "pre-wrap",
            }}
          >
            <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>
              {m.role === "user" ? "คุณ" : "Cowork"}
            </div>
            {m.content}
          </div>
        ))}

        {events.length > 0 && (
          <details style={{ marginTop: 16, fontSize: 12, color: "#888" }}>
            <summary>🔍 ดู events ทั้งหมด ({events.length})</summary>
            <pre style={{ background: "#0a0a0a", padding: 8, overflow: "auto" }}>
              {JSON.stringify(events, null, 2)}
            </pre>
          </details>
        )}

        {running && (
          <div style={{ color: "#888", fontStyle: "italic" }}>กำลังคิด...</div>
        )}
      </div>

      {confirmPrompt && (
        <div
          style={{
            background: "#4a3a2a",
            padding: 12,
            borderTop: "1px solid #6a4a2a",
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <span>⚠️ {confirmPrompt}</span>
          <button
            onClick={() => setConfirmPrompt(null)}
            style={{ background: "#6a4a2a", color: "#fff", border: "none", padding: "4px 12px" }}
          >
            Allow once
          </button>
          <button
            onClick={() => setConfirmPrompt(null)}
            style={{ background: "#6a2a2a", color: "#fff", border: "none", padding: "4px 12px" }}
          >
            Deny
          </button>
        </div>
      )}

      <div
        style={{
          padding: 12,
          borderTop: "1px solid #333",
          display: "flex",
          gap: 8,
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={folder ? "บอก Cowork ว่าต้องการอะไร..." : "Grant folder ก่อน..."}
          disabled={!folder || running}
          style={{
            flex: 1,
            padding: "8px 12px",
            background: "#1a1a1a",
            color: "#eee",
            border: "1px solid #444",
            borderRadius: 4,
          }}
        />
        <button
          onClick={send}
          disabled={!folder || running}
          style={{
            padding: "8px 16px",
            background: "#2a6a4a",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
