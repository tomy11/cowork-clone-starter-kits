import { useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon";
import type {
  ExtensionSummary,
  LocalApiClient,
  McpServerSummary,
  ProviderProfile,
  ProviderProfileInput,
  ProviderType,
  SkillSummary,
} from "../lib/local-api";

type Props = {
  localApi: LocalApiClient | null;
  providers: ProviderProfile[];
  skills: SkillSummary[];
  extensions: ExtensionSummary[];
  tools: string[];
  mcpServers: McpServerSummary[];
  selectedFolder: string | null;
  selectedProviderId: string | null;
  initialTab?: SettingsTab;
  onClose?: () => void;
  onSelectProvider: (providerId: string | null) => void;
  onProvidersChange: (providers: ProviderProfile[]) => void;
  onRefreshProviders: () => void;
  onRefreshExtensions: () => void;
  onRefreshMcp: () => Promise<void>;
};

type FormState = {
  id: string | null;
  type: ProviderType;
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  isDefault: boolean;
};

const emptyForm: FormState = {
  id: null,
  type: "claude",
  name: "Claude",
  model: "claude-sonnet-4-5",
  baseUrl: "",
  apiKey: "",
  enabled: true,
  isDefault: false,
};

const providerDefaults: Record<ProviderType, Pick<FormState, "name" | "model" | "baseUrl">> = {
  claude: { name: "Claude", model: "claude-sonnet-4-5", baseUrl: "" },
  "openai-compatible": { name: "OpenAI Compatible", model: "gpt-4o", baseUrl: "" },
  ollama: { name: "Ollama", model: "llama3.2", baseUrl: "http://localhost:11434/v1" },
  mock: { name: "Mock", model: "mock", baseUrl: "" },
};

export type SettingsTab = "providers" | "skills" | "mcp" | "extensions";

export function ProviderSettings({
  localApi,
  providers,
  skills,
  extensions,
  tools,
  mcpServers,
  selectedFolder,
  selectedProviderId,
  initialTab = "providers",
  onClose,
  onSelectProvider,
  onProvidersChange,
  onRefreshProviders,
  onRefreshExtensions,
  onRefreshMcp,
}: Props) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const [mcpStatus, setMcpStatus] = useState<string | null>(null);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === form.id) ?? null,
    [providers, form.id],
  );

  useEffect(() => {
    const provider = providers.find((item) => item.id === selectedProviderId) ?? providers[0];
    if (provider) {
      setForm(fromProvider(provider));
      setModelOptions([]);
    }
  }, [providers, selectedProviderId]);

  function updateType(type: ProviderType) {
    const next = providerDefaults[type];
    setForm((current) => ({
      ...current,
      type,
      name: current.id ? current.name : next.name,
      model: next.model,
      baseUrl: next.baseUrl,
      apiKey: "",
    }));
    setModelOptions([]);
  }

  function resetForm() {
    setForm(emptyForm);
    setStatus(null);
    setModelOptions([]);
  }

  function applyOllamaPreset() {
    setForm((current) => ({
      ...current,
      type: "ollama",
      name: current.name || "Ollama",
      model: current.model || "llama3.2",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      enabled: true,
    }));
    setModelOptions([]);
    setStatus("Ollama preset applied");
  }

  async function refreshFromServer(nextSelectedId?: string | null) {
    if (!localApi) return;
    const nextProviders = await localApi.listProviders();
    onProvidersChange(nextProviders);
    if (nextSelectedId !== undefined) onSelectProvider(nextSelectedId);
  }

  async function saveProvider() {
    if (!localApi || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const input = toProviderInput(form, Boolean(form.id));
      const saved = form.id
        ? await localApi.updateProvider(form.id, input)
        : await localApi.createProvider(input as ProviderProfileInput);
      await refreshFromServer(saved.id);
      setForm(fromProvider(saved));
      setModelOptions([]);
      setStatus("Saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function deleteProvider() {
    if (!localApi || !form.id || busy) return;
    if (!window.confirm(`Delete "${form.name}"?`)) return;
    setBusy(true);
    setStatus(null);
    try {
      await localApi.deleteProvider(form.id);
      await refreshFromServer(null);
      resetForm();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function setDefault() {
    if (!localApi || !form.id || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const provider = await localApi.setDefaultProvider(form.id);
      await refreshFromServer(provider.id);
      setForm(fromProvider(provider));
      setStatus("Default updated");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function testProvider() {
    if (!localApi || !form.id || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await localApi.testProvider(form.id);
      setStatus(result.detail);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function refreshModels() {
    if (!localApi || !form.id || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await localApi.listProviderModels(form.id);
      setModelOptions(result.models);
      if (result.models.length > 0 && !result.models.includes(form.model)) {
        setForm((current) => ({ ...current, model: result.models[0] }));
      }
      setStatus(result.detail);
    } catch (error) {
      setModelOptions([]);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function connectMcp(serverName: string) {
    if (!selectedFolder || mcpBusy) return;
    setMcpBusy(serverName);
    setMcpStatus(null);
    try {
      if (!localApi) throw new Error("Local API is not ready");
      await localApi.connectMcp(serverName, selectedFolder);
      await onRefreshMcp();
      setMcpStatus(`${serverName} connected`);
    } catch (error) {
      setMcpStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setMcpBusy(null);
    }
  }

  async function disconnectMcp(serverName: string) {
    if (mcpBusy) return;
    setMcpBusy(serverName);
    setMcpStatus(null);
    try {
      if (!localApi) throw new Error("Local API is not ready");
      await localApi.disconnectMcp(serverName);
      await onRefreshMcp();
      setMcpStatus(`${serverName} disconnected`);
    } catch (error) {
      setMcpStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setMcpBusy(null);
    }
  }

  const pageTitle = settingsPageTitle(initialTab);
  const pageSubtitle = settingsPageSubtitle(initialTab, { providers, skills, mcpServers, extensions, tools });

  return (
    <section className={`settings-page settings-page--${initialTab}`} aria-label={pageTitle}>
      <div className="settings-panel">
        <header className="settings-header">
          <div>
            <strong>{pageTitle}</strong>
            <span>{pageSubtitle}</span>
          </div>
          {onClose && (
            <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}>
              <Icon name="x" size={17} />
            </button>
          )}
        </header>

        <section className="settings-content settings-content--page">
          {initialTab === "providers" && (
            <div className="provider-settings-grid">
              <aside className="provider-list" aria-label="Provider profiles">
                <button className="provider-add" type="button" onClick={resetForm}>
                  <Icon name="plus" size={15} />
                  <span>New provider</span>
                </button>
                {providers.map((provider) => (
                  <button
                    type="button"
                    key={provider.id}
                    className={`provider-row${provider.id === form.id ? " is-selected" : ""}`}
                    onClick={() => {
                      setForm(fromProvider(provider));
                      onSelectProvider(provider.id);
                      setStatus(null);
                    }}
                  >
                    <span className="provider-type">{provider.type === "openai-compatible" ? "OpenAI" : provider.type}</span>
                    <strong>{provider.name}</strong>
                    <small>{provider.model}</small>
                    {provider.isDefault && <i>Default</i>}
                  </button>
                ))}
              </aside>

              <section className="provider-form">
                <div className="field-row">
                  <label>
                    <span>Type</span>
                    <select value={form.type} onChange={(event) => updateType(event.target.value as ProviderType)}>
                      <option value="claude">Claude</option>
                      <option value="openai-compatible">OpenAI-compatible</option>
                      <option value="ollama">Ollama</option>
                      <option value="mock">Mock</option>
                    </select>
                  </label>
                  <label>
                    <span>Name</span>
                    <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
                  </label>
                </div>

                <label>
                  <span>Model</span>
                  <input
                    value={form.model}
                    list="provider-model-options"
                    onChange={(event) => setForm({ ...form, model: event.target.value })}
                  />
                  <datalist id="provider-model-options">
                    {modelOptions.map((model) => <option value={model} key={model} />)}
                  </datalist>
                </label>

                <label>
                  <span>Base URL</span>
                  <input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
                </label>

                <label>
                  <span>API key</span>
                  <input
                    type="password"
                    value={form.apiKey}
                    placeholder={selectedProvider?.hasApiKey ? "Saved key" : ""}
                    onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                  />
                </label>

                <div className="toggle-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                    />
                    <span>Enabled</span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={form.isDefault}
                      onChange={(event) => setForm({ ...form, isDefault: event.target.checked })}
                    />
                    <span>Default</span>
                  </label>
                </div>

                {status && <p className="settings-status">{status}</p>}

                <footer className="settings-actions">
                  <button type="button" className="button-secondary" onClick={applyOllamaPreset} disabled={busy}>
                    Ollama preset
                  </button>
                  <button type="button" className="button-secondary" onClick={onRefreshProviders} disabled={busy}>
                    Refresh
                  </button>
                  <button type="button" className="button-secondary" onClick={refreshModels} disabled={busy || !form.id}>
                    Refresh models
                  </button>
                  <button type="button" className="button-secondary" onClick={testProvider} disabled={busy || !form.id}>
                    Test
                  </button>
                  <button type="button" className="button-secondary" onClick={setDefault} disabled={busy || !form.id}>
                    Set default
                  </button>
                  <button type="button" className="button-danger" onClick={deleteProvider} disabled={busy || !form.id}>
                    Delete
                  </button>
                  <button type="button" className="button-primary" onClick={saveProvider} disabled={busy}>
                    Save
                  </button>
                </footer>
              </section>
            </div>
          )}

          {initialTab === "skills" && <SkillsPanel skills={skills} tools={tools} />}

          {initialTab === "mcp" && (
            <McpPanel
              servers={mcpServers}
              selectedFolder={selectedFolder}
              busyServer={mcpBusy}
              status={mcpStatus}
              onRefresh={() => void onRefreshMcp()}
              onConnect={(server) => void connectMcp(server)}
              onDisconnect={(server) => void disconnectMcp(server)}
            />
          )}

          {initialTab === "extensions" && (
            <ExtensionsPanel extensions={extensions} localApi={localApi} onRefresh={onRefreshExtensions} />
          )}
        </section>
      </div>
    </section>
  );
}

function SkillsPanel({ skills }: { skills: SkillSummary[]; tools: string[] }) {
  const [activeSkillTab, setActiveSkillTab] = useState<"installed" | "marketplace" | "created">("installed");
  const [enabledSkills, setEnabledSkills] = useState<Record<string, boolean>>({});
  return (
    <div className="settings-surface skills-page-surface">
      <div className="skills-toolbar">
        <div className="skills-tabs" role="tablist" aria-label="Skill sections">
          <button
            type="button"
            role="tab"
            aria-selected={activeSkillTab === "installed"}
            className={`skills-tab${activeSkillTab === "installed" ? " is-selected" : ""}`}
            onClick={() => setActiveSkillTab("installed")}
          >
            Installed
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeSkillTab === "marketplace"}
            className={`skills-tab${activeSkillTab === "marketplace" ? " is-selected" : ""}`}
            onClick={() => setActiveSkillTab("marketplace")}
          >
            Marketplace
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeSkillTab === "created"}
            className={`skills-tab${activeSkillTab === "created" ? " is-selected" : ""}`}
            onClick={() => setActiveSkillTab("created")}
          >
            Created by AI
          </button>
        </div>

        <div className="skills-toolbar-actions">
          <button type="button" className="skills-import-button">
            <Icon name="plus" size={15} />
            <span>Import skill</span>
          </button>
        </div>
      </div>

      {activeSkillTab === "installed" && (
        <>
          <section className="skill-card-section">
            <div className="skill-card-grid">
              {skills.length === 0 ? (
                <p className="settings-empty">No skills found</p>
              ) : (
                skills.map((skill, index) => {
                  const enabled = enabledSkills[skill.name] ?? true;
                  return (
                    <article className="skill-card" key={skill.name}>
                      <div className="skill-card-heading">
                        <span className={`skill-card-icon skill-card-icon--${index % 6}`}>
                          {skill.name.slice(0, 1).toUpperCase()}
                        </span>
                        <div>
                          <strong>{skill.name}</strong>
                          <span>{skillCategory(skill.name)}</span>
                        </div>
                        <button
                          type="button"
                          className={`skill-toggle${enabled ? " is-on" : ""}`}
                          aria-label={`${enabled ? "Disable" : "Enable"} ${skill.name}`}
                          aria-pressed={enabled}
                          onClick={() => setEnabledSkills((current) => ({ ...current, [skill.name]: !enabled }))}
                        >
                          <span />
                        </button>
                      </div>
                      <p>{skill.description || "No description"}</p>
                      <div className="skill-card-footer">
                        <div className="skill-card-meta">
                          <Icon name="shield" size={14} />
                          <span>Files</span>
                        </div>
                        <div className={`skill-card-runs${enabled ? " is-ready" : ""}`}>
                          <span />
                          {skillRuns(skill.name)} runs
                        </div>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        </>
      )}

      {activeSkillTab === "marketplace" && (
        <div className="skills-empty-page">
          <Icon name="book" size={20} />
          <strong>Marketplace</strong>
          <span>No marketplace skills available yet</span>
        </div>
      )}

      {activeSkillTab === "created" && (
        <div className="skills-empty-page">
          <Icon name="brain" size={20} />
          <strong>Created by AI</strong>
          <span>No AI-created skills yet</span>
        </div>
      )}
    </div>
  );
}

function skillCategory(name: string) {
  const value = name.toLowerCase();
  if (value.includes("pdf") || value.includes("doc") || value.includes("slide")) return "Documents";
  if (value.includes("research") || value.includes("web")) return "Research";
  if (value.includes("data") || value.includes("sheet") || value.includes("csv")) return "Data";
  if (value.includes("git") || value.includes("code") || value.includes("commit")) return "Dev";
  if (value.includes("email") || value.includes("write")) return "Writing";
  return "Workspace";
}

function skillRuns(name: string) {
  return 30 + Array.from(name).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 320;
}

function McpPanel({
  servers,
  selectedFolder,
  busyServer,
  status,
  onRefresh,
  onConnect,
  onDisconnect,
}: {
  servers: McpServerSummary[];
  selectedFolder: string | null;
  busyServer: string | null;
  status: string | null;
  onRefresh: () => void;
  onConnect: (serverName: string) => void;
  onDisconnect: (serverName: string) => void;
}) {
  return (
    <div className="settings-surface">
      <div className="settings-surface-header">
        <div>
          <strong>MCP Servers</strong>
          <span>{servers.filter((server) => server.connected).length}/{servers.length} connected</span>
        </div>
        <button type="button" className="button-secondary" onClick={onRefresh}>Refresh</button>
      </div>
      {status && <p className="settings-status">{status}</p>}
      {servers.length === 0 ? (
        <p className="settings-empty">No MCP servers configured</p>
      ) : (
        <div className="settings-list">
          {servers.map((server) => (
            <div className="settings-resource-row settings-resource-row--actions" key={server.name}>
              <span className={`mcp-dot${server.connected ? " is-connected" : ""}`} />
              <div>
                <strong>{server.name}</strong>
                <span>{server.tools.length} tools{server.error ? ` · ${server.error}` : ""}</span>
              </div>
              {server.connected ? (
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busyServer === server.name}
                  onClick={() => onDisconnect(server.name)}
                >
                  Disconnect
                </button>
              ) : (
                <button
                  type="button"
                  className="button-primary"
                  disabled={!selectedFolder || busyServer === server.name}
                  onClick={() => onConnect(server.name)}
                >
                  Connect
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ExtensionsPanel({
  extensions,
  localApi,
  onRefresh,
}: {
  extensions: ExtensionSummary[];
  localApi: LocalApiClient | null;
  onRefresh: () => void;
}) {
  const [togglingId, setTogglingId] = useState<string | null>(null);

  async function toggleExtension(extension: ExtensionSummary) {
    if (!localApi || togglingId) return;
    setTogglingId(extension.id);
    try {
      await localApi.setExtensionEnabled(extension.id, !extension.enabled);
      onRefresh();
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <div className="settings-surface">
      <div className="settings-surface-header">
        <div>
          <strong>Extensions</strong>
          <span>{extensions.filter((extension) => extension.status === "ready").length}/{extensions.length} ready</span>
        </div>
        <button type="button" className="button-secondary" onClick={onRefresh}>Refresh</button>
      </div>
      {extensions.length === 0 ? (
        <p className="settings-empty">No local extension manifests found</p>
      ) : (
        <div className="settings-list">
          {extensions.map((extension) => (
            <div className="extension-detail-row" key={extension.id}>
              <span className={`extension-status extension-status--${extension.status}`} />
              <div>
                <strong>{extension.name}</strong>
                <span>{extension.description || extension.manifestPath}</span>
                <small>{extensionResourceSummary(extension)}</small>
                {extension.checks.missingResources.length > 0 && (
                  <em>{extension.checks.missingResources.map((resource) => `${resource.type}:${resource.name}`).join(", ")}</em>
                )}
                {extension.setup.missingEnv.length > 0 && <em>{extension.setup.missingEnv.join(", ")}</em>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <small>{formatExtensionStatus(extension.status)}</small>
                {localApi && (
                  <button
                    type="button"
                    className="button-secondary"
                    style={{ fontSize: "12px", padding: "2px 8px" }}
                    disabled={togglingId === extension.id}
                    onClick={() => void toggleExtension(extension)}
                  >
                    {extension.enabled ? "Disable" : "Enable"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fromProvider(provider: ProviderProfile): FormState {
  return {
    id: provider.id,
    type: provider.type,
    name: provider.name,
    model: provider.model,
    baseUrl: provider.baseUrl ?? "",
    apiKey: "",
    enabled: provider.enabled,
    isDefault: provider.isDefault,
  };
}

function toProviderInput(form: FormState, partial: boolean): Partial<ProviderProfileInput> {
  const apiKey = form.apiKey.trim();
  const input: Partial<ProviderProfileInput> = {
    type: form.type,
    name: form.name.trim(),
    model: form.model.trim(),
    baseUrl: form.baseUrl.trim() || null,
    enabled: form.enabled,
    isDefault: form.isDefault,
  };
  if (!partial || apiKey) input.apiKey = apiKey || null;
  return input;
}

function settingsPageTitle(tab: SettingsTab) {
  if (tab === "providers") return "Providers";
  if (tab === "skills") return "Skills";
  if (tab === "mcp") return "MCP";
  return "Extensions";
}

function settingsPageSubtitle(
  tab: SettingsTab,
  data: {
    providers: ProviderProfile[];
    skills: SkillSummary[];
    mcpServers: McpServerSummary[];
    extensions: ExtensionSummary[];
    tools: string[];
  },
) {
  if (tab === "providers") return `${data.providers.length} provider profiles`;
  if (tab === "skills") return `Install, manage and create agent skills · ${data.skills.length} skills · ${data.tools.length} tools`;
  if (tab === "mcp") {
    return `${data.mcpServers.filter((server) => server.connected).length}/${data.mcpServers.length} servers connected`;
  }
  return `${data.extensions.filter((extension) => extension.status === "ready").length}/${data.extensions.length} extensions ready`;
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

function formatExtensionStatus(status: ExtensionSummary["status"]) {
  return status.replace("_", " ");
}
