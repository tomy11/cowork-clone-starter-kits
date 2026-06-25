# Multi-Agent Pipeline

This starter kit includes a portable pipeline core in `core/pipeline`.

The pipeline layer is intentionally independent from React, Tauri, and the current sidecar RPC shape. It can run inside this app or be copied into another TypeScript project.

## Concepts

- **PipelineDefinition**: objective, steps, dependencies, context, and concurrency.
- **PipelineStep**: one unit of work with an assigned agent.
- **PipelineAgent**: a role implementation such as context collector, implementer, tester, reviewer, or summarizer.
- **PipelineRunner**: schedules dependency-ready steps, enforces concurrency, retries failures, blocks dependent work, and emits events.
- **Preset**: a reusable pipeline template, such as the included coding workflow.

## Coding Workflow

The default coding preset is:

1. `context`: read the project shape and likely edit targets
2. `plan`: create a concise implementation plan
3. `implement`: edit scoped files
4. `test`: run focused checks
5. `review`: inspect the diff for regressions
6. `summary`: produce final handoff notes

The `test` and `review` steps can run after implementation. The final summary waits for both.

## Example

```ts
import {
  PipelineRunner,
  createCodingPipeline,
  createSubAgentPipelineAgent,
} from "./core/pipeline/index.js";

const runner = new PipelineRunner([
  createSubAgentPipelineAgent({ id: "context", role: "Context", description: "Reads project context", llm, acl, audit, tools }),
  createSubAgentPipelineAgent({ id: "planner", role: "Planner", description: "Plans scoped work", llm, acl, audit, tools }),
  createSubAgentPipelineAgent({ id: "implementer", role: "Implementer", description: "Applies changes", llm, acl, audit, tools }),
  createSubAgentPipelineAgent({ id: "tester", role: "Tester", description: "Runs checks", llm, acl, audit, tools }),
  createSubAgentPipelineAgent({ id: "reviewer", role: "Reviewer", description: "Reviews diffs", llm, acl, audit, tools }),
  createSubAgentPipelineAgent({ id: "summarizer", role: "Summarizer", description: "Writes final summary", llm, acl, audit, tools }),
]);

const pipeline = createCodingPipeline("Add local server boundary", {
  workspace: "/path/to/project",
});

for await (const event of runner.run(pipeline)) {
  console.log(event.kind);
}
```

## Using It For The Starter Kit Roadmap

Use one coding pipeline per roadmap phase:

- Phase 1: local server boundary
- Phase 2: workspace and session model
- Phase 3: provider and model management
- Phase 4: extension layer
- Phase 5: artifacts and file sessions
- Phase 6: product UI surfaces
- Phase 7: hardening, sandbox, and release

Each phase should keep file ownership narrow. Avoid letting multiple agents edit the same files at the same time. A good default is:

- context/planner agents read only
- implementer edits
- tester runs checks
- reviewer reads diff
- summarizer writes no files

## Portability Notes

To use the pipeline in another project, copy `core/pipeline` and provide project-specific agents.

Agents can be backed by:

- the included `SubAgent` adapter
- a deterministic script
- a remote worker
- a human approval step
- another LLM runtime

The runner only requires agents to implement the `PipelineAgent` interface.
