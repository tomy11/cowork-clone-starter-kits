import type {
  PipelineAgent,
  PipelineAgentEvent,
  PipelineDefinition,
  PipelineEvent,
  PipelineResult,
  PipelineRunOptions,
  PipelineStep,
  PipelineStepResult,
  PipelineStepStatus,
} from "./types.js";

export class PipelineRunner {
  private agents = new Map<string, PipelineAgent>();

  constructor(agents: PipelineAgent[] = []) {
    for (const agent of agents) this.registerAgent(agent);
  }

  registerAgent(agent: PipelineAgent) {
    this.agents.set(agent.id, agent);
  }

  async *run(
    pipeline: PipelineDefinition,
    options: PipelineRunOptions = {},
  ): AsyncGenerator<PipelineEvent, PipelineResult> {
    const emitQueue: PipelineEvent[] = [];
    const emit = (event: PipelineEvent) => {
      emitQueue.push(event);
      options.onEvent?.(event);
    };

    const flush = async function* () {
      while (emitQueue.length > 0) {
        const event = emitQueue.shift();
        if (event) yield event;
      }
    };

    const startedAt = timestamp();
    const statuses = new Map<string, PipelineStepStatus>();
    const results = new Map<string, PipelineStepResult>();
    const inFlight = new Map<string, Promise<void>>();
    const maxConcurrent = options.maxConcurrent ?? pipeline.maxConcurrent ?? 3;

    for (const step of pipeline.steps) statuses.set(step.id, "pending");
    this.validate(pipeline);
    emit({ kind: "pipeline_started", pipeline });
    yield* flush();

    const startStep = (step: PipelineStep) => {
      statuses.set(step.id, "running");
      const promise = this.runStep(pipeline, step, [...results.values()], options.signal, emit)
        .then((result) => {
          results.set(step.id, result);
          statuses.set(step.id, result.status);
          emit({
            kind: result.status === "done" ? "step_done" : "step_failed",
            step,
            result,
          });
        });
      inFlight.set(step.id, promise);
    };

    while (hasWork(statuses)) {
      if (options.signal?.aborted) {
        const result = finalize(pipeline, [...results.values()], startedAt, "cancelled");
        emit({ kind: "pipeline_cancelled", result });
        yield* flush();
        return result;
      }

      for (const step of readySteps(pipeline.steps, statuses, results)) {
        if (inFlight.size >= maxConcurrent) break;
        emit({ kind: "step_queued", step });
        startStep(step);
      }

      yield* flush();

      if (inFlight.size > 0) {
        const completedId = await Promise.race(
          [...inFlight.entries()].map(([id, promise]) => promise.then(() => id)),
        );
        inFlight.delete(completedId);
        yield* flush();
        continue;
      }

      const blocked = pendingSteps(pipeline.steps, statuses);
      if (blocked.length === 0) break;
      for (const step of blocked) {
        const reason = blockedReason(step, results);
        const result = stepResult(step, "blocked", "", reason, 0, startedAt);
        results.set(step.id, result);
        statuses.set(step.id, "blocked");
        emit({ kind: "step_blocked", step, reason });
      }
      yield* flush();
    }

    const finalStatus = [...results.values()].some((result) =>
      result.status === "failed" && !pipeline.steps.find((step) => step.id === result.stepId)?.continueOnFailure
    ) || [...results.values()].some((result) => result.status === "blocked")
      ? "failed"
      : "done";
    const result = finalize(pipeline, [...results.values()], startedAt, finalStatus);
    emit({ kind: finalStatus === "done" ? "pipeline_done" : "pipeline_failed", result });
    yield* flush();
    return result;
  }

