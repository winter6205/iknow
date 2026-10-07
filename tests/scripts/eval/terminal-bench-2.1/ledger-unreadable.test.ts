/**
 * An UNREADABLE ledger must never read as an empty one.
 *
 * Why this matters (issue 1220): `readLedger` caught every errno and returned `{rows: [],
 * tornLines: 0}`. `ENOENT` — a ledger that legitimately does not exist yet — is the only
 * errno that means "no attempts so far". `EACCES` / `EISDIR` / `EIO` mean the opposite: the
 * run's own lifecycle record could not be read, so nothing is known about spend.
 *
 * The empty-result lie then travelled the whole chain: `aggregateSpend([])` is vacuously
 * `usageComplete`, `ceilingVerdict` took the PERMIT branch, and `wireDeps`'s budget gate
 * cleared to spend real money against a budget the run cannot account for. That inverts
 * issue 1220's stated contract — unknown usage reported as unknown and blocking dispatch.
 *
 * Every case below uses a REAL filesystem fault (a directory at the ledger path, a
 * `chmod 000` file), not a mock, because the property under test is the errno the OS
 * returns.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

import { readLedger } from "../../../../scripts/eval/terminal-bench-2.1/ledger.ts";
import type { LedgerRow } from "../../../../scripts/eval/terminal-bench-2.1/ledger.ts";
import {
  ceilingVerdict,
  spendForLedger,
  type TokenCeiling,
} from "../../../../scripts/eval/terminal-bench-2.1/accounting.ts";
import {
  driverSlotsOf,
  type ConfigParams,
  type ManifestSlot,
} from "../../../../scripts/eval/terminal-bench-2.1/config.ts";
import {
  runSlots,
  wireDeps,
  type DriverWiring,
} from "../../../../scripts/eval/terminal-bench-2.1/cli.ts";
import { buildReport } from "../../../../scripts/eval/terminal-bench-2.1/report.ts";
import type { RunnerPort } from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";
import { cleanupTempRoots, identityFor, tempRoot } from "./fixtures.ts";

afterAll(cleanupTempRoots);

const CEILING: TokenCeiling = {
  inputTokens: 4_000_000,
  outputTokens: 3_000_000,
};

function completedLedgerRow(attemptId: string): LedgerRow {
  return {
    attemptId,
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
}

function params(root: string): ConfigParams {
  return {
    datasetRoot: join(root, "dataset"),
    bundlePath: join(root, "bundle.tgz"),
    nodeArchivePath: join(root, "node.tar.gz"),
    settingsPath: join(root, "settings.json"),
    runRoot: join(root, "runs"),
    agentWallSec: 2700,
    graderGraceSec: 600,
    bundleGlibcxxFloor: "GLIBCXX_3.4.31",
    tokenCeiling: { input: 4_000_000, output: 3_000_000 },
  };
}

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

/** A runner that records every model dispatch, so "was anything spent" is observable. */
function recordingRunner(dispatched: string[]): RunnerPort {
  return {
    version: "fake/1",
    provision: async () => ({
      exitCode: 0,
      bootVerified: true,
      logsMountWritable: true,
      glibcxxMeasured: "GLIBCXX_3.4.31",
      stdout: "",
    }),
    dispatch: async () => {
      dispatched.push("dispatch");
      return { exitCode: 0, model: "m", stopReason: "done" };
    },
    grade: async () => ({
      exitCode: 0,
      reward: "1",
      ctrfBytes: 2878,
      resultLine: "7 passed",
      networkFailureMarker: false,
    }),
    gradeOracle: async () => ({
      exitCode: 0,
      reward: "1",
      ctrfBytes: 2878,
      resultLine: "7 passed",
      networkFailureMarker: false,
      oracle: {
        state: "applied",
        solvePath: "<taskDir>/solution/solve.sh",
        exitCode: 0,
        stdout: "oracle_exit=0",
      },
    }),
    reap: async () => undefined,
  };
}

function wiringFor(root: string, ledgerPath: string): DriverWiring {
  return {
    config: {
      manifest: manifest(),
      identityFor: (slot: ManifestSlot) => identityFor({ task: slot.task }),
    },
    runner: recordingRunner([]),
    ledgerPath,
    params: params(root),
  };
}

