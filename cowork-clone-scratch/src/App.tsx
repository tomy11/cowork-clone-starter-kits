/**
 * React UI — Main App
 *
 * ใช้ Tauri shell + stdio RPC ไปยัง Node sidecar
 */

import { useState, useEffect, useRef } from "react";
import { Chat } from "./components/Chat";
import { Sidebar } from "./components/Sidebar";
import { invoke } from "@tauri-apps/api/core";

export default function App() {
  const [grantedFolders, setGrantedFolders] = useState<string[]>([]);
  const [skills, setSkills] = useState<any[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);

  useEffect(() => {
    // Init: load granted folders, skills, tools
    invoke("list_granted_folders").then((res: any) => {
      setGrantedFolders(res.folders ?? []);
    });
    invoke("list_skills").then((res: any) => {
      setSkills(res.skills ?? []);
    });
    invoke("list_tools").then((res: any) => {
      setTools(res.tools ?? []);
    });
  }, []);

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui" }}>
      <Sidebar
        grantedFolders={grantedFolders}
        skills={skills}
        tools={tools}
        selectedFolder={selectedFolder}
        onSelectFolder={setSelectedFolder}
      />
      <main style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <header
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid #333",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16 }}>Cowork Clone</h2>
          {selectedFolder && (
            <span style={{ color: "#888", fontSize: 13 }}>📁 {selectedFolder}</span>
          )}
        </header>
        <Chat folder={selectedFolder} />
      </main>
    </div>
  );
}
