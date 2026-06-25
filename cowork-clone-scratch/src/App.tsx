import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Chat } from "./components/Chat";
import { Sidebar } from "./components/Sidebar";
import { Icon } from "./components/Icon";
import { LocalApiClient, type McpServerSummary, type SessionSummary, type SkillSummary } from "./lib/local-api";

type SidecarBootstrap = { httpUrl: string };

export default function App() {
  const [grantedFolders, setGrantedFolders] = useState<string[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [localApi, setLocalApi] = useState<LocalApiClient | null>(null);
  const [chatKey, setChatKey] = useState(0);
  const [resumeLatest, setResumeLatest] = useState(true);

  useEffect(() => {
    async function initialize() {
      const bootstrap = await invoke<SidecarBootstrap>("spawn_sidecar");
      const api = new LocalApiClient(bootstrap.httpUrl);
      await api.waitForHealth();
      setLocalApi(api);
      const [folders, skillsResult, toolsResult, mcpResult] = await Promise.all([
        api.listWorkspaces(),
        invoke<{ skills: SkillSummary[] }>("list_skills"),
        invoke<{ tools: string[] }>("list_tools"),
        invoke<{ servers: McpServerSummary[] }>("call_sidecar", { method: "mcp_status", params: {} }),
      ]);

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

  useEffect(() => {
    if (!localApi || !selectedFolder) {
      setSessions([]);
      setSelectedSessionId(null);
      return;
    }
    void refreshSessions(selectedFolder);
  }, [localApi, selectedFolder]);

  async function refreshSessions(folder = selectedFolder) {
    if (!localApi || !folder) return;
    const nextSessions = await localApi.listSessions(folder);
    setSessions(nextSessions);
    setSelectedSessionId((current) =>
      current && nextSessions.some((session) => session.id === current)
        ? current
        : nextSessions[0]?.id ?? null,
    );
  }

  function startNewTask() {
    setResumeLatest(false);
    setSelectedSessionId(null);
    setChatKey((key) => key + 1);
  }

  function selectFolder(folder: string | null) {
    setSelectedFolder(folder);
    setResumeLatest(true);
    setChatKey((key) => key + 1);
  }

  function selectSession(sessionId: string | null) {
    setSelectedSessionId(sessionId);
    setResumeLatest(false);
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
        sessions={sessions}
        selectedSessionId={selectedSessionId}
        localApi={localApi}
        onSelectFolder={selectFolder}
        onSelectSession={selectSession}
        onFoldersChange={setGrantedFolders}
        onSessionsChange={setSessions}
        onRefreshSessions={() => void refreshSessions()}
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

        <Chat
          key={chatKey}
          folder={selectedFolder}
          sessionId={selectedSessionId}
          resumeLatest={resumeLatest}
          localApi={localApi}
          onSessionCreated={(session) => {
            setSelectedSessionId(session.id);
            void refreshSessions(session.workspace);
          }}
        />
      </main>
    </div>
  );
}