describe("readLedger distinguishes an absent ledger from an unreadable one", () => {
  it("marks a directory at the ledger path as unreadable, with its errno", () => {
    const root = tempLedger("eisdir");
    const ledgerPath = join(root, "ledger.jsonl");
    mkdirSync(ledgerPath, { recursive: true });

    const result = readLedger(ledgerPath);

    assert.equal(
      result.kind,
      "unreadable",
      "a ledger path that is a directory is unreadable, not an empty ledger"
    );
    assert.equal(
      result.unreadable?.errno,
      "EISDIR",
      `expected EISDIR to travel on the marker; got: ${JSON.stringify(result)}`
    );
    assert.equal(
      result.unreadable?.path,
      ledgerPath,
      "the marker must name the file it could not read"
    );
  });

  it("marks a ledger the process cannot read (EACCES) as unreadable", () => {
    const root = tempLedger("eacces");
    const ledgerPath = join(root, "ledger.jsonl");
    writeFileSync(ledgerPath, "{}\n");
    chmodSync(ledgerPath, 0o000);

    const result = readLedger(ledgerPath);

    chmodSync(ledgerPath, 0o600);
    assert.equal(
      result.kind,
      "unreadable",
      "an unreadable ledger is not an empty ledger"
    );
    assert.equal(
      result.unreadable?.errno,
      "EACCES",
      `expected EACCES to travel on the marker; got: ${JSON.stringify(result)}`
    );
  });

  it("still reads an ABSENT ledger as a genuinely empty, readable one", () => {
    const root = tempLedger("enoent");

    const result = readLedger(join(root, "never-written.jsonl"));

    assert.equal(
      result.kind,
      "readable",
      "ENOENT means no attempts so far, which is the pre-existing empty case"
    );
    assert.deepEqual(result.rows, [], "an absent ledger has no rows");
    assert.equal(result.tornLines, 0, "an absent ledger has no torn line");
    assert.equal(
      result.unreadable,
      null,
      "an absent ledger is not an unreadable one"
    );
  });
});

describe("an unreadable ledger is unknown usage, through the one existing channel", () => {
  it("is never a known zero", () => {
    const root = tempLedger("spend");
    const ledgerPath = join(root, "ledger.jsonl");
    mkdirSync(ledgerPath, { recursive: true });

    const spend = spendForLedger(readLedger(ledgerPath));

    assert.equal(
      spend.usageComplete,
      false,
      "usage nobody can read is unknown, never vacuously complete"
    );
    assert.equal(
      spend.ledgerUnreadable?.errno,
      "EISDIR",
      `the halt must be attributable to the unreadable ledger; got: ${JSON.stringify(spend)}`
    );
    assert.deepEqual(
      spend.unknownUsageAttempts,
      [],
      "no attempt id exists: the ledger itself was unreadable"
    );
  });

  it("halts the ceiling instead of permitting dispatch", () => {
    const root = tempLedger("ceiling");
    const ledgerPath = join(root, "ledger.jsonl");
    mkdirSync(ledgerPath, { recursive: true });

    const verdict = ceilingVerdict(
      spendForLedger(readLedger(ledgerPath)),
      CEILING
    );

    assert.equal(
      verdict.mayDispatch,
      false,
      "an unreadable ledger must never clear a real budget"
    );
    assert.equal(verdict.reached, true, "unknown usage halts the run");
    assert.match(
      verdict.reason,
      /unreadable/,
      `the halt must name the cause; got: ${JSON.stringify(verdict.reason)}`
    );
  });

  it("still permits dispatch for a genuinely absent ledger", () => {
    const root = tempLedger("absent-ceiling");

    const verdict = ceilingVerdict(
      spendForLedger(readLedger(join(root, "never-written.jsonl"))),
      CEILING
    );

    assert.equal(
      verdict.mayDispatch,
      true,
      "an absent ledger is the pre-existing empty-budget case, unchanged"
    );
  });
});

