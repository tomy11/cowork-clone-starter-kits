/**
 * Sidebar — granted folders, skills, tools
 */

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

type Props = {
  grantedFolders: string[];
  skills: any[];
  tools: string[];
  selectedFolder: string | null;
  onSelectFolder: (folder: string | null) => void;
};

export function Sidebar({ grantedFolders, skills, tools, selectedFolder, onSelectFolder }: Props) {
  const [folders, setFolders] = useState(grantedFolders);

  async function pickFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      await invoke("grant_folder", { folder: selected });
      setFolders([...folders, selected]);
    }
  }

  return (
    <aside
      style={{
        width: 260,
        background: "#1a1a1a",
        color: "#eee",
        padding: 12,
        overflowY: "auto",
        borderRight: "1px solid #333",
      }}
    >
      <section>
        <h3 style={{ fontSize: 13, color: "#888", textTransform: "uppercase" }}>Folders</h3>
        <button
          onClick={pickFolder}
          style={{
            width: "100%",
            padding: "6px 10px",
            background: "#2a2a2a",
            color: "#eee",
            border: "1px solid #444",
            borderRadius: 4,
            cursor: "pointer",
            marginBottom: 8,
          }}
        >
          + Grant folder
        </button>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {folders.map((f) => (
            <li
              key={f}
              onClick={() => onSelectFolder(f === selectedFolder ? null : f)}
              style={{
                padding: "4px 8px",
                cursor: "pointer",
                borderRadius: 4,
                background: f === selectedFolder ? "#2a4a6a" : "transparent",
                fontSize: 12,
                wordBreak: "break-all",
              }}
            >
              📁 {f.split("/").slice(-2).join("/")}
            </li>
          ))}
        </ul>
      </section>

      <section style={{ marginTop: 20 }}>
        <h3 style={{ fontSize: 13, color: "#888", textTransform: "uppercase" }}>Skills</h3>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {skills.map((s) => (
            <li
              key={s.name}
              style={{ padding: "4px 8px", fontSize: 12 }}
              title={s.description}
            >
              🔧 {s.name}
            </li>
          ))}
        </ul>
      </section>

      <section style={{ marginTop: 20 }}>
        <h3 style={{ fontSize: 13, color: "#888", textTransform: "uppercase" }}>Tools</h3>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {tools.map((t) => (
            <li key={t} style={{ padding: "4px 8px", fontSize: 12 }}>
              ⚙️ {t}
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
