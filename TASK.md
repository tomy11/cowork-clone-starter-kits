# Tasks

## เป้าหมาย MVP (2 สัปดาห์)

- [x] Folder access + permission scope
- [x] Chat UI + LLM event streaming
- [x] Single agent + tool use
- [x] File read/write tool
- [x] Sub-agent dispatcher (parallel + progress + cancel)
- [x] Skills loader + runtime activation (Anthropic spec)
- [x] MCP support (stdio, tool discovery/calls, status, confirmation)
- [x] Audit log + resumable confirm dialog
- [x] Cross-platform build configuration + CI matrix (Mac/Win/Linux)

## Capability upgrade

- [x] Sidecar → Tauri → React real-time events
- [x] Approve/deny permission while a task is running
- [x] Persistent workspaces, conversations, messages, and task status
- [x] Live sub-agent progress and cooperative/provider cancellation
- [x] Planner-selected skills injected into sub-agents
- [x] Portable multi-agent pipeline core and coding workflow preset
- [x] Local HTTP/SSE server boundary over shared app runtime
- [x] Session list, rename, archive, and delete across storage, HTTP API, and sidebar UI
- [x] Event replay and active session restore across storage, HTTP API, and chat UI
- [x] Workspace metadata for active session, session counts, and timestamps
- [x] Provider profile persistence and local HTTP management API
- [x] Provider settings UI and chat model selector over local provider profiles
- [x] Per-session provider/model persistence and runtime provider routing
- [x] Ollama/OpenAI-compatible model refresh and local provider presets
- [x] Local extension manifest loader and HTTP read API
- [x] Extension registry summary in the sidebar over local manifests
- [x] Extension setup readiness checks for required env, skills, and MCP references
- [x] Ready extension skills injected into the runtime skill catalog
- [x] Bundled QA workflow extension manifest and local extension guide
- [x] Artifact registry storage and HTTP read API for session file outputs
- [x] Replayable artifact change events for created, updated, and moved files
- [x] Session artifact panel UI with live artifact event updates
- [x] Session file attachment flow with replayable artifact events
- [x] Artifact preview/open/reveal actions for session files
- [x] Batch file read/write API scoped to session workspaces
- [x] Replayable file read/change events for session file workflows

## Release follow-up

- [ ] Confirm green CI runs on GitHub-hosted macOS, Windows, and Linux runners
- [ ] Configure Apple notarization and Windows code-signing secrets
- [ ] Publish signed installers from a version tag
