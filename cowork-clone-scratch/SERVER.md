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
- `POST /workspaces`
- `GET /sessions?workspace=/path/to/workspace`
- `POST /sessions`
- `GET /sessions/:id`
- `PATCH /sessions/:id`
- `DELETE /sessions/:id`
- `GET /sessions/:id/events`
- `POST /sessions/:id/messages`
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
```

## Notes

- The existing Tauri sidecar protocol still works.
- HTTP and JSON-RPC both call the same `AppRuntime`.
- The React app now uses HTTP for workspace/session bootstrap and task messages, and SSE for live session events.
- Session list, rename, archive, and delete are available through the local HTTP API.
- Approvals are runtime-owned and can be answered through either JSON-RPC or HTTP.
- The current server is local-first and unauthenticated. Add tokens before exposing it outside localhost.
