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

## Release follow-up

- [ ] Confirm green CI runs on GitHub-hosted macOS, Windows, and Linux runners
- [ ] Configure Apple notarization and Windows code-signing secrets
- [ ] Publish signed installers from a version tag
