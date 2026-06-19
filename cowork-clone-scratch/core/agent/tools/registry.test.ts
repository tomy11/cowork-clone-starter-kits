import { describe, expect, it } from "vitest";
import { ToolRegistry, type ToolImpl } from "./registry.js";

const echoTool: ToolImpl = {
  name: "echo",
  description: "Returns its input",
  input_schema: { type: "object" },
  async execute(args) {
    return args;
  },
};

describe("ToolRegistry", () => {
  it("registers and exposes tools to an LLM", () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);

    expect(registry.names()).toEqual(["echo"]);
    expect(registry.list()[0]).toMatchObject({
      name: "echo",
      description: "Returns its input",
    });
  });

  it("throws for an unknown tool", () => {
    const registry = new ToolRegistry();
    expect(() => registry.get("missing")).toThrow("Tool not found: missing");
  });
});
