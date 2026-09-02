import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
  TRACE_OUTPUT_BACKSTOP,
  applyTraceOutputBackstop,
  TRACE_BACKSTOP_MARKER,
} from "../../src/traceserver/output-backstop.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import type { ToolDef } from "../../src/harness/tools/types.ts";

/**
 * `TRACE_OUTPUT_BACKSTOP` — the MCP transport's own output floor (plan
 * `trace-mcp-read-side-split` T6, item 14 / spec Assumption 4 and SC7's fourth
 * bullet).
 *
 * The number has to equal the executor's `OUTPUT_HARD_CAP`
 * (`src/harness/tools/executor.ts:30`) because a second, lower cap that also
 * cuts silently is exactly the double truncation ADR-0006:29 forbids. That value
 * is **not exported**, and `src/traceserver/` must not import `harness/`
 * (Assumption 5), so the constant is copied with its source named here and the
 * equality is locked **behaviorally** below: a test may cross the boundary, the
 * production module may not.
 */

const coreDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/traceserver"
);

const executorCapProber: ToolDef = {
  name: "prober",
  description: "echoes its input, so the executor's cap is observable",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { value: { type: "string" } },
    required: ["value"],
  },
  handler: (input: unknown) => (input as { value: string }).value,
};

async function executorTextFor(value: string): Promise<string> {
  const executor = createExecutor(createRegistry([executorCapProber]));
  const [result] = await executor.executeAll([
    { id: "call-1", name: "prober", input: { value } },
  ]);
  assert.equal(result?.kind, "ok");
  const block = result?.payload[0];
  assert.equal(block?.type, "text");
  return block?.type === "text" ? block.text : "";
}

describe("TRACE_OUTPUT_BACKSTOP — the value and where it comes from", () => {
  it("equals the executor's hard cap, proven by running the executor", async () => {
    // Locking the number against the executor's *behaviour* is the only legal way
    // to compare the two constants: `OUTPUT_HARD_CAP` is a module-private const,
    // and importing it would drag `harness/` into the read-side core. The two
    // cases below squeeze the executor's cap to exactly this value — at the cap it
    // passes through untouched (so its cap is >= ours), one over and it cuts (so
    // its cap is <= ours). A drifted constant on either side turns one of these
    // red, which is the double truncation ADR-0006:29 forbids.
    const atCap = "x".repeat(TRACE_OUTPUT_BACKSTOP);
    assert.equal(await executorTextFor(atCap), atCap);

    const overCap = "x".repeat(TRACE_OUTPUT_BACKSTOP + 1);
    const cut = await executorTextFor(overCap);
    assert.ok(
      cut.length <= TRACE_OUTPUT_BACKSTOP,
      `the executor let ${cut.length} characters through a ${TRACE_OUTPUT_BACKSTOP} cap`
    );
    assert.ok(
      cut.length > TRACE_OUTPUT_BACKSTOP - 200,
      `the executor cut to ${cut.length}, which is a different budget than ours`
    );
    // Our own cut lands inside the same budget, by construction.
    assert.equal(
      applyTraceOutputBackstop(overCap).length,
      TRACE_OUTPUT_BACKSTOP
    );
  });

  it("stays a literal 20000 in src/traceserver, with no import from harness/", () => {
    assert.equal(TRACE_OUTPUT_BACKSTOP, 20_000);

    const offenders = readdirSync(coreDir)
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) =>
        /from\s+["'][^"']*harness\//.test(
          readFileSync(join(coreDir, entry), "utf8")
        )
      );
    assert.deepEqual(offenders, []);
  });
});

describe("applyTraceOutputBackstop", () => {
  it("leaves anything at or below the budget untouched", () => {
    for (const length of [0, 1, TRACE_OUTPUT_BACKSTOP]) {
      const text = "a".repeat(length);
      assert.equal(applyTraceOutputBackstop(text), text);
    }
  });

  it("cuts over-budget text so the marker fits inside the final length", () => {
    // 20001 is the minimal over-cap case: one character is dropped and replaced
    // by the marker, so the budget is what moves, not the content.
    for (const length of [
      TRACE_OUTPUT_BACKSTOP + 1,
      100_000,
      TRACE_OUTPUT_BACKSTOP * 10,
    ]) {
      const text = "b".repeat(length);
      const capped = applyTraceOutputBackstop(text);

      assert.ok(
        capped.length <= TRACE_OUTPUT_BACKSTOP,
        `length ${length} produced ${capped.length} characters`
      );
      assert.ok(capped.endsWith(TRACE_BACKSTOP_MARKER));
      assert.equal(
        capped,
        "b".repeat(TRACE_OUTPUT_BACKSTOP - TRACE_BACKSTOP_MARKER.length) +
          TRACE_BACKSTOP_MARKER
      );
      // The invariant this face promises: no output can reach a caller longer
      // than the backstop, whatever the tool returned.
      assert.ok(capped.length < text.length);
    }
  });

  it("keeps the prefix a caller already read intact", () => {
    // Truncation is a tail operation: the bytes before the cut must not shift, or
    // a window coordinate from an earlier call would point somewhere else.
    const text = `${"head"}${"t".repeat(TRACE_OUTPUT_BACKSTOP * 2)}`;
    assert.ok(applyTraceOutputBackstop(text).startsWith("head"));
  });
});
