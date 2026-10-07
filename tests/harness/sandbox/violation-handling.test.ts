/**
 * tests/harness/sandbox/violation-handling.test.ts
 *
 * Three-tier violation handling — counter, kill hook, wiring.
 *
 * Boundary classes covered:
 *  - normal: mid N=1,2 don't kill; N=3 kills; reset works
 *  - high: single high-tier record kills immediately
 *  - low: low-tier does NOT accumulate
 *  - ask path: user_denied → low (per spec, ask doesn't count)
 *  - streak discipline (#1170 / ADR-0135): only an admitted successful call
 *    resets; repeated hits of one rule keep accumulating; excluded failure
 *    classes are neutral (neither increment nor reset)
 *  - concurrency / overflow: re-records after kill keep firing (idempotent
 *    latch via wireKillSessionNotification's `fired` flag)
 *  - exception: non-execution_failed results are ignored; untracked prefixes
 *    are ignored
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createViolationCounter,
  createKillSessionHook,
  categorizeResult,
  wireKillSessionNotification,
} from "../../../src/harness/sandbox/violation-handling.js";
import type { ViolationEvent } from "../../../src/harness/sandbox/violation-handling.js";
import type { PostToolUseHook } from "../../../src/harness/permission/types.js";

/** The result kinds a PostToolUse hook can be handed. */
type PostToolUseResultKind =
  "ok" | "validation_failed" | "tool_not_found" | "execution_failed";

const BASE_EVENT: Omit<ViolationEvent, "tier"> = {
  tool: "bash",
  input: { command: "rm -rf /" },
  message: "[hard_wall] dangerous command: rm -rf",
};

/**
 * Drive one hook invocation; `kind`/`message` mirror the executor result.
 *
 * The hook is typed as `PostToolUseHook` because the interruption report it
 * returns is a promise (ADR-0135 waits on the cleanup pass), and the caller
 * awaits the return so a report is settled before the next observation.
 */
async function observe(
  hook: PostToolUseHook,
  result: {
    readonly name?: string;
    readonly kind: PostToolUseResultKind;
    readonly message?: string;
    readonly payload?: unknown;
  }
): Promise<void> {
  await hook({
    toolUseId: "t",
    name: result.name ?? "bash",
    input: {},
    kind: result.kind,
    ...(result.message !== undefined ? { message: result.message } : {}),
    ...(result.payload !== undefined ? { payload: result.payload } : {}),
  });
}

describe("createViolationCounter", () => {
  it("mid N=1,2 do NOT kill; N=3 kills (default threshold)", () => {
    const c = createViolationCounter();
    let r = c.record({ ...BASE_EVENT, tier: "mid" });
    assert.equal(r.count, 1);
    assert.equal(r.shouldKill, false);
    r = c.record({ ...BASE_EVENT, tier: "mid" });
    assert.equal(r.count, 2);
    assert.equal(r.shouldKill, false);
    r = c.record({ ...BASE_EVENT, tier: "mid" });
    assert.equal(r.count, 3);
    assert.equal(r.shouldKill, true);
  });

  it("custom threshold N=2 escalates on second mid record", () => {
    const c = createViolationCounter({ midEscalationThreshold: 2 });
    const r1 = c.record({ ...BASE_EVENT, tier: "mid" });
    assert.equal(r1.shouldKill, false);
    const r2 = c.record({ ...BASE_EVENT, tier: "mid" });
    assert.equal(r2.shouldKill, true);
  });

  it("high-tier record kills immediately on first call regardless of count", () => {
    const c = createViolationCounter();
    const r = c.record({ ...BASE_EVENT, tier: "high" });
    assert.equal(r.shouldKill, true);
    // Snapshot keeps returning mid count (still 0).
    assert.equal(c.snapshot(), 0);
  });

  it("low-tier records do NOT accumulate", () => {
    const c = createViolationCounter();
    for (let i = 0; i < 5; i += 1) {
      const r = c.record({ ...BASE_EVENT, tier: "low" });
      assert.equal(r.count, 0);
      assert.equal(r.shouldKill, false);
    }
    assert.equal(c.snapshot(), 0);
  });

  it("reset clears the mid-tier accumulator", () => {
    const c = createViolationCounter();
    c.record({ ...BASE_EVENT, tier: "mid" });
    c.record({ ...BASE_EVENT, tier: "mid" });
    assert.equal(c.snapshot(), 2);
    c.reset();
    assert.equal(c.snapshot(), 0);
    // After reset, two more mid records should not yet kill.
    const r = c.record({ ...BASE_EVENT, tier: "mid" });
    assert.equal(r.shouldKill, false);
  });

  it("ask path (user_denied) records as low; subsequent low does not accumulate", () => {
    const c = createViolationCounter();
    const ask1 = c.record({
      ...BASE_EVENT,
      tier: "low",
      message: "[user_denied] user declined tool call: bash",
    });
    const ask2 = c.record({
      ...BASE_EVENT,
      tier: "low",
      message: "[user_denied] user declined tool call: bash",
    });
    assert.equal(ask1.shouldKill, false);
    assert.equal(ask2.shouldKill, false);
    assert.equal(ask2.count, 0);
  });

  it("returned object is frozen", () => {
    const c = createViolationCounter();
    assert.equal(Object.isFrozen(c), true);
  });
});

