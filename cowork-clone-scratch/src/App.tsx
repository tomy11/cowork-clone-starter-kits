import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Chat } from "./components/Chat";
import { Sidebar } from "./components/Sidebar";
import { Icon } from "./components/Icon";

type SkillSummary = { name: string; description?: string };
type McpServerSummary = { name: string; enabled: boolean; connected: boolean; tools: string[]; error?: string };

export default function App() {
  const [grantedFolders, setGrantedFolders] = useState<string[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState(0);
  const [resumeLatest, setResumeLatest] = useState(true);

  useEffect(() => {
    async function initialize() {
      await invoke("spawn_sidecar");
      const [foldersResult, skillsResult, toolsResult, mcpResult] = await Promise.all([
        invoke<{ folders: string[] }>("list_granted_folders"),
        invoke<{ skills: SkillSummary[] }>("list_skills"),
        invoke<{ tools: string[] }>("list_tools"),
        invoke<{ servers: McpServerSummary[] }>("call_sidecar", { method: "mcp_status", params: {} }),
      ]);

      const folders = foldersResult.folders ?? [];
      setGrantedFolders(folders);
      setSelectedFolder((current) => current ?? folders[0] ?? null);
      setSkills(skillsResult.skills ?? []);
      setTools(toolsResult.tools ?? []);
      setMcpServers(mcpResult.servers ?? []);
    }

    initialize().catch((error) => {
      console.error("Failed to initialize sidecar", error);
    });
  }, []);

  function startNewTask() {
    setResumeLatest(false);
    setChatKey((key) => key + 1);
  }

  function selectFolder(folder: string | null) {
    setSelectedFolder(folder);
    setResumeLatest(true);
    setChatKey((key) => key + 1);
  }

  return (
    <div className="app-shell">
      <Sidebar
        grantedFolders={grantedFolders}
        skills={skills}
        tools={tools}
        mcpServers={mcpServers}
        selectedFolder={selectedFolder}
        onSelectFolder={selectFolder}
        onFoldersChange={setGrantedFolders}
        onNewTask={startNewTask}
      />

      <main className="workspace">
        <header className="topbar">
          <div className="workspace-indicator">
            {selectedFolder ? (
              <>
                <span className="status-dot" />
                <span>{selectedFolder.split(/[\\/]/).pop()}</span>
              </>
            ) : (
              <span>Select a workspace to begin</span>
            )}
          </div>
          <div className="topbar-actions">
            <button className="icon-button" aria-label="Task notes" title="Task notes">
              <Icon name="document" size={17} />
            </button>
            <button className="download-button" type="button">
              <Icon name="download" size={17} />
              Export
            </button>
          </div>
        </header>

        <Chat key={chatKey} folder={selectedFolder} resumeLatest={resumeLatest} />
      </main>
    </div>
  );
}
