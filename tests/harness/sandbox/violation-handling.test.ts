/**
 * tests/harness/sandbox/violation-handling.test.ts
 *
 * Three-tier violation handling (T6 / #123 Q4) — counter, kill hook, wiring.
 *
 * Boundary classes covered:
 *  - normal: mid N=1,2 don't kill; N=3 kills; reset works
 *  - high: single high-tier record kills immediately
 *  - low: low-tier does NOT accumulate
 *  - ask path: user_denied → low (per spec, ask doesn't count)
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

const BASE_EVENT: Omit<ViolationEvent, "tier"> = {
  tool: "bash",
  input: { command: "rm -rf /" },
  message: "[hard_wall] dangerous command: rm -rf",
};

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

  it("[network_denied] → mid", () => {
    assert.equal(
      categorizeResult({
        name: "bash",
        input: {},
        kind: "execution_failed",
        message: "[network_denied] domain not in whitelist: evil.com",
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

  it("non-execution_failed results → undefined tier", () => {
    assert.equal(
      categorizeResult({
        name: "bash",
        input: {},
        kind: "ok",
        payload: [],
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
});

describe("wireKillSessionNotification", () => {
  it("writes a single formatted line and toggles exitCode on first call", () => {
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
  });

  it("latch: subsequent onKill calls do not re-write or re-set exitCode", () => {
    const sinkCalls: string[] = [];
    const onKill = wireKillSessionNotification({
      sink: (line) => sinkCalls.push(line),
    });
    onKill(JSON.stringify({ tier: "high", tool: "bash", message: "x" }));
    onKill(JSON.stringify({ tier: "high", tool: "bash", message: "y" }));
    onKill(JSON.stringify({ tier: "high", tool: "bash", message: "z" }));
    assert.equal(sinkCalls.length, 1);
  });

  it("falls back gracefully on malformed JSON (fail-safe: unknown kill reason → high)", () => {
    // M3 fix: malformed JSON previously downgraded to "mid"; we now treat
    // an unparseable kill reason as the worst tier ("high"). The line still
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
    function fire(tier: string): string {
      const sinkCalls: string[] = [];
      const onKill = wireKillSessionNotification({
        sink: (line) => sinkCalls.push(line),
      });
      onKill(JSON.stringify({ tier, tool: "x", message: "y" }));
      return sinkCalls[0] ?? "";
    }
    assert.match(fire("low"), /tier=low/);
    assert.match(fire("mid"), /tier=mid/);
    assert.match(fire("high"), /tier=high/);
  });

  it("parsed.tier outside the low/mid/high union falls back to mid", () => {
    const sinkCalls: string[] = [];
    const onKill = wireKillSessionNotification({
      sink: (line) => sinkCalls.push(line),
    });
    onKill(JSON.stringify({ tier: "ultra", tool: "x", message: "y" }));
    assert.match(sinkCalls[0] ?? "", /tier=mid/);
  });
});
