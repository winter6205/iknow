/**
 * The report of an unreadable-ledger run must not say "you may spend".
 *
 * Why this file exists: the sibling fix for issue 1220 made an unreadable ledger a TYPED state
 * (`LedgerReadResult` discriminated on `kind`), routed the driver's budget gate through
 * `spendForLedger(readLedger(...))`, and asserted there that no attempt is dispatched. But
 * `report.ts` re-derived its own spend from the RAW ROWS with `aggregateSpend(ledger.rows)`, and
 * an unreadable ledger carries `rows: []`. `aggregateSpend([])` is vacuously `usageComplete`, so
 * `ceilingVerdict` took the PERMIT branch and the retained artifact published
 * `ceiling.mayDispatch === true` for a run whose spend is unknown.
 *
 * The consequence is that the artifact contradicts the driver's own decision in the same run: the
 * driver refuses to dispatch, and the evidence file an operator reads afterwards says dispatch
 * is permitted. That is exactly the inversion issue 1220 forbids — unknown usage laundered into
 * a confident zero.
 *
 * So this file asserts the ARTIFACT, through the real `buildReport`, against a REAL filesystem
 * fault (a directory at the ledger path, so the OS really returns `EISDIR`) rather than a stubbed
 * read. The property under test is the errno the filesystem returns, so it must be real.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

import { buildReport } from "../../../../scripts/eval/terminal-bench-2.1/report.ts";
import {
  driverSlotsOf,
  type ManifestSlot,
} from "../../../../scripts/eval/terminal-bench-2.1/config.ts";
import type { TokenCeiling } from "../../../../scripts/eval/terminal-bench-2.1/accounting.ts";
import { identityFor, tempRoot, cleanupTempRoots } from "./fixtures.ts";

afterAll(cleanupTempRoots);

/** A claimed ceiling far above any plausible spend, so only USAGE KNOWLEDGE can stop dispatch. */
const CEILING: TokenCeiling = {
  inputTokens: 4_000_000,
  outputTokens: 3_000_000,
};

function manifest() {
  return {
    runId: "run-1220",
    datasetCommit: "7131e437",
    bundleSha256: "bundle-sha",
    nodeArchiveSha256: "node-sha",
    runnerVersion: "tb2.1-attempt/1",
    outputLayout: "trace/ logs/ process/ meta/",
    frozenBeforeAnyOutcome: true,
    slots: [
      {
        task: "db-wal-recovery",
        image: "python:3.11-slim",
        imageDigest: "sha256:aaa111",
        maxTurns: 40,
        arm: "arm40",
      },
    ],
  } as unknown as Parameters<typeof driverSlotsOf>[0];
}

/**
 * A run whose ledger path is a DIRECTORY: the real `EISDIR` fault, so `readLedger` takes its
 * unreadable arm for a genuine reason and not because a test asked it to.
 */
function unreadableLedgerReport() {
  const root = tempRoot("report-ceiling-unreadable");
  const runRoot = join(root, "runs");
  const ledgerPath = join(root, "ledger.jsonl");
  mkdirSync(ledgerPath, { recursive: true });
  mkdirSync(runRoot, { recursive: true });
  return buildReport({
    mode: "run",
    ledgerPath,
    runRoot,
    manifest: manifest(),
    identityFor: (slot: ManifestSlot) => identityFor({ task: slot.task }),
    ceiling: CEILING,
    exit: {
      code: 1,
      stopReason: "ceiling",
      stoppedAt: "db-wal-recovery:arm40:40",
      dispatched: [],
      excluded: [],
    },
  });
}

