import { useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon";
import type { LocalApiClient, ProviderProfile, ProviderProfileInput, ProviderType } from "../lib/local-api";

type Props = {
  localApi: LocalApiClient | null;
  providers: ProviderProfile[];
  selectedProviderId: string | null;
  onClose: () => void;
  onSelectProvider: (providerId: string | null) => void;
  onProvidersChange: (providers: ProviderProfile[]) => void;
  onRefreshProviders: () => void;
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

export function ProviderSettings({
  localApi,
  providers,
  selectedProviderId,
  onClose,
  onSelectProvider,
  onProvidersChange,
  onRefreshProviders,
}: Props) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);

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

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Provider settings">
      <div className="settings-panel">
        <header className="settings-header">
          <div>
            <strong>Providers</strong>
            <span>{providers.length} configured</span>
          </div>
          <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}>
            <Icon name="x" size={17} />
          </button>
        </header>

        <div className="settings-body">
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
      </div>
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