describe("createKillSessionHook", () => {
  it("forwards execution_failed with [hard_wall] dangerous to mid-tier", () => {
    const counter = createViolationCounter();
    let killed = false;
    const hook = createKillSessionHook({
      counter,
      onKill: () => {
        killed = true;
      },
    });
    hook({
      toolUseId: "x",
      name: "bash",
      input: { command: "rm -rf /" },
      kind: "execution_failed",
      message: "[hard_wall] dangerous command rejected",
    });
    assert.equal(killed, false);
    assert.equal(counter.snapshot(), 1);
  });

  it("fires onKill when mid-tier threshold is hit", () => {
    const counter = createViolationCounter({ midEscalationThreshold: 2 });
    const killReasons: string[] = [];
    const hook = createKillSessionHook({
      counter,
      onKill: (r) => killReasons.push(r),
    });
    hook({
      toolUseId: "x",
      name: "bash",
      input: { command: "rm -rf /" },
      kind: "execution_failed",
      message: "[hard_wall] dangerous command",
    });
    hook({
      toolUseId: "y",
      name: "bash",
      input: { command: "rm -rf /" },
      kind: "execution_failed",
      message: "[hard_wall] dangerous command",
    });
    assert.equal(killReasons.length, 1);
    assert.match(killReasons[0] ?? "", /"tier":"mid-escalation"/);
    assert.match(killReasons[0] ?? "", /"kind":"violation"/);
  });

  it("fires onKill on a single mid-tier record when threshold=1", () => {
    const counter = createViolationCounter({ midEscalationThreshold: 1 });
    const killReasons: string[] = [];
    const hook = createKillSessionHook({
      counter,
      onKill: (r) => killReasons.push(r),
    });
    hook({
      toolUseId: "z",
      name: "bash",
      input: {},
      kind: "execution_failed",
      message: "[permission_denied] dangerous command",
    });
    assert.equal(killReasons.length, 1);
    assert.match(killReasons[0] ?? "", /"tier":"mid-escalation"/);
  });

  it("high-tier event (escape attempt) kills via the counter's immediate path", () => {
    // The hook + categorize chain currently maps no permission-executor prefix
    // to tier=high; exercise the high-tier counter contract directly so the
    // "high kills immediately" guarantee is still under test.
    const counter = createViolationCounter();
    const killReasons: string[] = [];
    counter.record({
      tier: "high",
      tool: "bash",
      input: {},
      message: "escape attempt",
    });
    if (
      counter.record({ tier: "low", tool: "x", input: {}, message: "y" })
        .shouldKill
    ) {
      killReasons.push("should not fire");
    }
    // Independent confirm: high-tier counter snapshot kills on first call.
    const c2 = createViolationCounter();
    const r = c2.record({
      tier: "high",
      tool: "bash",
      input: {},
      message: "escape",
    });
    assert.equal(r.shouldKill, true);
    assert.equal(killReasons.length, 0);
  });

  it("ask path: user_denied does not kill even after repeated denies", () => {
    const counter = createViolationCounter();
    let killed = false;
    const hook = createKillSessionHook({
      counter,
      onKill: () => {
        killed = true;
      },
    });
    for (let i = 0; i < 10; i += 1) {
      hook({
        toolUseId: `id-${i}`,
        name: "bash",
        input: { command: "echo" },
        kind: "execution_failed",
        message: "[user_denied] user declined tool call: bash",
      });
    }
    assert.equal(killed, false);
    assert.equal(counter.snapshot(), 0);
  });

  it("ignores ok results (no counter increment, no onKill)", () => {
    const counter = createViolationCounter();
    let killed = false;
    const hook = createKillSessionHook({
      counter,
      onKill: () => {
        killed = true;
      },
    });
    hook({
      toolUseId: "ok1",
      name: "read_file",
      input: { path: "/foo" },
      kind: "ok",
      payload: [],
    });
    assert.equal(counter.snapshot(), 0);
    assert.equal(killed, false);
  });
});

