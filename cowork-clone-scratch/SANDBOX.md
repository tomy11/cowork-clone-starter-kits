# Optional Container Sandbox

The starter kit keeps the default runtime local and readable. For commands that should not run directly on the host, use the optional Docker wrapper:

```bash
npm run sandbox -- -- npm test
```

The wrapper mounts the current workspace at `/workspace` and runs the command in `node:22-bookworm-slim`.

Default restrictions:

- Docker network is disabled with `--network none`
- Linux capabilities are dropped with `--cap-drop ALL`
- `no-new-privileges` is enabled
- container root filesystem is read-only
- workspace mount is read-only
- `/tmp` is the only writable tmpfs
- CPU, memory, and process limits are set

Use `--write` only when the command must change files:

```bash
npm run sandbox -- --write -- npm run build
```

Pass a different workspace, image, network mode, or environment variable explicitly:

```bash
npm run sandbox -- --workspace /path/to/project --image node:22 --env CI=1 -- npm test
```

Preview the Docker command without running it:

```bash
npm run sandbox -- --dry-run -- npm test
```

This wrapper is intentionally not a complete security boundary. It is a safer default for untrusted project commands and remote MCP experiments, but production isolation should be reviewed for the target OS, Docker runtime, and threat model.
