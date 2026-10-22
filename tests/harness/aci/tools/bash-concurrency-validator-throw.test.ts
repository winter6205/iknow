/**
 * #D2 — the readonly validator THROWING inside the per-call concurrency
 * predicate.
 *
 * The plan's Test map asks for a counter-example where "validator 抛异常" —
 * the validator throws. The branch already realized the REJECTION case
 * (`touch newfile`, where the validator throws its typed
 * `ReadonlyViolationError`); this file realizes the literal case: the
 * validator throws an UNEXPECTED error, a shape no policy decision produces.
 * A bug in the validator, a parser fault, a future refactor that raises the
 * wrong error type — the predicate must still answer, and it must answer
 * "not concurrency-safe", because an uncertain answer must never widen
 * concurrency (ADR-0148 §2, §6).
 *
 * The seam: the throw is injected at the validator's MODULE BOUNDARY — the
 * same interception style the branch already uses for `node:child_process`
 * in `bash-fence-parity.test.ts`. The module under test
 * (`isReadonlyBashConcurrencySafe`, `src/harness/aci/tools/bash-concurrency.ts`)
 * is NOT mocked: the real predicate, the real wave resolver and the real
 * wave partitioner all run.
 *
 * The mock is CONDITIONAL, not blanket: only one command makes the validator
 * throw, every other command is answered by the REAL validator. That is what
 * makes the case meaningful — the sibling case below proves the mock does not
 * deny everything, so the refusal is caused by the THROW and by nothing else.
 *
 * What this case catches when it breaks:
 *   - a predicate that lets the validator's throw escape (the module's
 *     "never throws" guarantee) → the call throws instead of answering;
 *   - a predicate that answers `true` on a throw (fail-open) → the call
 *     would join a wave on an unknown answer.
 *
 * HOW THIS FILE GOES RED (measured, not assumed): removing BOTH
 * throw-handling branches from `bash-concurrency.ts` — the validator call's
 * own try/catch (`passesReadonlyPolicy`) AND the module-level "never
 * throws" catch (`isReadonlyBashConcurrencySafe`) — turns 3 of the 5 cases
 * red (the injected throw escapes the predicate). Removing only ONE of the
 * two keeps the file GREEN, and that is the point of the pair: each one
 * alone already answers `false` for a throwing validator, so the guarantee
 * is carried twice over. The "consulted the validator" case is the one that
 * proves the mock is not vacuous — it fails when the throw escapes, because
 * the mock's own bookkeeping call never happens.
 */

import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";

/**
 * The mock's bookkeeping. `vi.hoisted` so the factory (which vitest hoists
 * above the imports) can reach it without a temporal-dead-zone error.
 */
const h = vi.hoisted(() => ({
  /** every command the mocked validator was asked about. */
  calls: [] as string[],
  /** the one command whose validator call throws an unexpected error. */
  throwing: "git status",
  /** a command the real validator answers normally. */
  sibling: "ls",
}));

vi.mock(
  "../../../../src/harness/aci/tools/bash-readonly.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../src/harness/aci/tools/bash-readonly.js")
      >();
    return {
      ...actual,
      // The injected throw: NOT a `ReadonlyViolationError` (the typed policy
      // refusal), but an unexpected fault — the shape the plan's row names.
      validateReadonlyCommand: vi.fn((command: string) => {
        h.calls.push(command);
        if (command === h.throwing) {
          throw new Error("readonly validator exploded (injected)");
        }
        return actual.validateReadonlyCommand(command);
      }),
    };
  }
);

import { isReadonlyBashConcurrencySafe } from "../../../../src/harness/aci/tools/bash-concurrency.ts";
import {
  isConcurrencySafeForCall,
  partitionConcurrencyWaves,
} from "../../../../src/harness/tools/concurrency-waves.ts";

/** The tool metadata bash declares: the static flag is false, the
 * per-call predicate decides. */
const BASH_META = {
  isConcurrencySafe: false,
  isConcurrencySafeForInput: isReadonlyBashConcurrencySafe,
};

describe("isReadonlyBashConcurrencySafe — the readonly validator throws", () => {
  it("judges the call NOT concurrency-safe (an uncertain answer never widens concurrency)", () => {
    assert.equal(isReadonlyBashConcurrencySafe({ command: h.throwing }), false);
  });

  it("does not propagate the validator's throw out of the predicate", () => {
    // The module's contract is "never throws" — the wave splitter must not
    // fail because a judgment was hard to make.
    assert.doesNotThrow(() =>
      isReadonlyBashConcurrencySafe({ command: h.throwing })
    );
  });

  it("consulted the validator (the case is not vacuous)", () => {
    h.calls.length = 0;
    isReadonlyBashConcurrencySafe({ command: h.throwing });
    assert.ok(
      h.calls.includes(h.throwing),
      `the mocked validator must have been consulted for ${JSON.stringify(h.throwing)}, got ${JSON.stringify(h.calls)}`
    );
  });

  it("a sibling command whose validator does NOT throw is still judged safe", () => {
    // The mock is conditional: the refusal above is caused by the THROW,
    // not by the mock denying everything.
    assert.equal(isReadonlyBashConcurrencySafe({ command: h.sibling }), true);
  });

  it("the wave splitter gives the throwing call its OWN wave (it runs alone)", () => {
    // The production seam the scheduler uses: the resolver answers the
    // per-call question, the partitioner turns the answer into waves. A call
    // whose validator threw is a wave breaker — it never shares a wave with
    // its neighbours.
    const waves = partitionConcurrencyWaves(
      [
        { id: "throwing", command: h.throwing },
        { id: "sibling", command: h.sibling },
      ],
      (item) => isConcurrencySafeForCall(BASH_META, { command: item.command })
    );

    assert.equal(waves.length, 2);
    assert.deepEqual(
      waves.map((wave) => wave.length),
      [1, 1]
    );
    assert.equal(waves[0]?.[0]?.id, "throwing");
  });
});
