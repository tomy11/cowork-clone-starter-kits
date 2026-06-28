import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Chat } from "./components/Chat";
import { FilesPage } from "./components/FilesPage";
import { ProviderSettings, type SettingsTab } from "./components/ProviderSettings";
import { Sidebar } from "./components/Sidebar";
import { TerminalDock } from "./components/TerminalDock";
import {
  LocalApiClient,
  type ExtensionSummary,
  type McpServerSummary,
  type ProviderProfile,
  type SessionSummary,
  type SkillSummary,
} from "./lib/local-api";

type SidecarBootstrap = { httpUrl: string };
type MainView = "chat" | "files" | "settings";

export default function App() {
  const [grantedFolders, setGrantedFolders] = useState<string[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [extensions, setExtensions] = useState<ExtensionSummary[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [localApi, setLocalApi] = useState<LocalApiClient | null>(null);
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>("providers");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [chatKey, setChatKey] = useState(0);
  const [resumeLatest, setResumeLatest] = useState(true);
  const [mainView, setMainView] = useState<MainView>("chat");

  useEffect(() => {
    async function initialize() {
      const isTauri = "__TAURI_INTERNALS__" in window;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const devUrl = !isTauri && ((import.meta as any).env?.VITE_SIDECAR_URL as string | undefined);
      const bootstrap = devUrl
        ? { httpUrl: devUrl }
        : await invoke<SidecarBootstrap>("spawn_sidecar");
      const api = new LocalApiClient(bootstrap.httpUrl);
      await api.waitForHealth();
      setLocalApi(api);
      const [folders, providersResult, extensionsResult, skillsResult, toolsResult, mcpResult] = await Promise.all([
        api.listWorkspaces(),
        api.listProviders(),
        api.listExtensions(),
        api.listSkills(),
        api.listTools(),
        api.listMcpServers(),
      ]);

      setGrantedFolders(folders);
      setProviders(providersResult);
      setSelectedProviderId((current) =>
        current ?? providersResult.find((provider) => provider.isDefault)?.id ?? providersResult[0]?.id ?? null,
      );
      setSelectedFolder((current) => current ?? folders[0] ?? null);
      setSkills(skillsResult);
      setExtensions(extensionsResult);
      setTools(toolsResult);
      setMcpServers(mcpResult);
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
    const [nextSessions, activeSession] = await Promise.all([
      localApi.listSessions(folder),
      localApi.activeSession(folder),
    ]);
    setSessions(nextSessions);
    setSelectedSessionId((current) =>
      current && nextSessions.some((session) => session.id === current)
        ? current
        : activeSession && nextSessions.some((session) => session.id === activeSession.id)
          ? activeSession.id
          : nextSessions[0]?.id ?? null,
    );
  }

  async function refreshProviders() {
    if (!localApi) return;
    const nextProviders = await localApi.listProviders();
    setProviders(nextProviders);
    setSelectedProviderId((current) =>
      current && nextProviders.some((provider) => provider.id === current)
        ? current
        : nextProviders.find((provider) => provider.isDefault)?.id ?? nextProviders[0]?.id ?? null,
    );
  }

  async function refreshExtensions() {
    if (!localApi) return;
    setExtensions(await localApi.listExtensions());
  }

  function startNewTask() {
    setMainView("chat");
    setResumeLatest(false);
    setSelectedSessionId(null);
    if (localApi && selectedFolder) void localApi.setActiveSession(selectedFolder, null);
    setChatKey((key) => key + 1);
  }

  function selectFolder(folder: string | null) {
    setSelectedFolder(folder);
    setResumeLatest(true);
    setChatKey((key) => key + 1);
  }

  function selectSession(sessionId: string | null) {
    setMainView("chat");
    setSelectedSessionId(sessionId);
    if (localApi && selectedFolder) void localApi.setActiveSession(selectedFolder, sessionId);
    setResumeLatest(false);
    setChatKey((key) => key + 1);
  }

  function openSettings(tab: SettingsTab) {
    setSettingsInitialTab(tab);
    setMainView("settings");
  }

  async function grantWorkspace() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    if (!localApi) throw new Error("Local API is not ready");

    await localApi.grantWorkspace(selected);
    setGrantedFolders((current) => current.includes(selected) ? current : [...current, selected]);
    selectFolder(selected);
  }

  return (
    <div className="app-shell">
      <Sidebar
        grantedFolders={grantedFolders}
        skills={skills}
        extensions={extensions}
        tools={tools}
        mcpServers={mcpServers}
        selectedFolder={selectedFolder}
        sessions={sessions}
        selectedSessionId={selectedSessionId}
        activeView={mainView}
        activeSettingsTab={settingsInitialTab}
        localApi={localApi}
        onSelectFolder={selectFolder}
        onSelectSession={selectSession}
        onSessionsChange={setSessions}
        onRefreshSessions={() => void refreshSessions()}
        onRefreshExtensions={() => void refreshExtensions()}
        onNewTask={startNewTask}
        onOpenSessions={() => setMainView("chat")}
        onOpenFiles={() => setMainView("files")}
        onOpenSettingsTab={openSettings}
        onGrantWorkspace={() => void grantWorkspace()}
        onToggleTerminal={() => setTerminalOpen((open) => !open)}
        terminalOpen={terminalOpen}
      />

      <main className="workspace">
        {mainView !== "settings" && (
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
          </header>
        )}

        {mainView === "settings" ? (
          <ProviderSettings
            localApi={localApi}
            providers={providers}
            skills={skills}
            extensions={extensions}
            tools={tools}
            mcpServers={mcpServers}
            selectedFolder={selectedFolder}
            selectedProviderId={selectedProviderId}
            initialTab={settingsInitialTab}
            onSelectProvider={setSelectedProviderId}
            onProvidersChange={(nextProviders) => {
              setProviders(nextProviders);
              setSelectedProviderId((current) =>
                current && nextProviders.some((provider) => provider.id === current)
                  ? current
                  : nextProviders.find((provider) => provider.isDefault)?.id ?? nextProviders[0]?.id ?? null,
              );
            }}
            onRefreshProviders={() => void refreshProviders()}
            onRefreshExtensions={() => void refreshExtensions()}
            onRefreshMcp={async () => {
              if (!localApi) return;
              setMcpServers(await localApi.listMcpServers());
            }}
          />
        ) : mainView === "files" ? (
          <FilesPage
            localApi={localApi}
            workspaces={grantedFolders}
            selectedWorkspace={selectedFolder}
            onSelectWorkspace={selectFolder}
            onGrantWorkspace={() => void grantWorkspace()}
          />
        ) : (
          <Chat
            key={chatKey}
            folder={selectedFolder}
            sessionId={selectedSessionId}
            resumeLatest={resumeLatest}
            localApi={localApi}
            providers={providers}
            selectedProviderId={selectedProviderId}
            onSelectProvider={setSelectedProviderId}
            onGrantWorkspace={() => void grantWorkspace()}
            onOpenProviderSettings={() => openSettings("providers")}
            onSessionCreated={(session) => {
              setSelectedSessionId(session.id);
              void localApi?.setActiveSession(session.workspace, session.id);
              void refreshSessions(session.workspace);
            }}
          />
        )}
        {terminalOpen && <TerminalDock folder={selectedFolder} onClose={() => setTerminalOpen(false)} />}
      </main>
    </div>
  );
}