describe("the wired driver refuses to spend against an unreadable ledger", () => {
  it("mayDispatchMore is false when the ledger cannot be read", () => {
    const root = tempLedger("wired-budget");
    const ledgerPath = join(root, "ledger.jsonl");
    mkdirSync(ledgerPath, { recursive: true });
    const deps = wireDeps(wiringFor(root, ledgerPath));

    assert.equal(
      deps.mayDispatchMore(),
      false,
      "the budget gate must refuse when usage is unknown"
    );
    assert.match(
      deps.budgetReason(),
      /unreadable/,
      `the reason shown to the operator must name the cause; got: ${deps.budgetReason()}`
    );
  });

  it("blocks dispatch when a valid ledger prefix is followed by a torn JSONL row", () => {
    const root = tempLedger("wired-torn-row");
    const ledgerPath = join(root, "ledger.jsonl");
    const completed = completedLedgerRow("known-prefix");
    writeFileSync(
      ledgerPath,
      `${JSON.stringify(completed)}\n{"attemptId":"interrupted"`,
      "utf8"
    );
    const deps = wireDeps(wiringFor(root, ledgerPath));

    assert.equal(
      deps.mayDispatchMore(),
      false,
      "a valid prefix cannot make usage complete when a later JSONL row is torn"
    );
    assert.match(
      deps.budgetReason(),
      /unknown|torn|incomplete/i,
      `the refusal must explain that ledger usage is incomplete; got: ${deps.budgetReason()}`
    );
  });

  it("blocks dispatch when a valid prefix is followed by a malformed complete line", () => {
    const root = tempLedger("wired-malformed-row");
    const ledgerPath = join(root, "ledger.jsonl");
    writeFileSync(
      ledgerPath,
      `${JSON.stringify(completedLedgerRow("known-prefix"))}\nnot-json\n`,
      "utf8"
    );
    const deps = wireDeps(wiringFor(root, ledgerPath));

    assert.equal(
      deps.mayDispatchMore(),
      false,
      "a malformed complete row cannot be skipped while declaring usage complete"
    );
    assert.match(deps.budgetReason(), /unknown|torn|incomplete/i);
  });

  it.each([
    ["a malformed complete line", "not-json\n"],
    ["a partial final line", '{"attemptId":"interrupted"'],
  ])("preserves known prefix spend but blocks on %s", (_label, suffix) => {
    const root = tempLedger("torn-usage");
    const ledgerPath = join(root, "ledger.jsonl");
    writeFileSync(
      ledgerPath,
      `${JSON.stringify(completedLedgerRow("known-prefix"))}\n${suffix}`,
      "utf8"
    );

    const spend = spendForLedger(readLedger(ledgerPath));

    assert.equal(spend.inputTokens, 11, "known input spend stays visible");
    assert.equal(spend.outputTokens, 7, "known output spend stays visible");
    assert.equal(
      spend.totalTokens,
      26,
      "the measurable prefix subtotal is preserved for diagnosis"
    );
    assert.equal(
      spend.usageComplete,
      false,
      "one malformed row makes total usage unknown even when the prefix is valid"
    );
    assert.equal(
      ceilingVerdict(spend, CEILING).mayDispatch,
      false,
      "a partial subtotal cannot authorize another attempt"
    );
  });

  it("recovers a trailing partial row after its append completes", () => {
    const root = tempLedger("partial-recovery");
    const ledgerPath = join(root, "ledger.jsonl");
    const serialized = JSON.stringify(completedLedgerRow("completed-append"));
    const split = Math.floor(serialized.length / 2);
    writeFileSync(ledgerPath, serialized.slice(0, split), "utf8");

    const incomplete = spendForLedger(readLedger(ledgerPath));

    assert.equal(
      incomplete.usageComplete,
      false,
      "an unfinished append must be unknown until its remaining bytes arrive"
    );

    appendFileSync(ledgerPath, `${serialized.slice(split)}\n`, "utf8");
    const recovered = spendForLedger(readLedger(ledgerPath));

    assert.equal(recovered.usageComplete, true);
    assert.equal(recovered.totalTokens, 26);
    assert.equal(
      ceilingVerdict(recovered, CEILING).mayDispatch,
      true,
      "a complete, valid ledger remains eligible for dispatch"
    );
  });

  it("stops the run before any model dispatch", async () => {
    const root = tempLedger("wired-run");
    const ledgerPath = join(root, "ledger.jsonl");
    mkdirSync(ledgerPath, { recursive: true });
    // Real instrument bytes with real shas, so a run that wrongly reaches `dispatchFor`
    // fails on THIS assertion instead of on an unrelated missing-file throw.
    const bundlePath = join(root, "bundle.tgz");
    const nodeArchivePath = join(root, "node.tar.gz");
    writeFileSync(bundlePath, "fake bundle bytes");
    writeFileSync(nodeArchivePath, "fake node archive bytes");
    writeFileSync(join(root, "settings.json"), "{}\n");
    const dispatched: string[] = [];
    const wiring: DriverWiring = {
      ...wiringFor(root, ledgerPath),
      runner: recordingRunner(dispatched),
      config: {
        manifest: manifest(),
        identityFor: (slot: ManifestSlot) =>
          identityFor({
            task: slot.task,
            bundleSha256: sha256Of(bundlePath),
            nodeArchiveSha256: sha256Of(nodeArchivePath),
          }),
      },
    };

    const exit = await runSlots(wiring);

    assert.deepEqual(
      exit.dispatched,
      [],
      "no attempt may be dispatched against an unreadable ledger"
    );
    assert.equal(
      dispatched.length,
      0,
      "the runner must never be asked to dispatch"
    );
    assert.equal(
      exit.stopReason,
      "ceiling",
      "the run stops at the budget gate"
    );
    assert.equal(exit.code, 1, "a halted run is not a completed run");
  });
});

describe("the report of an unreadable-ledger run is not usable", () => {
  it("never reports a clean verdict from a ledger nobody could read", () => {
    const root = tempLedger("report");
    const runRoot = join(root, "runs");
    const ledgerPath = join(root, "ledger.jsonl");
    mkdirSync(ledgerPath, { recursive: true });
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
      report.checks.usable,
      false,
      "a run whose ledger was unreadable must not be usable"
    );
    assert.equal(
      report.checks.verdict,
      "not-usable",
      "the verdict must not read as usable"
    );
    assert.ok(
      report.checks.failedCheckIds.includes("run-measured"),
      `nothing measurable was read, so the run must fail the floor check; got: ${JSON.stringify(
        report.checks.failedCheckIds
      )}`
    );
    // NOTE: `report.ceiling` is re-derived inside report.ts (`aggregateSpend(rows)`, not
    // `spendForLedger`), which this change does not own, so its `mayDispatch` still reads
    // `true` for an unreadable ledger. The dispatch BLOCK is enforced at the driver seam
    // above (`mayDispatchMore()`), which is where a real run can spend. Closing the
    // artifact's copy is the same one-line swap in report.ts and is deliberately NOT
    // asserted here as if it were already true.
  });
});

function tempLedger(basename: string): string {
  return tempRoot(`ledger-unreadable-${basename}`);
}

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
