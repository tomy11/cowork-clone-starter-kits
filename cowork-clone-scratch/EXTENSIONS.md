# Local Extensions

Extensions are local manifests that group skills, MCP server references, commands, and setup notes.

The loader reads:

- `extensions/*/extension.json`
- `extensions/*.json`

The app does not install remote code. A manifest only describes local resources that already exist in the starter kit folder.

## Example

```json
{
  "id": "qa-workflow",
  "name": "QA Workflow",
  "resources": {
    "skills": ["webapp-testing", "test-master"],
    "mcp": [],
    "commands": [
      {
        "id": "test",
        "label": "Run tests",
        "command": "npm test"
      }
    ]
  },
  "setup": {
    "requiredEnv": [],
    "instructions": "Optional setup notes"
  }
}
```

## Readiness

An extension is `ready` when:

- `enabled` is not `false`
- the manifest schema is valid
- every `setup.requiredEnv` value is present
- every referenced skill resolves to a local `SKILL.md`
- every referenced MCP server exists in `mcp.json`

Ready extension skills are merged into the runtime skill catalog. Extensions that need setup still appear in the sidebar, but their skills are not injected into agent runs.

## Paths

Skill references can be:

- a skill name under `skills/`, such as `webapp-testing`
- a path relative to the extension folder, such as `skills/webapp-testing`
- an absolute path

Commands are descriptive for now. They are exposed in the manifest response and counted in the sidebar, but this phase does not add command execution.
