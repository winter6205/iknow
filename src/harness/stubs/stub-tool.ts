/**
 * Stub tool: test double for the ToolDef interface.
 *
 * A `next()` callback produces the return value or throws; fully
 * deterministic, no time/random/IO dependencies, test-only. `next` matches
 * the real Tool/Adapter shape so the Executor validates and runs it strictly.
 */

import type { ToolDef } from "../tools/types.js";

export interface StubToolOptions {
  readonly name: string;
  /** Returns or throws from input; fully deterministic. */
  readonly next: (input: unknown) => unknown;
  /** Optional JSON Schema; defaults to accepting any object. */
  readonly inputSchema?: Record<string, unknown>;
}

export function createStubTool(opts: StubToolOptions): ToolDef {
  return Object.freeze({
    name: opts.name,
    description: `stub ${opts.name}`,
    inputSchema: opts.inputSchema ?? { type: "object" },
    handler: (async (input: unknown) => opts.next(input)) as ToolDef["handler"],
  });
}
