import { describe, expect, it } from "vitest";

import {
  McpLifecycleError,
  ToolExecutionError,
  type McpLifecycleErrorKind,
} from "../../src/harness/errors.ts";

const MCP_LIFECYCLE_KINDS: McpLifecycleErrorKind[] = [
  "missing_cwd",
  "invalid_cwd",
  "invalid_config_root",
  "root_mismatch",
  "config_load_failed",
  "reload_failed",
];

describe("McpLifecycleError", () => {
  it.each(MCP_LIFECYCLE_KINDS)(
    "exposes stable typed kind %s",
    (kind: McpLifecycleErrorKind) => {
      const error = new McpLifecycleError(
        kind,
        "MCP lifecycle operation failed"
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ToolExecutionError);
      expect(error.name).toBe("McpLifecycleError");
      expect(error.kind).toBe(kind);
      expect(error.detail).toBe("MCP lifecycle operation failed");
      expect(error.message).toContain(kind);
    }
  );

  it("preserves an optional cause without exposing it in the visible detail", () => {
    const cause = new Error("transport failed with credential=super-secret");
    const error = new McpLifecycleError(
      "reload_failed",
      "MCP manager reload failed",
      { cause }
    );

    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain("super-secret");
    expect(error.detail).not.toContain("super-secret");
  });

  it("keeps message and detail non-empty for blank input", () => {
    const error = new McpLifecycleError("invalid_cwd", " \t\n");

    expect(error.message.trim()).not.toBe("");
    expect(error.detail.trim()).not.toBe("");
  });

  it("redacts secrets, command arguments, and environment values", () => {
    const error = new McpLifecycleError(
      "config_load_failed",
      "spawn command: node server.js --token super-secret API_KEY=another-secret process.env.MCP_SECRET=$MCP_SECRET"
    );

    expect(error.message).not.toContain("node server.js");
    expect(error.message).not.toContain("super-secret");
    expect(error.message).not.toContain("another-secret");
    expect(error.message).not.toContain("$MCP_SECRET");
    expect(error.detail).not.toContain("node server.js");
    expect(error.detail).not.toContain("super-secret");
    expect(error.detail).not.toContain("another-secret");
    expect(error.detail).not.toContain("$MCP_SECRET");
  });
});
