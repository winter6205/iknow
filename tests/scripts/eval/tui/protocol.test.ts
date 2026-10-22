/**
 * Contract tests for `scripts/eval/tui/protocol.ts` (#1219).
 *
 * WHY: the historical driver let its schedule be whatever the wall clock said
 * at the moment it woke up — a bare `--warmup 20` sleep was the only reason
 * Enter landed, and nothing pinned the rules before the run. These cases make
 * the protocol the ONE place where delivery/readiness/stop policy is decided
 * BEFORE any byte is written, so a run's verdict can be reproduced from the
 * retained document.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  parseProtocol,
  ProtocolError,
} from "../../../../scripts/eval/tui/protocol.ts";
import { validProtocol } from "./fixture.ts";

describe("parseProtocol — pinned rules", () => {
  it("accepts a complete document and exposes the four policy blocks", () => {
    const p = parseProtocol(validProtocol());

    assert.equal(p.label, "unit");
    assert.equal(
      p.runKind,
      "measured",
      "an unlabelled run is the measured window"
    );
    assert.equal(p.stimuli.length, 2);
    assert.equal(p.stimuli[0]?.tag, "S1");
    assert.equal(p.delivery.chunkBytes, 200);
    assert.equal(p.stop.innerWallMs, 60000);
    assert.equal(p.readiness.attempts, 2);
  });

  it("treats a stimulus `at` as an EARLIEST delivery time, not a fixed slot", () => {
    const p = parseProtocol(
      validProtocol({
        stimuli: [
          { at: 1000, tag: "S1", text: "a" },
          { at: 500, tag: "S2", text: "b" },
        ],
      })
    );

    assert.equal(
      p.stimuli[0]?.tag,
      "S2",
      "a due-earlier stimulus may be listed second; order follows `at`"
    );
    assert.equal(p.stimuli[1]?.tag, "S1");
  });

  it("rejects the outer watchdog being shorter than the inner wall plus exit grace", () => {
    assert.throws(
      () =>
        parseProtocol(
          validProtocol({
            stop: {
              minSettleMs: 1000,
              horizonMs: 3000,
              exitGraceMs: 2000,
              innerWallMs: 60000,
            },
            outerWatchdogMs: 61000,
          })
        ),
      (err: unknown) =>
        err instanceof ProtocolError && /watchdog/i.test(err.message),
      "expected a ProtocolError naming the watchdog; the outer wall must outlast the inner wall plus exit grace"
    );
  });

  it("accepts a watchdog exactly one millisecond longer than the inner wall plus grace", () => {
    const p = parseProtocol(
      validProtocol({
        stop: {
          minSettleMs: 1000,
          horizonMs: 3000,
          exitGraceMs: 2000,
          innerWallMs: 60000,
        },
        outerWatchdogMs: 62001,
      })
    );

    assert.equal(p.outerWatchdogMs, 62001);
  });

  it("keeps a resume run labelled as one, so its samples cannot be pooled", () => {
    const p = parseProtocol(validProtocol({ runKind: "resume" }));

    assert.equal(p.runKind, "resume");
  });

  it("refuses `retryEnter: true` — resending an unproven input is the defect, not a policy", () => {
    assert.throws(
      () =>
        parseProtocol(
          validProtocol({
            delivery: {
              chunkBytes: 200,
              chunkDelayMs: 10,
              settleBeforeSubmit: true,
              settleWaitMs: 5000,
              acceptTimeoutMs: 30000,
              retryEnter: true,
            },
          })
        ),
      (err: unknown) =>
        err instanceof ProtocolError && /retryEnter/i.test(err.message),
      "expected a ProtocolError about retryEnter; #1219 forbids blindly resending an input"
    );
  });
});

describe("parseProtocol — invalid input never succeeds silently", () => {
  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["an array", []],
    ["a string", "protocol"],
    ["no label", validProtocol({ label: "" })],
    ["no dataDir", validProtocol({ dataDir: "" })],
    ["no conversationId", validProtocol({ conversationId: "" })],
    ["no child command", validProtocol({ child: { command: "", args: [] } })],
    ["an empty stimulus list", validProtocol({ stimuli: [] })],
    [
      "a stimulus without text",
      validProtocol({ stimuli: [{ at: 1, tag: "S1", text: "" }] }),
    ],
    [
      "a negative due time",
      validProtocol({ stimuli: [{ at: -1, tag: "S1", text: "x" }] }),
    ],
    [
      "duplicate stimulus tags",
      validProtocol({
        stimuli: [
          { at: 1, tag: "S1", text: "a" },
          { at: 2, tag: "S1", text: "b" },
        ],
      }),
    ],
    [
      "a non-finite due time",
      validProtocol({ stimuli: [{ at: Number.NaN, tag: "S1", text: "x" }] }),
    ],
    ["an unknown runKind", validProtocol({ runKind: "sidecar" })],
    ["no readiness policy", validProtocol({ readiness: undefined })],
    ["no delivery policy", validProtocol({ delivery: undefined })],
    ["no stop policy", validProtocol({ stop: undefined })],
    [
      "a zero chunk size",
      validProtocol({
        delivery: {
          chunkBytes: 0,
          chunkDelayMs: 10,
          settleBeforeSubmit: true,
          settleWaitMs: 5000,
          acceptTimeoutMs: 30000,
          retryEnter: false,
        },
      }),
    ],
    [
      "a negative settle wait",
      validProtocol({
        delivery: {
          chunkBytes: 200,
          chunkDelayMs: 10,
          settleBeforeSubmit: true,
          settleWaitMs: -1,
          acceptTimeoutMs: 30000,
          retryEnter: false,
        },
      }),
    ],
    [
      "a stimulus containing a raw newline",
      validProtocol({
        stimuli: [{ at: 1, tag: "S1", text: "line1\nline2" }],
      }),
    ],
    [
      "a stimulus containing a raw carriage return",
      validProtocol({
        stimuli: [{ at: 1, tag: "S1", text: "line1\rline2" }],
      }),
    ],
    ["a negative RSS interval", validProtocol({ rssIntervalMs: -1 })],
    ["a zero watchdog", validProtocol({ outerWatchdogMs: 0 })],
  ];

  for (const [name, doc] of bad) {
    it(`rejects ${name}`, () => {
      assert.throws(
        () => parseProtocol(doc),
        ProtocolError,
        `expected ${name} to be rejected; a protocol that cannot be honored must not parse`
      );
    });
  }

  it("names the offending stimulus when its text would split the composer", () => {
    // A multi-line stimulus is ambiguous for a single-line composer: the first
    // newline submits it and the rest lands as a second, unrelated input. The
    // run would then measure a stimulus the host never received as one.
    assert.throws(
      () =>
        parseProtocol(
          validProtocol({
            stimuli: [
              { at: 1, tag: "S1", text: "one line" },
              { at: 2, tag: "S2", text: "two\nlines" },
            ],
          })
        ),
      (err: unknown) =>
        err instanceof ProtocolError &&
        /S2/.test(err.message) &&
        /CR or LF/.test(err.message),
      "the error must name the stimulus and the forbidden characters, not just fail"
    );
  });
});

/**
 * The optional child environment (#1221 follow-up).
 *
 * WHY it exists: the driver launched the measured child with NO env, so it
 * inherited the runner's. A real-product regression has to run the product
 * against a hermetic stub model, which is only possible if the protocol can
 * say what the child must see. Absent is not "empty" — absent means "inherit
 * exactly what the runner has", which is what every existing protocol does.
 *
 * The parser stays strict for the same reason the rest of this file is strict:
 * a silently coerced value is a run whose identity nobody can reconstruct. An
 * unexpanded `${...}` is the classic case — a shell-style template that was
 * never expanded would hand the child a literal, and the child would fail
 * somewhere far from the protocol that caused it.
 */