/**
 * #1170 / ADR-0135 streak discipline. The counter instance is scoped to one
 * user turn by its host, so these cases exercise the streak itself: what
 * increments it, what resets it, and what leaves it untouched.
 */
describe("consecutive confirmed violations (ADR-0135 streak)", () => {
  it("repeated hits of the SAME rule accumulate — no de-duplication", async () => {
    const counter = createViolationCounter();
    const hook = createKillSessionHook({ counter, onKill: () => undefined });
    for (let i = 0; i < 2; i += 1) {
      await observe(hook, {
        kind: "execution_failed",
        message: "[hard_wall] sensitive path: /etc/shadow",
      });
    }
    assert.equal(counter.snapshot(), 2);
    await observe(hook, {
      kind: "execution_failed",
      message: "[hard_wall] sensitive path: /etc/shadow",
    });
    assert.equal(counter.snapshot(), 3);
  });

  it("different rules accumulate onto the same streak", async () => {
    const counter = createViolationCounter();
    const hook = createKillSessionHook({ counter, onKill: () => undefined });
    await observe(hook, {
      kind: "execution_failed",
      message: "[hard_wall] dangerous command",
    });
    await observe(hook, {
      kind: "execution_failed",
      message: "[hard_wall] sensitive path",
    });
    assert.equal(counter.snapshot(), 2);
  });

  it("an admitted successful call resets the streak", async () => {
    const counter = createViolationCounter();
    const hook = createKillSessionHook({ counter, onKill: () => undefined });
    await observe(hook, {
      kind: "execution_failed",
      message: "[hard_wall] dangerous command",
    });
    await observe(hook, {
      kind: "execution_failed",
      message: "[hard_wall] dangerous command",
    });
    assert.equal(counter.snapshot(), 2);
    await observe(hook, {
      kind: "ok",
      payload: [{ type: "text", text: "done" }],
    });
    assert.equal(counter.snapshot(), 0);
    // Two more violations after the reset must not reach the threshold.
    await observe(hook, {
      kind: "execution_failed",
      message: "[hard_wall] dangerous command",
    });
    await observe(hook, {
      kind: "execution_failed",
      message: "[hard_wall] dangerous command",
    });
    assert.equal(counter.snapshot(), 2);
  });

  it("excluded failure classes are neutral: they neither increment nor reset", async () => {
    const cases = [
      // routine permission denial (non-dangerous)
      {
        kind: "execution_failed",
        message: "[permission_denied] category default",
      },
      // user declined the call
      { kind: "execution_failed", message: "[user_denied] user declined" },
      // per-call timeout (ADR-0091) — a timeout is not a security violation
      { kind: "execution_failed", message: "timeout" },
      // unconfirmed cleanup failure surfacing as a tool failure
      { kind: "execution_failed", message: "background cleanup unconfirmed" },
      // validation failure
      { kind: "validation_failed", message: "bad input" },
      // tool not found
      { kind: "tool_not_found", toolName: "nope" },
    ] as ReadonlyArray<{
      readonly kind: PostToolUseResultKind;
      readonly message?: string;
      readonly toolName?: string;
    }>;
    for (const neutral of cases) {
      const counter = createViolationCounter();
      const hook = createKillSessionHook({ counter, onKill: () => undefined });
      await observe(hook, {
        kind: "execution_failed",
        message: "[hard_wall] dangerous command",
      });
      await observe(hook, {
        kind: "execution_failed",
        message: "[hard_wall] dangerous command",
      });
      assert.equal(
        counter.snapshot(),
        2,
        `setup for ${neutral.message ?? neutral.kind}`
      );
      await observe(hook, { ...neutral });
      assert.equal(
        counter.snapshot(),
        2,
        `${neutral.message ?? neutral.kind} must leave the streak unchanged`
      );
    }
  });

  it("reviewer unavailability is NOT a confirmed violation (ADR-0127)", async () => {
    // The typed review deny is security-relevant, but unavailability of the
    // reviewer is an operational gap, not confirmed unsafe intent: it must not
    // be able to reach the interruption threshold on its own.
    const counter = createViolationCounter();
    const hook = createKillSessionHook({ counter, onKill: () => undefined });
    for (let i = 0; i < 5; i += 1) {
      await observe(hook, {
        kind: "execution_failed",
        message: "[security_review_unavailable] no reviewer route",
      });
    }
    assert.equal(counter.snapshot(), 0);
  });

  it("a fresh counter (new user turn) starts at zero — no cross-turn leak", async () => {
    const first = createViolationCounter();
    const hook = createKillSessionHook({
      counter: first,
      onKill: () => undefined,
    });
    await observe(hook, {
      kind: "execution_failed",
      message: "[hard_wall] dangerous command",
    });
    await observe(hook, {
      kind: "execution_failed",
      message: "[hard_wall] dangerous command",
    });
    assert.equal(first.snapshot(), 2);

    const second = createViolationCounter();
    assert.equal(second.snapshot(), 0);
    const hook2 = createKillSessionHook({
      counter: second,
      onKill: () => undefined,
    });
    await observe(hook2, {
      kind: "execution_failed",
      message: "[hard_wall] dangerous command",
    });
    assert.equal(second.snapshot(), 1);
  });
});

