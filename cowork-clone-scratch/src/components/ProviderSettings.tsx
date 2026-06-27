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
  onClose: () => void;
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

const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: "providers", label: "Providers" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP" },
  { id: "extensions", label: "Extensions" },
];

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
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
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

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

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

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-panel">
        <header className="settings-header">
          <div>
            <strong>Settings</strong>
            <span>{providers.length} providers · {skills.length} skills · {mcpServers.length} MCP</span>
          </div>
          <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}>
            <Icon name="x" size={17} />
          </button>
        </header>

        <div className="settings-body">
          <aside className="settings-nav" aria-label="Settings sections">
            {settingsTabs.map((tab) => (
              <button
                type="button"
                key={tab.id}
                className={`settings-tab${activeTab === tab.id ? " is-selected" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span>{tab.label}</span>
                <small>{settingsTabCount(tab.id, { providers, skills, mcpServers, extensions })}</small>
              </button>
            ))}
          </aside>

          <section className="settings-content">
            {activeTab === "providers" && (
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

            {activeTab === "skills" && <SkillsPanel skills={skills} tools={tools} />}

            {activeTab === "mcp" && (
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

            {activeTab === "extensions" && (
              <ExtensionsPanel extensions={extensions} onRefresh={onRefreshExtensions} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function SkillsPanel({ skills, tools }: { skills: SkillSummary[]; tools: string[] }) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredSkills = normalizedQuery
    ? skills.filter((skill) => `${skill.name} ${skill.description ?? ""}`.toLowerCase().includes(normalizedQuery))
    : skills;
  const filteredTools = normalizedQuery
    ? tools.filter((tool) => tool.toLowerCase().includes(normalizedQuery))
    : tools;
  return (
    <div className="settings-surface">
      <div className="settings-surface-header">
        <div>
          <strong>Skills</strong>
          <span>{skills.length} skills · {tools.length} tools</span>
        </div>
        <label className="settings-search" aria-label="Search skills and tools">
          <Icon name="search" size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />
        </label>
      </div>

      <div className="settings-list settings-list--two">
        <section>
          <div className="settings-mini-heading">Skills</div>
          {filteredSkills.length === 0 ? (
            <p className="settings-empty">No skills found</p>
          ) : (
            filteredSkills.map((skill) => (
              <div className="settings-resource-row" key={skill.name}>
                <Icon name="book" size={15} />
                <div>
                  <strong>{skill.name}</strong>
                  <span>{skill.description || "No description"}</span>
                </div>
              </div>
            ))
          )}
        </section>

        <section>
          <div className="settings-mini-heading">Tools</div>
          {filteredTools.length === 0 ? (
            <p className="settings-empty">No tools found</p>
          ) : (
            filteredTools.map((tool) => (
              <div className="settings-resource-row" key={tool}>
                <Icon name="code" size={15} />
                <div>
                  <strong>{tool}</strong>
                  <span>Runtime tool</span>
                </div>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
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

function ExtensionsPanel({ extensions, onRefresh }: { extensions: ExtensionSummary[]; onRefresh: () => void }) {
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
              <small>{formatExtensionStatus(extension.status)}</small>
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

function settingsTabCount(
  tab: SettingsTab,
  data: {
    providers: ProviderProfile[];
    skills: SkillSummary[];
    mcpServers: McpServerSummary[];
    extensions: ExtensionSummary[];
  },
) {
  if (tab === "providers") return String(data.providers.length);
  if (tab === "skills") return String(data.skills.length);
  if (tab === "mcp") return `${data.mcpServers.filter((server) => server.connected).length}/${data.mcpServers.length}`;
  return `${data.extensions.filter((extension) => extension.status === "ready").length}/${data.extensions.length}`;
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
