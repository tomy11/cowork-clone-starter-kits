export type PipelineStepStatus = "pending" | "running" | "done" | "failed" | "blocked" | "cancelled";

export type PipelineStep = {
  id: string;
  title: string;
  instruction: string;
  agentId: string;
  dependsOn?: string[];
  skills?: string[];
  retry?: number;
  continueOnFailure?: boolean;
  metadata?: Record<string, unknown>;
};

export type PipelineDefinition = {
  id: string;
  objective: string;
  steps: PipelineStep[];
  context?: Record<string, unknown>;
  maxConcurrent?: number;
};

export type PipelineStepResult = {
  stepId: string;
  agentId: string;
  status: Exclude<PipelineStepStatus, "pending" | "running">;
  output: string;
  error?: string;
  attempts: number;
  startedAt: string;
  completedAt: string;
  artifacts?: Record<string, unknown>;
};

export type PipelineResult = {
  id: string;
  status: "done" | "failed" | "cancelled";
  objective: string;
  results: PipelineStepResult[];
  startedAt: string;
  completedAt: string;
};

export type PipelineAgentInput = {
  pipelineId: string;
  objective: string;
  step: PipelineStep;
  context: Record<string, unknown>;
  previousResults: PipelineStepResult[];
  signal?: AbortSignal;
};

export type PipelineAgentResult = {
  success: boolean;
  output: string;
  error?: string;
  artifacts?: Record<string, unknown>;
};

export type PipelineAgentEvent =
  | { kind: "agent_progress"; content: string }
  | { kind: "agent_tool_call"; name: string; args: unknown }
  | { kind: "agent_tool_result"; name: string; result: unknown };

export type PipelineAgent = {
  id: string;
  role: string;
  description: string;
  run(
    input: PipelineAgentInput,
    emit: (event: PipelineAgentEvent) => void,
  ): Promise<PipelineAgentResult>;
};

export type PipelineEvent =
  | { kind: "pipeline_started"; pipeline: PipelineDefinition }
  | { kind: "step_queued"; step: PipelineStep }
  | { kind: "step_started"; step: PipelineStep; attempt: number }
  | { kind: "step_retrying"; step: PipelineStep; attempt: number; error: string }
  | { kind: "agent_progress"; step: PipelineStep; content: string }
  | { kind: "agent_tool_call"; step: PipelineStep; name: string; args: unknown }
  | { kind: "agent_tool_result"; step: PipelineStep; name: string; result: unknown }
  | { kind: "step_done"; step: PipelineStep; result: PipelineStepResult }
  | { kind: "step_failed"; step: PipelineStep; result: PipelineStepResult }
  | { kind: "step_blocked"; step: PipelineStep; reason: string }
  | { kind: "pipeline_done"; result: PipelineResult }
  | { kind: "pipeline_cancelled"; result: PipelineResult }
  | { kind: "pipeline_failed"; result: PipelineResult };

export type PipelineRunOptions = {
  signal?: AbortSignal;
  maxConcurrent?: number;
  onEvent?: (event: PipelineEvent) => void;
};