describe("categorizeResult", () => {
  it("[hard_wall] dangerous / sensitive → mid", () => {
    assert.equal(
      categorizeResult({
        name: "bash",
        input: {},
        kind: "execution_failed",
        message: "[hard_wall] dangerous command rejected",
      }).tier,
      "mid"
    );
    assert.equal(
      categorizeResult({
        name: "read_file",
        input: {},
        kind: "execution_failed",
        message: "[hard_wall] sensitive path",
      }).tier,
      "mid"
    );
  });

  // The end-to-end walk of `[network_denied] → mid` is covered by
  // tests/harness/aci/bash-egress-typed-failure.test.ts (real egress violation →
  // typed failure → categorizeResult); no second string fixture here.
  it("[network_denied] → mid", () => {
    assert.equal(
      categorizeResult({
        name: "bash",
        input: {},
        kind: "execution_failed",
        message: "[network_denied] evil.com: not in allowlist",
      }).tier,
      "mid"
    );
  });

  it("[permission_denied] non-dangerous → low", () => {
    assert.equal(
      categorizeResult({
        name: "write_file",
        input: {},
        kind: "execution_failed",
        message: "[permission_denied] category default: write → ask",
      }).tier,
      "low"
    );
  });

  it("[user_denied] → low (ask path)", () => {
    assert.equal(
      categorizeResult({
        name: "bash",
        input: {},
        kind: "execution_failed",
        message: "[user_denied] user declined tool call: bash",
      }).tier,
      "low"
    );
  });

  it("categorizeResult reads only the message, never the tool input", () => {
    // Categorization is decoupled from the input surface: the same
    // [user_denied] message lands on the low tier under any input shape; there is
    // no hidden branch that re-tiers by input fields.
    assert.equal(
      categorizeResult({
        name: "bash",
        input: { command: "curl -sS http://127.0.0.1:3000" },
        kind: "execution_failed",
        message: "[user_denied] user declined tool call: bash",
      }).tier,
      "low"
    );
  });

  it("non-execution_failed results → undefined tier", () => {
    assert.equal(
      categorizeResult({
        name: "bash",
        input: {},
        kind: "ok",
      }).tier,
      undefined
    );
    assert.equal(
      categorizeResult({
        name: "bash",
        input: {},
        kind: "validation_failed",
        message: "bad input",
      }).tier,
      undefined
    );
  });

  it("untracked prefixes → undefined tier", () => {
    assert.equal(
      categorizeResult({
        name: "bash",
        input: {},
        kind: "execution_failed",
        message: "[something_else] unrelated",
      }).tier,
      undefined
    );
  });

  it("cancellation is neutral: a cancelled call is not a security violation", () => {
    assert.equal(
      categorizeResult({
        name: "bash",
        input: {},
        kind: "execution_failed",
        message: "cancelled",
      }).tier,
      undefined
    );
  });
});

