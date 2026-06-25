import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Icon, type IconName } from "./Icon";

type SkillSummary = { name: string; description?: string };
type McpServerSummary = { name: string; enabled: boolean; connected: boolean; tools: string[]; error?: string };

type Props = {
  grantedFolders: string[];
  skills: SkillSummary[];
  tools: string[];
  mcpServers: McpServerSummary[];
  selectedFolder: string | null;
  onSelectFolder: (folder: string | null) => void;
  onFoldersChange: (folders: string[]) => void;
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
  tools,
  mcpServers,
  selectedFolder,
  onSelectFolder,
  onFoldersChange,
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

    await invoke("grant_folder", { folder: selected });
    const nextFolders = folders.includes(selected) ? folders : [...folders, selected];
    setFolders(nextFolders);
    onFoldersChange(nextFolders);
    onSelectFolder(selected);
  }

  function newTask() {
    onNewTask();
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

        {(skills.length > 0 || tools.length > 0) && (
          <section className="sidebar-section sidebar-section--meta">
            <div className="section-heading"><span>Available</span></div>
            <p>{skills.length} skills · {tools.length} tools</p>
          </section>
        )}

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
