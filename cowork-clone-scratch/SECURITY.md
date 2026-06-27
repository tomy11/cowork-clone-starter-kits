# Security model

- File tools resolve real paths and reject symlinks that escape a granted workspace.
- Writes, moves, deletes, and MCP tools require confirmation by default.
- Audit entries redact credentials, bearer tokens, URL secrets, and file contents.
- MCP child processes inherit only the SDK's safe default environment plus variables explicitly configured in `mcp.json`.
- The desktop webview uses a restrictive Content Security Policy.
- Optional container sandboxing is available for project commands through `npm run sandbox`.

Security boundaries in this MVP are enforced in-process. Do not treat it as an OS-level sandbox. Only enable MCP servers you trust and review their command, arguments, and environment configuration before distribution.

For release signing and updater guidance, see `RELEASE.md`. For command sandbox usage, see `SANDBOX.md`.
