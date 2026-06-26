# Local Server Boundary

The starter kit now has a local HTTP + SSE boundary in `core/server`.

This boundary wraps the same `AppRuntime` used by the Tauri sidecar JSON-RPC protocol. The goal is to keep one runtime path while allowing future clients to talk through ordinary HTTP and event streams.

## Start The Server

The sidecar starts the HTTP server when `COWORK_HTTP_PORT` is set:

```bash
COWORK_HTTP_PORT=8787 npm run sidecar
```

Use `LLM_PROVIDER=mock NODE_ENV=test` for local smoke testing without a real provider:

```bash
NODE_ENV=test LLM_PROVIDER=mock COWORK_HTTP_PORT=8787 npm run sidecar
```

The Tauri shell now sets `COWORK_HTTP_PORT` automatically when it spawns the sidecar and returns the local server URL to the React app.

## Endpoints

- `GET /health`
- `GET /workspaces`
- `GET /workspaces/metadata`
- `POST /workspaces`
- `GET /active-session?workspace=/path/to/workspace`
- `PATCH /active-session`
- `GET /providers`
- `POST /providers`
- `PATCH /providers/:id`
- `DELETE /providers/:id`
- `POST /providers/:id/default`
- `POST /providers/:id/test`
- `GET /providers/:id/models`
- `GET /extensions`
- `GET /extensions/:id`
- `GET /sessions?workspace=/path/to/workspace`
- `POST /sessions`
- `GET /sessions/:id`
- `PATCH /sessions/:id`
- `DELETE /sessions/:id`
- `GET /sessions/:id/events/replay`
- `GET /sessions/:id/events`
- `GET /sessions/:id/artifacts`
- `POST /sessions/:id/artifacts`
- `POST /sessions/:id/files/read`
- `POST /sessions/:id/files/write`
- `POST /sessions/:id/messages`
- `GET /artifacts/:id`
- `GET /artifacts/:id/preview`
- `GET /approvals`
- `POST /approvals/:id`
- `POST /runs/:id/cancel`

## SSE Events

Subscribe to a session:

```bash
curl -N http://127.0.0.1:8787/sessions/<session-id>/events
```

The stream emits:

- `ready`
- `run_started`
- agent/orchestrator events such as `plan`, `tool_call`, `final`
- `confirmation_requested`
- `confirmation_resolved`
- `file_attached`, `file_created`, `file_updated`, `file_moved`, `file_read`
- `artifact_created`, `artifact_updated`, `artifact_moved`, `artifact_attached`
- `run_cancelled`

## Minimal Flow

```bash
curl -X POST http://127.0.0.1:8787/workspaces \
  -H 'content-type: application/json' \
  -d '{"folder":"/path/to/workspace"}'

curl -X POST http://127.0.0.1:8787/sessions \
  -H 'content-type: application/json' \
  -d '{"workspace":"/path/to/workspace","title":"Local server test"}'

curl -X POST http://127.0.0.1:8787/sessions/<session-id>/messages \
  -H 'content-type: application/json' \
  -d '{"message":"Help me inspect this project"}'

curl -X POST http://127.0.0.1:8787/sessions/<session-id>/artifacts \
  -H 'content-type: application/json' \
  -d '{"path":"/path/to/workspace/context.txt"}'

curl http://127.0.0.1:8787/artifacts/<artifact-id>/preview

curl -X POST http://127.0.0.1:8787/sessions/<session-id>/files/read \
  -H 'content-type: application/json' \
  -d '{"paths":["README.md","src/App.tsx"]}'

curl -X POST http://127.0.0.1:8787/sessions/<session-id>/files/write \
  -H 'content-type: application/json' \
  -d '{"files":[{"path":"notes/summary.md","content":"# Summary\n"}]}'
```

## Notes

- The existing Tauri sidecar protocol still works.
- HTTP and JSON-RPC both call the same `AppRuntime`.
- The React app now uses HTTP for workspace/session bootstrap and task messages, and SSE for live session events.
- Session list, rename, archive, and delete are available through the local HTTP API.
- Active session restore and event replay are persisted in SQLite and exposed through the local HTTP API.
- Workspace metadata includes display name, active session, session counts, and timestamps.
- Provider profiles are persisted locally and exposed through provider management endpoints.
- Sessions can store provider/model selection, and run events include the provider/model used.
- Ollama/OpenAI-compatible profiles can refresh model lists through the local provider API.
- Local extension manifests are loaded from `extensions/*/extension.json` or `extensions/*.json` and exposed through read-only HTTP endpoints.
- Extension responses include local readiness checks for missing setup env vars and unresolved skill/MCP resources.
- Ready, enabled extension skills are merged into the runtime skill catalog used by JSON-RPC and agent runs.
- A bundled `qa-workflow` extension shows the local manifest shape and groups the starter kit's QA skills and check commands.
- File artifacts created or moved by agent file tools are persisted per session and exposed through artifact read endpoints.
- Existing files inside the session workspace can be attached through `POST /sessions/:id/artifacts`.
- Text and small image artifact previews are available through `GET /artifacts/:id/preview`.
- Batch file read/write APIs are scoped to the session workspace and write operations create/update session artifacts.
- Artifact changes emit replayable session events: `artifact_created`, `artifact_updated`, `artifact_moved`, and `artifact_attached`.
- File workflows emit replayable `file_read`, `file_created`, `file_updated`, `file_moved`, and `file_attached` events.
- The chat surface shows current session artifacts and updates the list from artifact replay/SSE events, including preview/open/reveal actions for manually attached files.
- Approvals are runtime-owned and can be answered through either JSON-RPC or HTTP.
- The current server is local-first and unauthenticated. Add tokens before exposing it outside localhost.
