import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Icon, type IconName } from "./Icon";
import type { ExtensionSummary, LocalApiClient, McpServerSummary, SessionSummary, SkillSummary } from "../lib/local-api";

type Props = {
  grantedFolders: string[];
  skills: SkillSummary[];
  extensions: ExtensionSummary[];
  tools: string[];
  mcpServers: McpServerSummary[];
  selectedFolder: string | null;
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  localApi: LocalApiClient | null;
  onSelectFolder: (folder: string | null) => void;
  onSelectSession: (sessionId: string | null) => void;
  onFoldersChange: (folders: string[]) => void;
  onSessionsChange: (sessions: SessionSummary[]) => void;
  onRefreshSessions: () => void;
  onRefreshExtensions: () => void;
  onNewTask: () => void;
};

const primaryNav: Array<{ label: string; icon: IconName }> = [
  { label: "Search", icon: "search" },
  { label: "Skills", icon: "book" },
  { label: "Scheduled", icon: "clock" },
  { label: "Assets", icon: "folder" },
];

export function Sidebar({
  grantedFolders,
  skills,
  extensions,
  tools,
  mcpServers,
  selectedFolder,
  sessions,
  selectedSessionId,
  localApi,
  onSelectFolder,
  onSelectSession,
  onFoldersChange,
  onSessionsChange,
  onRefreshSessions,
  onRefreshExtensions,
  onNewTask,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [folders, setFolders] = useState(grantedFolders);

  useEffect(() => {
    setFolders(grantedFolders);
  }, [grantedFolders]);

  async function pickFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    if (!localApi) throw new Error("Local API is not ready");

    await localApi.grantWorkspace(selected);
    const nextFolders = folders.includes(selected) ? folders : [...folders, selected];
    setFolders(nextFolders);
    onFoldersChange(nextFolders);
    onSelectFolder(selected);
  }

  function newTask() {
    onNewTask();
  }

  async function renameSession(session: SessionSummary) {
    if (!localApi) return;
    const title = window.prompt("Rename session", session.title);
    const nextTitle = title?.trim();
    if (!nextTitle || nextTitle === session.title) return;
    const updated = await localApi.renameSession(session.id, nextTitle);
    onSessionsChange(sessions.map((item) => item.id === updated.id ? updated : item));
  }

  async function archiveSession(session: SessionSummary) {
    if (!localApi) return;
    if (!window.confirm(`Archive "${session.title}"?`)) return;
    await localApi.archiveSession(session.id, true);
    const nextSessions = sessions.filter((item) => item.id !== session.id);
    onSessionsChange(nextSessions);
    if (selectedSessionId === session.id) onSelectSession(nextSessions[0]?.id ?? null);
  }

  async function deleteSession(session: SessionSummary) {
    if (!localApi) return;
    if (!window.confirm(`Delete "${session.title}" permanently?`)) return;
    await localApi.deleteSession(session.id);
    const nextSessions = sessions.filter((item) => item.id !== session.id);
    onSessionsChange(nextSessions);
    if (selectedSessionId === session.id) onSelectSession(nextSessions[0]?.id ?? null);
  }

  return (
    <aside className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`}>
      <div className="sidebar-header">
        <div className="brand-mark" aria-label="Cowork home">
          <span />
          <span />
          <span />
        </div>
        <button
          className="sidebar-toggle"
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((value) => !value)}
        >
          <Icon name="panel" size={17} />
        </button>
      </div>

      <div className="sidebar-scroll">
        <nav className="sidebar-nav" aria-label="Main navigation">
          <button className="nav-item nav-item--active" type="button" onClick={newTask}>
            <Icon name="plusCircle" size={18} />
            <span>New task</span>
          </button>
          {primaryNav.map((item) => (
            <button className="nav-item" type="button" key={item.label}>
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <section className="sidebar-section">
          <div className="section-heading">
            <span>Workspaces</span>
            <button type="button" aria-label="Add workspace" onClick={pickFolder}>
              <Icon name="plus" size={15} />
            </button>
          </div>
          {folders.length === 0 ? (
            <button className="empty-workspace" type="button" onClick={pickFolder}>
              Grant your first folder
            </button>
          ) : (
            <div className="sidebar-list">
              {folders.map((folder) => (
                <button
                  className={`sidebar-list-item${folder === selectedFolder ? " is-selected" : ""}`}
                  type="button"
                  key={folder}
                  title={folder}
                  onClick={() => onSelectFolder(folder)}
                >
                  <Icon name="folder" size={16} />
                  <span>{folder.split(/[\\/]/).pop()}</span>
                  {folder === selectedFolder && <i className="item-dot" />}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="sidebar-section">
          <div className="section-heading"><span>Agent team</span></div>
          <div className="sidebar-list">
            <div className="agent-row"><span className="agent-avatar agent-avatar--green">G</span><span>General</span></div>
            <div className="agent-row"><span className="agent-avatar agent-avatar--red">C</span><span>Coder</span></div>
            <div className="agent-row"><span className="agent-avatar agent-avatar--yellow">V</span><span>Verifier</span></div>
          </div>
        </section>

        <section className="sidebar-section">
          <div className="section-heading">
            <span>Sessions</span>
            <button type="button" aria-label="Refresh sessions" onClick={onRefreshSessions}>
              <Icon name="refresh" size={15} />
            </button>
          </div>
          {sessions.length === 0 ? (
            <button className="empty-workspace" type="button" onClick={newTask}>
              Start a new session
            </button>
          ) : (
            <div className="sidebar-list sidebar-list--sessions">
              {sessions.map((session) => (
                <div
                  className={`session-list-item${session.id === selectedSessionId ? " is-selected" : ""}`}
                  key={session.id}
                  title={session.title}
                >
                  <button type="button" onClick={() => onSelectSession(session.id)}>
                    <Icon name="document" size={15} />
                    <span>{session.title}</span>
                  </button>
                  <div className="session-actions">
                    <button type="button" aria-label="Rename session" onClick={() => void renameSession(session)}>
                      <Icon name="edit" size={13} />
                    </button>
                    <button type="button" aria-label="Archive session" onClick={() => void archiveSession(session)}>
                      <Icon name="archive" size={13} />
                    </button>
                    <button type="button" aria-label="Delete session" onClick={() => void deleteSession(session)}>
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {(skills.length > 0 || tools.length > 0) && (
          <section className="sidebar-section sidebar-section--meta">
            <div className="section-heading"><span>Available</span></div>
            <p>{skills.length} skills · {tools.length} tools</p>
          </section>
        )}

        <section className="sidebar-section sidebar-section--extensions">
          <div className="section-heading">
            <span>Extensions</span>
            <button type="button" aria-label="Refresh extensions" onClick={onRefreshExtensions}>
              <Icon name="refresh" size={15} />
            </button>
          </div>
          {extensions.length === 0 ? (
            <div className="extension-empty">No local manifests</div>
          ) : (
            <div className="sidebar-list">
              {extensions.map((extension) => (
                <div className="extension-row" key={extension.id} title={extensionTooltip(extension)}>
                  <span className={`extension-status extension-status--${extension.status}`} />
                  <div>
                    <strong>{extension.name}</strong>
                    <span>{extensionResourceSummary(extension)}</span>
                  </div>
                  <small>{formatExtensionStatus(extension.status)}</small>
                </div>
              ))}
            </div>
          )}
        </section>

        {mcpServers.length > 0 && (
          <section className="sidebar-section sidebar-section--meta">
            <div className="section-heading"><span>MCP servers</span></div>
            <div className="sidebar-list">
              {mcpServers.map((server) => (
                <div className="agent-row" key={server.name} title={server.error}>
                  <span className={`mcp-dot${server.connected ? " is-connected" : ""}`} />
                  <span>{server.name}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <footer className="account-row">
        <div className="account-avatar">PW</div>
        <div className="account-copy">
          <strong>Prachya Worachin</strong>
          <span>Local workspace</span>
        </div>
        <Icon name="chevronDown" size={16} />
      </footer>
    </aside>
  );
}

function extensionResourceSummary(extension: ExtensionSummary) {
  const count = extension.resources.skills.length
    + extension.resources.mcpServers.length
    + extension.resources.commands.length;
  const missingEnv = extension.setup.missingEnv.length;
  const missingResources = extension.checks.missingResources.length;
  if (missingEnv > 0 || missingResources > 0) {
    const parts = [];
    if (missingEnv > 0) parts.push(`${missingEnv} env`);
    if (missingResources > 0) parts.push(`${missingResources} missing`);
    return `${count} resources · ${parts.join(" · ")}`;
  }
  const setupCount = extension.setup.requiredEnv.length;
  if (setupCount > 0) return `${count} resources · ${setupCount} env ok`;
  return `${count} resources`;
}

function extensionTooltip(extension: ExtensionSummary) {
  const missing = [
    ...extension.setup.missingEnv.map((name) => `env:${name}`),
    ...extension.checks.missingResources.map((resource) => `${resource.type}:${resource.name}`),
  ];
  if (missing.length === 0) return extension.manifestPath;
  return `${extension.manifestPath}\nMissing ${missing.join(", ")}`;
}

function formatExtensionStatus(status: ExtensionSummary["status"]) {
  return status.replace("_", " ");
}
