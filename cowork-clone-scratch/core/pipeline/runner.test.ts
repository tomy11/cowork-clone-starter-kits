import { describe, expect, it } from "vitest";
import { createCodingPipeline, PipelineRunner, type PipelineAgent, type PipelineDefinition, type PipelineEvent } from "./index.js";

function scriptedAgent(id: string, outputs: Array<{ success: boolean; output: string; error?: string }>): PipelineAgent {
  let callIndex = 0;
  return {
    id,
    role: id,
    description: `${id} test agent`,
    async run(_input, emit) {
      emit({ kind: "agent_progress", content: `${id} running` });
      const result = outputs[Math.min(callIndex, outputs.length - 1)];
      callIndex++;
      return result;
    },
  };
}

async function collectEvents(runner: PipelineRunner, pipeline: PipelineDefinition) {
  const events: PipelineEvent[] = [];
  for await (const event of runner.run(pipeline)) events.push(event);
  return events;
}

describe("PipelineRunner", () => {
  it("runs dependency-ordered steps and emits a final result", async () => {
    const runner = new PipelineRunner([
      scriptedAgent("reader", [{ success: true, output: "context ready" }]),
      scriptedAgent("writer", [{ success: true, output: "implementation ready" }]),
    ]);
    const pipeline: PipelineDefinition = {
      id: "p1",
      objective: "ship a change",
      steps: [
        { id: "context", title: "Context", instruction: "read", agentId: "reader" },
        { id: "implement", title: "Implement", instruction: "write", agentId: "writer", dependsOn: ["context"] },
      ],
    };

    const events = await collectEvents(runner, pipeline);
    const started = events
      .filter((event) => event.kind === "step_started")
      .map((event) => event.step.id);
    const done = events.find((event) => event.kind === "pipeline_done");

    expect(started).toEqual(["context", "implement"]);
    expect(done?.result.status).toBe("done");
    expect(done?.result.results.map((result) => result.stepId)).toEqual(["context", "implement"]);
  });

  it("retries a failed step before marking it done", async () => {
    const runner = new PipelineRunner([
      scriptedAgent("flaky", [
        { success: false, output: "", error: "first failure" },
        { success: true, output: "second attempt worked" },
      ]),
    ]);
    const pipeline: PipelineDefinition = {
      id: "p2",
      objective: "retry work",
      steps: [
        { id: "implement", title: "Implement", instruction: "write", agentId: "flaky", retry: 1 },
      ],
    };

    const events = await collectEvents(runner, pipeline);
    const retry = events.find((event) => event.kind === "step_retrying");
    const done = events.find((event) => event.kind === "step_done");

    expect(retry?.attempt).toBe(2);
    expect(done?.result.attempts).toBe(2);
    expect(done?.result.output).toBe("second attempt worked");
  });

  it("blocks dependent steps when a required dependency fails", async () => {
    const runner = new PipelineRunner([
      scriptedAgent("broken", [{ success: false, output: "", error: "cannot read" }]),
      scriptedAgent("writer", [{ success: true, output: "should not run" }]),
    ]);
    const pipeline: PipelineDefinition = {
      id: "p3",
      objective: "block work",
      steps: [
        { id: "context", title: "Context", instruction: "read", agentId: "broken" },
        { id: "implement", title: "Implement", instruction: "write", agentId: "writer", dependsOn: ["context"] },
      ],
    };

    const events = await collectEvents(runner, pipeline);
    const blocked = events.find((event) => event.kind === "step_blocked");
    const failed = events.find((event) => event.kind === "pipeline_failed");
    const started = events
      .filter((event) => event.kind === "step_started")
      .map((event) => event.step.id);

    expect(started).toEqual(["context"]);
    expect(blocked?.step.id).toBe("implement");
    expect(failed?.result.status).toBe("failed");
  });
});

describe("coding pipeline preset", () => {
  it("creates the expected coding workflow", () => {
    const pipeline = createCodingPipeline("add local server boundary", {
      id: "coding-test",
      workspace: "/tmp/project",
    });

    expect(pipeline.id).toBe("coding-test");
    expect(pipeline.context?.workspace).toBe("/tmp/project");
    expect(pipeline.steps.map((step) => step.id)).toEqual([
      "context",
      "plan",
      "implement",
      "test",
      "review",
      "summary",
    ]);
    expect(pipeline.steps.find((step) => step.id === "summary")?.dependsOn).toEqual(["test", "review"]);
  });
});
