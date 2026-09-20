/**
 * Demo tools: minimal real, executable, non-business ToolDefs.
 *
 * Used by smoke tests against a real model adapter to verify the
 * multi-step loop under live traffic (echo + get_time), and as a ToolDef
 * construction example: `additionalProperties:false` exercises the
 * validation_failed round-trip; the handler narrows the unknown input and
 * returns a string (Executor encodes it via safeContent).
 *
 * Boundaries: pure functions, no state, no IO; no ctx.signal handling;
 * registration is left to the caller (createRegistry).
 */

import type { ToolDef } from "../tools/types.js";
import { ToolExecutionError } from "../errors.js";

/**
 * echo: returns the input text.
 * With additionalProperties:false extra fields fail validation in the
 * Executor before the handler runs; the narrow assertion inside stays as a
 * runtime guard (input is typed unknown).
 */
export function createEchoTool(): ToolDef {
  return Object.freeze({
    name: "echo",
    description: "echo back the input text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    handler: async (input: unknown) => {
      const t = (input as { text?: unknown }).text;
      if (typeof t !== "string") {
        // ajv already guarantees a string; this guards against runtime surprises.
        throw new ToolExecutionError("echo: text must be string");
      }
      return t;
    },
  });
}

/** get_time: returns the current ISO timestamp. Takes no input fields. */
export function createGetTimeTool(): ToolDef {
  return Object.freeze({
    name: "get_time",
    description: "return current ISO timestamp",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    handler: async () => new Date().toISOString(),
  });
}