describe("the artifact agrees with the driver about an unreadable ledger", () => {
  it("blocks further dispatch instead of permitting it", () => {
    const report = unreadableLedgerReport();

    assert.equal(
      report.ceiling.mayDispatch,
      false,
      "the driver refused to dispatch against this ledger, so the report it retains must not " +
        "tell an operator they may; report.ts derived spend from the raw rows instead of " +
        `spendForLedger(readLedger(...)): ${report.ceiling.reason}`
    );
    assert.equal(
      report.ceiling.reached,
      true,
      "unknown usage is not evidence that the budget is intact, so the ceiling reads reached"
    );
  });

  it("reports unknown spend and blocks dispatch when a valid prefix ends in a partial row", () => {
    const root = tempRoot("report-ceiling-partial-ledger");
    const runRoot = join(root, "runs");
    const ledgerPath = join(root, "ledger.jsonl");
    const knownPrefix = {
      attemptId: "known-prefix",
      slotKey: "db-wal-recovery:arm40:40",
      task: "db-wal-recovery",
      arm: "arm40",
      maxTurns: 40,
      phase: "completed",
      recordedAtEpochMs: 1_700_000_000_000,
      attemptStarted: true,
      modelDispatched: true,
      excluded: false,
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 5,
      },
      reason: "",
    };
    writeFileSync(
      ledgerPath,
      `${JSON.stringify(knownPrefix)}\n{"attemptId":"interrupted"`,
      "utf8"
    );
    mkdirSync(runRoot, { recursive: true });

    const report = buildReport({
      mode: "run",
      ledgerPath,
      runRoot,
      manifest: manifest(),
      identityFor: (slot: ManifestSlot) => identityFor({ task: slot.task }),
      ceiling: CEILING,
      exit: {
        code: 1,
        stopReason: "ceiling",
        stoppedAt: "db-wal-recovery:arm40:40",
        dispatched: [],
        excluded: [],
      },
    });

    assert.equal(
      report.spend.usage,
      "unknown",
      "a partial JSONL row leaves total ledger usage unknown"
    );
    assert.equal(report.spend.totalTokens, null);
    assert.equal(
      report.spend.observed.inputTokens,
      11,
      "the report retains the known subtotal without presenting it as total spend"
    );
    assert.equal(report.spend.usageComplete, false);
    assert.equal(
      report.ceiling.mayDispatch,
      false,
      "a known prefix cannot permit dispatch while a ledger row is incomplete"
    );
    assert.equal(report.tornLines, 1);
  });

  it("reports the spend as unknown, never as a known zero", () => {
    const report = unreadableLedgerReport();

    assert.equal(
      report.spend.usage,
      "unknown",
      "`aggregateSpend([])` is vacuously complete, which is how an unreadable ledger reads as " +
        "'known, 0 tokens' and clears the budget for real money"
    );
    assert.equal(
      report.spend.totalTokens,
      null,
      "a zero here would be a fabricated measurement; nothing was measured"
    );
    assert.equal(
      report.spend.usageComplete,
      false,
      "the same unknown-usage channel the driver gates on, not a second concept"
    );
  });

  it("carries the unreadable-ledger marker so a reader knows WHY it is unknown", () => {
    const report = unreadableLedgerReport();

    const unreadable = report.spend.observed.ledgerUnreadable;
    assert.ok(
      unreadable !== null && unreadable !== undefined,
      "the report must retain the reason the ledger could not be read; got: " +
        JSON.stringify(unreadable)
    );
    assert.equal(
      unreadable.errno,
      "EISDIR",
      `the marker must name the real errno the filesystem returned; got: ${JSON.stringify(unreadable)}`
    );
  });

  it("still reports the run as not usable", () => {
    const report = unreadableLedgerReport();

    assert.equal(
      report.checks.usable,
      false,
      "a run whose ledger was unreadable must not be usable"
    );
  });

  it("publishes torn lines as unknown, never as a clean zero", () => {
    // The same fabrication, one field over: `tornLines: 0` reads as "the file was parsed and
    // held no torn line", when in fact nobody parsed it. A reader scanning the artifact for
    // evidence of a mid-append kill is told the opposite of the truth.
    const report = unreadableLedgerReport();

    assert.equal(
      report.tornLines,
      null,
      `torn lines must be null when the ledger was never read, not 0; got: ${JSON.stringify(report.tornLines)}`
    );
  });

  it("refuses to call the stop clean while torn-ness is unknown", () => {
    // `clean-stop` passed on `tornLedgerLines === 0`. With the ledger unreadable that zero was
    // invented, so the check must be red: an unknown is not evidence of a clean stop.
    const report = unreadableLedgerReport();
    const cleanStop = report.checks.checks.find((c) => c.id === "clean-stop");

    assert.ok(
      cleanStop !== undefined,
      "clean-stop must be present in the checks report"
    );
    assert.equal(
      cleanStop.ok,
      false,
      `clean-stop must not pass on an invented torn-line count; detail: ${cleanStop.detail}`
    );
  });
});