describe("parseProtocol — the optional child environment", () => {
  it("leaves an ABSENT env undefined, so the child inherits the runner's env", () => {
    const p = parseProtocol(validProtocol());

    assert.equal(
      p.child.env,
      undefined,
      "absent must stay absent; an empty object would be a DIFFERENT environment"
    );
  });

  it("treats an explicit null the same as absent", () => {
    const p = parseProtocol(
      validProtocol({ child: { command: "true", args: [], env: null } })
    );

    assert.equal(p.child.env, undefined);
  });

  it("accepts a flat string-to-string map verbatim", () => {
    const p = parseProtocol(
      validProtocol({
        child: {
          command: "true",
          args: [],
          env: { IKNOW_LLM_BASE_URL: "http://127.0.0.1:9", NO_COLOR: "1" },
        },
      })
    );

    assert.deepEqual(p.child.env, {
      IKNOW_LLM_BASE_URL: "http://127.0.0.1:9",
      NO_COLOR: "1",
    });
  });

  it("accepts an empty map as a real, explicit environment", () => {
    const p = parseProtocol(
      validProtocol({ child: { command: "true", args: [], env: {} } })
    );

    assert.deepEqual(
      p.child.env,
      {},
      "an explicit empty env is not the same as absent"
    );
  });

  const bad: readonly [string, unknown][] = [
    ["a non-object env", ["A=1"]],
    ["a string env", "A=1"],
    ["a numeric env value", { A: 1 }],
    ["a null env value", { A: null }],
    ["an unexpanded template value", { IKNOW_LLM_API_KEY: "${API_KEY}" }],
    [
      "an unexpanded template in the middle of a value",
      { A: "prefix-${HOME}-suffix" },
    ],
    ["an empty env name", { "": "x" }],
    ["an env name carrying an assignment", { "A=B": "x" }],
  ];

  for (const [name, env] of bad) {
    it(`rejects ${name}`, () => {
      assert.throws(
        () =>
          parseProtocol(
            validProtocol({ child: { command: "true", args: [], env } })
          ),
        ProtocolError,
        `expected ${name} to be rejected; a silently coerced env would misreport the run's identity`
      );
    });
  }

  it("never puts a value into the error message, only the offending name", () => {
    assert.throws(
      () =>
        parseProtocol(
          validProtocol({
            child: {
              command: "true",
              args: [],
              env: { IKNOW_LLM_API_KEY: "${API_KEY}" },
            },
          })
        ),
      (err: unknown) =>
        err instanceof ProtocolError &&
        /IKNOW_LLM_API_KEY/.test(err.message) &&
        !err.message.includes("API_KEY}") &&
        !/\$\{/.test(err.message),
      "a rejected credential-shaped value must not be echoed back into the error"
    );
  });
});
