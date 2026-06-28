import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArtifactPanel, ArtifactPreviewPanel, shortPath } from "./Chat";
import { Icon } from "./Icon";
import type { ArtifactPreviewResult, ArtifactSummary, LocalApiClient } from "../lib/local-api";

type Props = {
  localApi: LocalApiClient | null;
  workspaces: string[];
  selectedWorkspace: string | null;
  onSelectWorkspace: (workspace: string) => void;
  onGrantWorkspace: () => void;
};

type ArtifactFilter = "all" | "created" | "updated" | "attached" | "missing";

export function FilesPage({
  localApi,
  workspaces,
  selectedWorkspace,
  onSelectWorkspace,
  onGrantWorkspace,
}: Props) {
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ArtifactFilter>("all");
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreviewResult | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);

  const availableArtifacts = useMemo(
    () => artifacts.filter((artifact) => artifact.exists !== false),
    [artifacts],
  );
  const missingArtifacts = useMemo(
    () => artifacts.filter((artifact) => artifact.exists === false),
    [artifacts],
  );
  const visibleArtifacts = useMemo(() => {
    if (filter === "missing") return missingArtifacts;
    if (filter === "all") return availableArtifacts;
    return availableArtifacts.filter((artifact) => artifact.kind === filter);
  }, [availableArtifacts, filter, missingArtifacts]);
  const generatedCount = availableArtifacts.filter((artifact) => artifact.kind !== "attached").length;
  const attachedCount = availableArtifacts.filter((artifact) => artifact.kind === "attached").length;

  useEffect(() => {
    let disposed = false;
    setArtifactPreview(null);
    if (!localApi || !selectedWorkspace) {
      setArtifacts([]);
      return () => { disposed = true; };
    }

    setLoading(true);
    setError(null);
    localApi.listWorkspaceArtifacts(selectedWorkspace)
      .then((nextArtifacts) => {
        if (!disposed) setArtifacts(nextArtifacts);
      })
      .catch((err) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    return () => { disposed = true; };
  }, [localApi, selectedWorkspace]);

  async function refresh() {
    if (!localApi || !selectedWorkspace) return;
    setLoading(true);
    setError(null);
    try {
      setArtifacts(await localApi.listWorkspaceArtifacts(selectedWorkspace));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function previewArtifact(artifact: ArtifactSummary) {
    if (!localApi) return;
    setPreviewLoadingId(artifact.id);
    try {
      setArtifactPreview(await localApi.previewArtifact(artifact.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoadingId(null);
    }
  }

  async function openArtifact(artifact: ArtifactSummary) {
    try {
      await invoke("open_path", { path: artifact.path });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function revealArtifact(artifact: ArtifactSummary) {
    try {
      await invoke("reveal_path", { path: artifact.path });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (workspaces.length === 0) {
    return (
      <section className="files-page files-page--empty">
        <div className="files-empty-state">
          <Icon name="folder" size={24} />
          <h1>Files</h1>
          <p>Grant a workspace to view generated files and attachments.</p>
          <button className="workspace-cta" type="button" onClick={onGrantWorkspace}>
            <Icon name="plus" size={16} />
            Grant workspace
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="files-page" aria-label="Workspace files">
      <header className="files-page-header">
        <div>
          <span>Files</span>
          <h1>{selectedWorkspace ? workspaceName(selectedWorkspace) : "Workspace files"}</h1>
          {selectedWorkspace && <p>{selectedWorkspace}</p>}
        </div>
        <button className="files-refresh-button" type="button" disabled={loading} onClick={() => void refresh()}>
          <Icon name="refresh" size={15} />
          <span>{loading ? "Refreshing" : "Refresh"}</span>
        </button>
      </header>

      <div className="files-workspace-tabs" aria-label="Workspaces">
        {workspaces.map((workspace) => (
          <button
            type="button"
            key={workspace}
            className={workspace === selectedWorkspace ? "is-selected" : ""}
            title={workspace}
            onClick={() => onSelectWorkspace(workspace)}
          >
            <Icon name="folder" size={14} />
            <span>{workspaceName(workspace)}</span>
          </button>
        ))}
      </div>

      <div className="files-summary">
        <SummaryMetric label="Available" value={String(availableArtifacts.length)} />
        <SummaryMetric label="Generated" value={String(generatedCount)} />
        <SummaryMetric label="Attached" value={String(attachedCount)} />
        <SummaryMetric label="Missing" value={String(missingArtifacts.length)} />
      </div>

      <div className="files-filters" aria-label="File filters">
        {(["all", "created", "updated", "attached", "missing"] as ArtifactFilter[]).map((item) => (
          <button
            type="button"
            key={item}
            className={filter === item ? "is-selected" : ""}
            onClick={() => setFilter(item)}
          >
            {filterLabel(item)}
          </button>
        ))}
      </div>

      {error && <div className="files-error">{error}</div>}

      <div className="files-content">
        <div>
          <ArtifactPanel
            artifacts={visibleArtifacts}
            loadingPreviewId={previewLoadingId}
            previewId={artifactPreview?.artifact.id ?? null}
            onPreview={localApi ? previewArtifact : undefined}
            onOpen={openArtifact}
            onReveal={revealArtifact}
          />
          {!loading && artifacts.length === 0 && (
            <div className="files-empty-list">
              <Icon name="document" size={20} />
              <strong>No files yet</strong>
              <span>Generated files for this workspace will appear here.</span>
            </div>
          )}
          {!loading && artifacts.length > 0 && visibleArtifacts.length === 0 && (
            <div className="files-empty-list">
              <Icon name="search" size={20} />
              <strong>No matches</strong>
              <span>{emptyFilterMessage(filter, selectedWorkspace)}</span>
            </div>
          )}
        </div>

        <aside className="files-preview-column">
          {artifactPreview ? (
            <ArtifactPreviewPanel result={artifactPreview} onClose={() => setArtifactPreview(null)} />
          ) : (
            <div className="files-preview-empty">
              <Icon name="eye" size={20} />
              <strong>Preview</strong>
              <span>Select a file to preview it here.</span>
              {visibleArtifacts[0] && <small>Latest: {shortPath(visibleArtifacts[0].path)}</small>}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function workspaceName(workspace: string) {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}

function filterLabel(filter: ArtifactFilter) {
  if (filter === "all") return "All";
  if (filter === "created") return "Created";
  if (filter === "updated") return "Updated";
  if (filter === "missing") return "Missing";
  return "Attached";
}

function emptyFilterMessage(filter: ArtifactFilter, selectedWorkspace: string | null) {
  const workspace = workspaceName(selectedWorkspace ?? "");
  if (filter === "all") return `No available files in ${workspace}.`;
  if (filter === "missing") return `No missing files in ${workspace}.`;
  return `No ${filterLabel(filter).toLowerCase()} files in ${workspace}.`;
}
