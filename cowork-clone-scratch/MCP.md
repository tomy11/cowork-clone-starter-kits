# MCP configuration

The sidecar uses the official MCP TypeScript SDK v1 and supports local stdio servers.

```json
{
  "servers": {
    "example": {
      "command": "your-mcp-server",
      "args": ["--workspace", "${workspace}"],
      "env": {
        "SERVICE_TOKEN": "${SERVICE_TOKEN}"
      },
      "enabled": true,
      "confirmTools": true
    }
  }
}
```

- `${workspace}` resolves to the active granted workspace.
- Other `${NAME}` values resolve from the sidecar environment.
- Discovered tools are namespaced as `mcp__<server>__<tool>`.
- Keep `confirmTools` enabled for servers with network or write capabilities.
- Server errors and connection state are available through the `mcp_status` RPC method.
- `mcp_connect` and `mcp_disconnect` can manage a configured server explicitly.

Do not commit credentials to `mcp.json`; reference environment variables instead.
