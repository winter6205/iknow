/**
 * One parser for the violation payload, and no silent rewriting of a tier.
 *
 * Three hosts read the same `createKillSessionHook` JSON, and each had its own
 * reader with its own answer:
 *
 *   - `trace/violation-record.ts` accepted `{mid, high, mid-escalation}` and
 *     rewrote anything else to `"mid"`.
 *   - `session-api/hub.ts` accepted only `{mid, high}` and returned `undefined`
 *     for `"mid-escalation"` — dropping the whole row, so the turn's
 *     structured cause could not be joined back to the trace.
 *   - `cli/chat-session.ts`'s formatter ignored `tier` entirely.
 *
 * Measured on one payload, the same escalation read as `tier=mid` in the trace,
 * vanished in the hub projection, and rendered as `tier=mid` at the CLI. SC12
 * asks the trace to let a reviewer correlate the policy verdict, the tool
 * result and the turn outcome; a reader that silently renames a tier, or a
 * projection that drops the row, breaks that join at the exact moment it is
 * needed.
 *
 * The default is the part worth stating plainly. Rewriting an unrecognized
 * tier to `"mid"` is a fabricated fact: it asserts the counter escalated on
 * the mid threshold when the producer may have meant something else entirely,
 * and the repository's own posture elsewhere (`cleanup-result.ts`: "Nothing
 * here converts a failure into a stop") is the opposite. An unknown or absent
 * tier is now ABSENT — the row stays readable and the consumer knows the
 * producer did not name one.
 *
 * Every case below is the same payload run through the same function, so a
 * regression in one host cannot be reintroduced by editing that host.
 */

import { describe, expect, it } from "vitest";

import { parseViolationEvent } from "../../../src/harness/sandbox/violation-handling.js";
import { violationRecordFromReason } from "../../../src/harness/trace/violation-record.js";
import { formatSecurityInterruption } from "../../../src/cli/chat-session.js";

/** The escalation notification `createKillSessionHook` writes to `onKill`. */
const NOTIFICATION = {
  kind: "violation",
  tier: "mid-escalation",
  tool: "bash",
  message: "[hard_wall] dangerous command pattern matched",
  turnId: "turn-1",
} as const;

/** The structured interruption report written to `onInterrupt`. */
const REPORT = {
  kind: "violation",
  tier: "mid",
  tool: "bash",
  message: "[hard_wall] dangerous command pattern matched",
  turnId: "turn-1",
  confirmedViolations: 3,
  cleanup: [],
} as const;

describe("parseViolationEvent — the single reader for the violation payload", () => {
  it("reads the escalation notification as the notification, not as a mid report", () => {
    // `mid-escalation` is a real tier in the produced payload: it is the
    // operator notification written at the moment the threshold is reached,
    // before any cleanup pass has run. Collapsing it into `mid` would claim a
    // structured report exists when none has been collected.
    const event = parseViolationEvent(JSON.stringify(NOTIFICATION));
    expect(event).toBeDefined();
    expect(event!.tier).toBe("mid-escalation");
    expect(event!.tool).toBe("bash");
    expect(event!.message).toBe(NOTIFICATION.message);
  });

  it("reads the structured report with its count and cleanup", () => {
    const event = parseViolationEvent(JSON.stringify(REPORT));
    expect(event).toBeDefined();
    expect(event!.tier).toBe("mid");
    expect(event!.confirmedViolations).toBe(3);
    expect(event!.cleanup).toEqual([]);
  });

  it("leaves an ABSENT tier absent rather than inventing one", () => {
    // The field not being there is a fact about the producer ("it named no
    // tier"), and it is different from a fact recorded as `mid`.
    const event = parseViolationEvent(
      JSON.stringify({ kind: "violation", tool: "bash", message: "m" })
    );
    expect(event).toBeDefined();
    expect(event!.tier).toBeUndefined();
  });

  it("leaves an UNRECOGNIZED tier absent rather than rewriting it to mid", () => {
    // A tier this build does not know is not evidence that the mid threshold
    // was crossed. Recording it as `mid` would let a future producer's new
    // severity be silently re-encoded as a milder one.
    const event = parseViolationEvent(
      JSON.stringify({
        kind: "violation",
        tier: "catastrophic",
        tool: "bash",
        message: "m",
        confirmedViolations: 1,
        cleanup: [],
      })
    );
    expect(event).toBeDefined();
    expect(event!.tier).toBeUndefined();
  });

  it("preserves a high-severity payload's tier verbatim", () => {
    const event = parseViolationEvent(
      JSON.stringify({ ...REPORT, tier: "high" })
    );
    expect(event!.tier).toBe("high");
  });

  it("rejects a payload that is not a violation record at all", () => {
    expect(parseViolationEvent("not-json")).toBeUndefined();
    expect(parseViolationEvent(JSON.stringify({ kind: "other" }))).toBeUndefined();
    expect(parseViolationEvent(JSON.stringify(["a"]))).toBeUndefined();
  });

  it("drops a malformed cleanup item rather than coercing it", () => {
    // The one failure mode this contract exists to prevent is a fabricated
    // `confirmed_stopped`. An item whose cleanup is not one of the three
    // states carries no claim, so it is dropped, not defaulted.
    const event = parseViolationEvent(
      JSON.stringify({
        ...REPORT,
        cleanup: [
          {
            kind: "background_task",
            id: "t1",
            state: "confirmed_stopped",
            // No `pgid`: the bounded observation never happened.
            cleanup: { state: "confirmed_stopped" },
          },
        ],
      })
    );
    expect(event!.cleanup).toEqual([]);
  });
});

describe("the three hosts read the payload through that one parser", () => {
  it("the trace keeps the notification's own tier rather than renaming it", () => {
    const record = violationRecordFromReason(
      JSON.stringify(NOTIFICATION),
      "2026-01-01T00:00:00.000Z"
    );
    expect(record!.tier).toBe("mid-escalation");
  });

  it("the trace leaves an unknown tier absent rather than defaulting to mid", () => {
    const record = violationRecordFromReason(
      JSON.stringify({ kind: "violation", tier: "catastrophic", tool: "bash", message: "m" }),
      "2026-01-01T00:00:00.000Z"
    );
    expect(record!.tier).toBeUndefined();
  });

  it("the CLI line names the notification's tier, not a rewritten mid", () => {
    // The same payload the trace records as `mid-escalation` must not be
    // rendered to the operator as `mid`: the two answers about one event are
    // exactly the divergence this test exists to prevent.
    const line = formatSecurityInterruption(JSON.stringify(NOTIFICATION));
    expect(line).toContain("mid-escalation");
    expect(line).not.toContain("tier=mid ");
  });
});