describe("wireKillSessionNotification", () => {
  it("writes a single formatted line and toggles exitCode on first call", () => {
    const saved = process.exitCode;
    process.exitCode = 0;
    try {
      const sinkCalls: string[] = [];
      const onKill = wireKillSessionNotification({
        sink: (line) => sinkCalls.push(line),
      });
      onKill(
        JSON.stringify({
          kind: "violation",
          tier: "high",
          tool: "bash",
          message: "[hard_wall] escape attempt",
        })
      );
      assert.equal(sinkCalls.length, 1);
      assert.match(sinkCalls[0] ?? "", /^\[violation\] session killed:/);
      assert.match(sinkCalls[0] ?? "", /tier=high/);
      assert.match(sinkCalls[0] ?? "", /tool=bash/);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = saved;
    }
  });

  it("latch: subsequent onKill calls do not re-write or re-set exitCode", () => {
    const saved = process.exitCode;
    process.exitCode = 0;
    try {
      const sinkCalls: string[] = [];
      const onKill = wireKillSessionNotification({
        sink: (line) => sinkCalls.push(line),
      });
      const payload = (message: string): string =>
        JSON.stringify({
          kind: "violation",
          tier: "high",
          tool: "bash",
          message,
        });
      onKill(payload("x"));
      onKill(payload("y"));
      onKill(payload("z"));
      assert.equal(sinkCalls.length, 1);
    } finally {
      process.exitCode = saved;
    }
  });

  it("falls back gracefully on malformed JSON (fail-safe: unknown kill reason → high)", () => {
    // Malformed JSON previously downgraded to "mid"; we now treat an
    // unparseable kill reason as the worst tier ("high"). The line still
    // carries the raw reason in `message=` for diagnosis.
    const sinkCalls: string[] = [];
    const onKill = wireKillSessionNotification({
      sink: (line) => sinkCalls.push(line),
    });
    onKill("not-json-at-all");
    assert.equal(sinkCalls.length, 1);
    assert.match(sinkCalls[0] ?? "", /tier=high/);
    assert.match(sinkCalls[0] ?? "", /message=not-json-at-all/);
  });

  it("honors parsed.tier when present and valid (low / mid / high)", () => {
    // The notification is one-shot (latched); each tier branch needs its own
    // fresh handle so the latch does not swallow later emissions.
    // `kind: "violation"` is present because `createKillSessionHook` always
    // writes it: the payload is read by the same `parseViolationEvent` the
    // trace and the serve hub use, and that reader requires the tag to accept
    // a payload as a violation record at all.
    function fire(tier: string): string {
      const sinkCalls: string[] = [];
      const onKill = wireKillSessionNotification({
        sink: (line) => sinkCalls.push(line),
      });
      onKill(
        JSON.stringify({ kind: "violation", tier, tool: "x", message: "y" })
      );
      return sinkCalls[0] ?? "";
    }
    assert.match(fire("low"), /tier=low/);
    assert.match(fire("mid"), /tier=mid/);
    assert.match(fire("high"), /tier=high/);
    // The escalation notification is a real stage label, not a severity the
    // counter emits: it reaches this line as `mid` (the threshold it crossed)
    // while the trace records it verbatim as `mid-escalation`.
    assert.match(fire("mid-escalation"), /tier=mid/);
  });

  it("a tier outside the recognized union is NOT rewritten to a severity", () => {
    // The previous contract defaulted an unrecognized tier to `mid`, which
    // asserted a severity the payload did not carry — and one this operator
    // line is the last place to invent. The shared parser leaves it absent,
    // and the line says so rather than inventing a severity to print.
    const sinkCalls: string[] = [];
    const onKill = wireKillSessionNotification({
      sink: (line) => sinkCalls.push(line),
    });
    onKill(
      JSON.stringify({
        kind: "violation",
        tier: "ultra",
        tool: "x",
        message: "y",
      })
    );
    assert.match(sinkCalls[0] ?? "", /tier=unrecorded/);
    assert.doesNotMatch(sinkCalls[0] ?? "", /tier=mid\b/);
  });

  it("an untagged payload is the fail-safe path, not a violation record", () => {
    // No `kind: "violation"` means this is not a payload the shared reader can
    // accept. A reason that still reached `onKill` DID stop a session, so the
    // worst tier is reported rather than downgrading its severity.
    const sinkCalls: string[] = [];
    const onKill = wireKillSessionNotification({
      sink: (line) => sinkCalls.push(line),
    });
    onKill(JSON.stringify({ tier: "low", tool: "x", message: "y" }));
    assert.match(sinkCalls[0] ?? "", /tier=high/);
  });
});
