# Starter Kit Roadmap

## Direction

Build a clear, owned starter kit inspired by OpenWork capabilities without copying the full OpenWork platform shape.

The goal is a small codebase that teaches the architecture well:

- local-first desktop app
- understandable agent runtime
- explicit permissions
- portable server boundary
- extensible skills, MCP, and plugins
- product-like workflows where they matter

This repository should stay a starter kit, not become a monorepo-scale clone.

## Design Principles

- Keep the runtime small enough to read in one sitting.
- Prefer boring interfaces: HTTP, SSE, SQLite, JSON config, filesystem folders.
- Make capability boundaries explicit: UI, local server, agent engine, tools, storage.
- Add extension points only after the built-in path works.
- Treat permissions and audit logs as core product behavior, not afterthoughts.
- Keep cloud, billing, organization policy, and marketplace concepts out until local workflows are solid.

## Recommended Capability Phases

### 1. Local Server Boundary

Move from sidecar-only RPC toward a small local HTTP/SSE API.

Recommended endpoints:

- `GET /health`
- `GET /workspaces`
- `POST /workspaces`
- `GET /sessions`
- `POST /sessions`
- `GET /sessions/:id/events`
- `POST /sessions/:id/messages`
- `GET /approvals`
- `POST /approvals/:id`
- `GET /skills`
- `GET /mcp`
- `POST /mcp/:name/connect`

Why this comes first:

- makes UI state easier to test
- supports future remote clients
- allows resumable event streams
- separates product API from agent internals

### 2. Workspace And Session Model

Upgrade persistence beyond "latest conversation".

Add:

- session list per workspace
- rename, archive, delete
- task/run status
- event replay after reload
- active session restore
- workspace metadata

Keep SQLite as the default store.

### 3. Provider And Model Management

Move provider config out of environment-only setup.

Add:

- provider settings UI
- persisted provider config
- model picker
- per-session selected model
- local Ollama/OpenAI-compatible profiles
- validation and connection test

Environment variables can remain the quick-start path.

### 4. Extension Layer

Unify skills, MCP servers, commands, and setup instructions behind a small manifest.

Start with a local-only manifest:

```json
{
  "id": "webapp-testing",
  "name": "Web App Testing",
  "resources": {
    "skills": ["skills/webapp-testing"],
    "mcp": []
  },
  "setup": {
    "requiredEnv": [],
    "instructions": "Optional setup instructions"
  }
}
```

Do not add marketplace, cloud sync, or remote installation in this phase.

### 5. Artifacts And File Sessions

Add product workflows around files created or edited by agents.

Add:

- artifact registry
- generated file list per session
- inbox uploads
- file preview metadata
- batch read/write API
- file change events

This is the point where the starter kit starts feeling useful for real work.

### 6. Product UI Surfaces

Upgrade the UI around the core workflows.

Add:

- session sidebar
- settings area
- skills manager
- MCP manager
- provider/model picker
- permission approval modal
- task activity panel
- artifact panel
- optional terminal dock

Keep the UI compact and operational rather than marketing-style.

### 7. Hardening, Sandbox, And Release

Add after the local product loop is stable.

Add:

- smoke tests for app startup and session send
- server endpoint tests
- permission regression tests
- MCP integration tests
- optional Docker/container sandbox
- CI matrix
- signed installer workflow
- updater strategy

## Suggested First Milestone

Implement the local server boundary while keeping the current Tauri app working.

Deliverables:

- a `core/server` module that exposes HTTP and SSE
- a shared event model used by both sidecar RPC and HTTP
- tests for health, workspace list, session create, send message, and approvals
- UI still starts through Tauri, but talks to the local API internally

This gives the project a stable foundation without expanding into OpenWork's full platform complexity.

## Non-Goals For Now

- cloud accounts
- billing
- organization policies
- marketplace
- SCIM/SSO
- multi-tenant admin dashboard
- Electron migration
- full OpenCode replacement or compatibility layer

Those may be useful later, but they would make the starter kit harder to learn before the core loop is strong.