  private async runStep(
    pipeline: PipelineDefinition,
    step: PipelineStep,
    previousResults: PipelineStepResult[],
    signal: AbortSignal | undefined,
    emit: (event: PipelineEvent) => void,
  ): Promise<PipelineStepResult> {
    const agent = this.agents.get(step.agentId);
    if (!agent) return stepResult(step, "failed", "", `Unknown agent: ${step.agentId}`, 0, timestamp());

    const maxAttempts = Math.max(1, (step.retry ?? 0) + 1);
    const startedAt = timestamp();
    let lastError = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) return stepResult(step, "cancelled", "", "Task cancelled", attempt, startedAt);
      emit({ kind: "step_started", step, attempt });
      try {
        const result = await agent.run({
          pipelineId: pipeline.id,
          objective: pipeline.objective,
          step,
          context: pipeline.context ?? {},
          previousResults,
          signal,
        }, (event) => emitAgentEvent(step, event, emit));

        if (result.success) {
          return stepResult(step, "done", result.output, undefined, attempt, startedAt, result.artifacts);
        }

        lastError = result.error ?? (result.output || "Agent reported failure");
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      if (attempt < maxAttempts) {
        emit({ kind: "step_retrying", step, attempt: attempt + 1, error: lastError });
      }
    }

    return stepResult(step, "failed", "", lastError, maxAttempts, startedAt);
  }

  private validate(pipeline: PipelineDefinition) {
    const ids = new Set<string>();
    for (const step of pipeline.steps) {
      if (ids.has(step.id)) throw new Error(`Duplicate pipeline step id: ${step.id}`);
      ids.add(step.id);
      if (!this.agents.has(step.agentId)) throw new Error(`Missing agent for step ${step.id}: ${step.agentId}`);
    }
    for (const step of pipeline.steps) {
      for (const dependency of step.dependsOn ?? []) {
        if (!ids.has(dependency)) throw new Error(`Step ${step.id} depends on unknown step: ${dependency}`);
      }
    }
  }
}

function readySteps(
  steps: PipelineStep[],
  statuses: Map<string, PipelineStepStatus>,
  results: Map<string, PipelineStepResult>,
) {
  return steps.filter((step) => {
    if (statuses.get(step.id) !== "pending") return false;
    return (step.dependsOn ?? []).every((dependency) => results.get(dependency)?.status === "done");
  });
}

function pendingSteps(steps: PipelineStep[], statuses: Map<string, PipelineStepStatus>) {
  return steps.filter((step) => statuses.get(step.id) === "pending");
}

function hasWork(statuses: Map<string, PipelineStepStatus>) {
  return [...statuses.values()].some((status) => status === "pending" || status === "running");
}

function blockedReason(step: PipelineStep, results: Map<string, PipelineStepResult>) {
  const failed = (step.dependsOn ?? []).filter((dependency) => results.get(dependency)?.status !== "done");
  return failed.length > 0
    ? `Blocked by dependency: ${failed.join(", ")}`
    : "Blocked because no runnable step was available";
}

function emitAgentEvent(
  step: PipelineStep,
  event: PipelineAgentEvent,
  emit: (event: PipelineEvent) => void,
) {
  if (event.kind === "agent_progress") emit({ kind: "agent_progress", step, content: event.content });
  if (event.kind === "agent_tool_call") emit({ kind: "agent_tool_call", step, name: event.name, args: event.args });
  if (event.kind === "agent_tool_result") emit({ kind: "agent_tool_result", step, name: event.name, result: event.result });
}

function stepResult(
  step: PipelineStep,
  status: PipelineStepResult["status"],
  output: string,
  error: string | undefined,
  attempts: number,
  startedAt: string,
  artifacts?: Record<string, unknown>,
): PipelineStepResult {
  return {
    stepId: step.id,
    agentId: step.agentId,
    status,
    output,
    error,
    attempts,
    startedAt,
    completedAt: timestamp(),
    artifacts,
  };
}

function finalize(
  pipeline: PipelineDefinition,
  results: PipelineStepResult[],
  startedAt: string,
  status: PipelineResult["status"],
): PipelineResult {
  return {
    id: pipeline.id,
    status,
    objective: pipeline.objective,
    results,
    startedAt,
    completedAt: timestamp(),
  };
}

function timestamp() {
  return new Date().toISOString();
}
