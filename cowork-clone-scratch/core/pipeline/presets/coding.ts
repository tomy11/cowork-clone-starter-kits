import type { PipelineDefinition, PipelineStep } from "../types.js";

export type CodingPipelineOptions = {
  id?: string;
  maxConcurrent?: number;
  workspace?: string;
  agents?: Partial<Record<"context" | "planner" | "implementer" | "tester" | "reviewer" | "summarizer", string>>;
};

const DEFAULT_AGENTS = {
  context: "context",
  planner: "planner",
  implementer: "implementer",
  tester: "tester",
  reviewer: "reviewer",
  summarizer: "summarizer",
} as const;

export function createCodingPipeline(objective: string, options: CodingPipelineOptions = {}): PipelineDefinition {
  const agents = { ...DEFAULT_AGENTS, ...options.agents };
  const steps: PipelineStep[] = [
    {
      id: "context",
      title: "Collect Context",
      instruction: "Read only the files and project metadata needed to understand the task. Return constraints, risks, and likely edit targets.",
      agentId: agents.context,
    },
    {
      id: "plan",
      title: "Plan Changes",
      instruction: "Turn the context into a concise implementation plan with file ownership boundaries and verification steps.",
      agentId: agents.planner,
      dependsOn: ["context"],
    },
    {
      id: "implement",
      title: "Implement",
      instruction: "Apply the planned code changes while keeping the edit scope tight and preserving existing project style.",
      agentId: agents.implementer,
      dependsOn: ["plan"],
      retry: 1,
    },
    {
      id: "test",
      title: "Verify",
      instruction: "Run focused checks for the changed behavior. Report exact commands, results, and any failures.",
      agentId: agents.tester,
      dependsOn: ["implement"],
      retry: 1,
      continueOnFailure: true,
    },
    {
      id: "review",
      title: "Review Diff",
      instruction: "Inspect the resulting diff for bugs, regressions, missing tests, and accidental unrelated changes.",
      agentId: agents.reviewer,
      dependsOn: ["implement"],
    },
    {
      id: "summary",
      title: "Summarize",
      instruction: "Synthesize what changed, what was verified, remaining risks, and a commit-ready summary.",
      agentId: agents.summarizer,
      dependsOn: ["test", "review"],
    },
  ];

  return {
    id: options.id ?? `coding-${Date.now()}`,
    objective,
    steps,
    maxConcurrent: options.maxConcurrent ?? 2,
    context: {
      workspace: options.workspace,
      preset: "coding",
    },
  };
}

export function createStarterKitRoadmapPipeline(objective: string, options: CodingPipelineOptions = {}) {
  return createCodingPipeline(objective, {
    ...options,
    id: options.id ?? `starter-kit-roadmap-${Date.now()}`,
  });
}
