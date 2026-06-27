import { useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import type { SettingsTab } from "./ProviderSettings";
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
  onSessionsChange: (sessions: SessionSummary[]) => void;
  onRefreshSessions: () => void;
  onRefreshExtensions: () => void;
  onNewTask: () => void;
  onFocusAssets: () => void;
  onOpenSettingsTab: (tab: SettingsTab) => void;
  onGrantWorkspace: () => void;
  onToggleTerminal: () => void;
  terminalOpen: boolean;
};

type NavAction = "sessions" | "files" | "skills" | "extensions";

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
  onSessionsChange,
  onRefreshSessions,
  onRefreshExtensions,
  onNewTask,
  onFocusAssets,
  onOpenSettingsTab,
  onGrantWorkspace,
  onToggleTerminal,
  terminalOpen,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const sessionsRef = useRef<HTMLElement>(null);

  const navItems: Array<{ label: string; icon: IconName; action: NavAction }> = [
    { label: "Sessions", icon: "document", action: "sessions" },
    ...(selectedSessionId ? [{ label: "Files", icon: "folder" as IconName, action: "files" as NavAction }] : []),
    { label: "Skills", icon: "book", action: "skills" },
    { label: "Extensions", icon: "code", action: "extensions" },
  ];

  function newTask() {
    onNewTask();
  }

  function runNavAction(action: NavAction) {
    if (action === "sessions") sessionsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    else if (action === "files") onFocusAssets();
    else if (action === "skills") onOpenSettingsTab("skills");
    else if (action === "extensions") onOpenSettingsTab("extensions");
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
          {navItems.map((item) => (
            <button className="nav-item" type="button" key={item.label} onClick={() => runNavAction(item.action)}>
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <section className="sidebar-section">
          <div className="section-heading">
            <span>Workspaces</span>
            <button type="button" aria-label="Add workspace" onClick={onGrantWorkspace}>
              <Icon name="plus" size={15} />
            </button>
          </div>
          {grantedFolders.length === 0 ? (
            <button className="empty-workspace" type="button" onClick={onGrantWorkspace}>
              Grant workspace
            </button>
          ) : (
            <div className="sidebar-list">
              {grantedFolders.map((folder) => (
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

        <section className="sidebar-section" ref={sessionsRef}>
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

      <footer className="account-row" aria-label="Workspace tools">
        <button type="button" className="footer-action" title="Settings" onClick={() => onOpenSettingsTab("providers")}>
          <Icon name="settings" size={16} />
          <span>Settings</span>
        </button>
        <button type="button" className={`footer-action${terminalOpen ? " is-active" : ""}`} title="Terminal" onClick={onToggleTerminal}>
          <Icon name="code" size={16} />
          <span>Terminal</span>
        </button>
        <button type="button" className="footer-action" title="MCP" onClick={() => onOpenSettingsTab("mcp")}>
          <Icon name="plug" size={16} />
          <span>MCP</span>
        </button>
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
