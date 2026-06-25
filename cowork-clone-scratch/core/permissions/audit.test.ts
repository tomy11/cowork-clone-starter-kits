import { describe, expect, it } from "vitest";
import { AuditLog } from "./audit.js";

describe("AuditLog redaction", () => {
  it("removes credentials and file content before persistence", () => {
    const audit = new AuditLog(":memory:");
    audit.log({
      agentId: "test",
      tool: "write_file",
      decision: "allowed",
      args: {
        path: "/tmp/file.txt",
        content: "private document body",
        apiKey: "super-secret",
        headers: { authorization: "Bearer abc.def" },
      },
    });

    expect(audit.recent(1)[0].args).toEqual({
      path: "/tmp/file.txt",
      content: "[REDACTED CONTENT: 21 chars]",
      apiKey: "[REDACTED]",
      headers: { authorization: "[REDACTED]" },
    });
    audit.close();
  });
});
