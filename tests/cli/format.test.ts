/**
 * CLI `src/cli/format.ts` projection tests (T2 acceptance).
 *
 * `formatRunHuman` / `formatRunJson` consume harness `RunResult` + `LoopTrace`,
 * not the old `IknowAnswer`. Imports go through `../../src/cli/format.ts`
 * directly (test files use `.ts` extension per repo convention).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { formatRunHuman, formatRunJson } from "../../src/cli/format.ts";
import {
  computeTotals,
  type LoopTrace,
  type RunResult,
  type TurnTrace,
} from "../../src/harness/index.ts";

function mkResult(over: Partial<RunResult> = {}): RunResult {
  return {
    finalText: "hello",
    messages: [],
    turnCount: 1,
    stopReason: "completed",
    ...over,
  };
}

function mkTurn(toolNames: string[], over: Partial<TurnTrace> = {}): TurnTrace {
  return {
    turnIndex: 0,
    supplierStop: "success",
    toolCalls: toolNames.map((n, i) => ({
      toolUseId: `t${i}`,
      toolName: n,
      kind: "ok" as const,
    })),
    durationMs: 5,
    timeoutHit: false,
    signalAborted: false,
    ...over,
  };
}

function mkTrace(turns: TurnTrace[] = []): LoopTrace {
  return { turns, totals: computeTotals(turns) };
}

describe("formatRunHuman", () => {
  it("renders finalText + status line for completed + 1 tool + 1 turn", () => {
    const out = formatRunHuman(
      mkResult({ finalText: "hello" }),
      mkTrace([mkTurn(["echo"], { durationMs: 5 })])
    );
    assert.ok(out.includes("hello"), "should contain finalText");
    assert.ok(out.includes("stop=completed"));
    assert.ok(out.includes("turns=1"));
    assert.ok(out.includes("tools=echo"));
    // Status line ends with `<digits>ms` (e.g. `5ms`).
    assert.match(out, /· \d+ms$/);
  });

  it("renders status line even when finalText is null (maxTurns)", () => {
    const out = formatRunHuman(
      mkResult({ finalText: null, stopReason: "maxTurns", turnCount: 6 }),
      mkTrace([])
    );
    assert.ok(out.includes("stop=maxTurns"));
    assert.ok(
      !out.includes("hello"),
      "must not contain stale 'hello' finalText"
    );
    // status line still present, so tools=- is the fallback.
    assert.ok(out.includes("tools=-"));
  });

  it("zero turns → tools shows '-' placeholder", () => {
    const out = formatRunHuman(mkResult(), mkTrace([]));
    assert.ok(out.includes("tools=-"));
  });

  it("multi-turn multi-tool: dedup preserves first-occurrence order", () => {
    const out = formatRunHuman(
      mkResult(),
      mkTrace([mkTurn(["echo", "get_time"]), mkTurn(["echo"])])
    );
    assert.ok(
      out.includes("tools=echo,get_time"),
      "echo first (first turn), get_time deduped; got: " + out
    );
  });

  it("renders partial finalText for non-completed stopReason (timeout)", () => {
    const out = formatRunHuman(
      mkResult({ finalText: "partial", stopReason: "timeout" }),
      mkTrace([mkTurn([])])
    );
    assert.ok(out.includes("partial"));
    assert.ok(out.includes("stop=timeout"));
  });
});

describe("formatRunJson", () => {
  it("emits the 4 top-level fields and omits messages", () => {
    const parsed = JSON.parse(
      formatRunJson(mkResult(), mkTrace([mkTurn(["echo"])]))
    );
    assert.strictEqual(parsed.finalText, "hello");
    assert.strictEqual(parsed.stopReason, "completed");
    assert.strictEqual(parsed.turnCount, 1);
    assert.ok(parsed.trace && typeof parsed.trace === "object");
    assert.ok(Array.isArray(parsed.trace.turns));
    assert.ok(parsed.trace.totals && typeof parsed.trace.totals === "object");
    assert.ok(
      !("messages" in parsed),
      "messages must NOT appear in JSON output"
    );
  });

  it("empty trace round-trips with turns.length === 0", () => {
    const parsed = JSON.parse(
      formatRunJson(
        mkResult({ finalText: null, stopReason: "maxTurns" }),
        mkTrace([])
      )
    );
    assert.strictEqual(parsed.trace.turns.length, 0);
    assert.strictEqual(parsed.finalText, null);
  });
});
