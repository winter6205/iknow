/**
 * Real-PTY fixture for the #1219 calibration driver.
 *
 * WHY this file exists: the pure tests prove the decision rules, but the claims
 * that matter most are about a LIVE terminal — that readiness can be proven
 * without submitting, that acceptance can only come from persisted events even
 * though the screen produces kilobytes of redraw per second, that a clean
 * `/quit` is distinguishable from a forced termination, and that nothing the run
 * started survives teardown. A mocked session proves none of that, and the
 * product itself cannot be driven here (it would need model calls and
 * credentials), so a deterministic child under a REAL pty carries the surface.
 *
 * Mechanism: `scripts/eval/tui/pty-relay.py` does `pty.fork()` and spawns
 * `tests/scripts/eval/tui/fixture-tui-child.ts` under `node --import tsx`. The
 * child sets the terminal to raw mode, redraws continuously, echoes its composer,
 * persists accepted rounds into a real session-store JSONL built with the
 * production serializer, refuses input while a round runs, and exits 0 on
 * `/quit`.
 */
import { afterAll, afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseProtocol } from "../../../../scripts/eval/tui/protocol.ts";
import type { Verdict } from "../../../../scripts/eval/tui/acceptance.ts";
import {
  disposeAllPtySessions,
  isProcessAlive,
  openPty,
  probeReadiness,
} from "../../../../scripts/eval/tui/pty.ts";
import { runTuiCalibration } from "../../../../scripts/eval/tui/run.ts";
import {
  listSessionFiles,
  sessionFilePath,
  validateWholeFile,
} from "../../../../scripts/eval/tui/session-store-reader.ts";
import { initStore, appendRaw } from "./fixture.ts";

const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const CHILD = fileURLToPath(new URL("./fixture-tui-child.ts", import.meta.url));

const roots: string[] = [];

interface Harness {
  readonly dataDir: string;
  readonly cwd: string;
  readonly artifactsDir: string;
  readonly conversationId: string;
  readonly storePath: string;
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "iknow-tui-pty-"));
  roots.push(root);
  const conversationId = "conv-pty-fixture";
  const cwd = join(root, "repo");
  const dataDir = join(root, "data");
  // The child runs with cwd as its identity root, so the directory must exist
  // before the spawn: a missing cwd surfaces as a bare ENOENT.
  mkdirSync(cwd, { recursive: true });
  return {
    dataDir,
    cwd,
    artifactsDir: join(root, "artifacts"),
    conversationId,
    storePath: sessionFilePath({ dataDir, cwd, conversationId }),
  };
}

function childArgs(
  h: Harness,
  over: Record<string, string | number> = {}
): string[] {
  return [
    "--import",
    tsxLoader,
    CHILD,
    "--data-dir",
    h.dataDir,
    "--cwd",
    h.cwd,
    "--conversation",
    h.conversationId,
    "--redraw-ms",
    "40",
    ...Object.entries(over).flatMap(([k, v]) => [`--${k}`, String(v)]),
  ];
}

function protocol(h: Harness, over: Record<string, unknown> = {}) {
  return parseProtocol({
    label: "pty-fixture",
    dataDir: h.dataDir,
    cwd: h.cwd,
    artifactsDir: h.artifactsDir,
    conversationId: h.conversationId,
    child: {
      command: process.execPath,
      args: childArgs(h, { "accept-delay-ms": 120, "round-ms": 150 }),
    },
    stimuli: [
      { at: 300, tag: "S1", text: "FIRST-STIMULUS-TEXT" },
      { at: 800, tag: "S2", text: "SECOND-STIMULUS-TEXT" },
    ],
    readiness: {
      tokenPrefix: "iknow-ready",
      probeTimeoutMs: 4000,
      echoTimeoutMs: 1500,
      attempts: 3,
    },
    delivery: {
      chunkBytes: 8,
      chunkDelayMs: 5,
      settleBeforeSubmit: true,
      settleWaitMs: 4000,
      acceptTimeoutMs: 8000,
      retryEnter: false,
    },
    stop: {
      minSettleMs: 100,
      horizonMs: 200,
      exitGraceMs: 4000,
      innerWallMs: 30000,
    },
    outerWatchdogMs: 60000,
    rssIntervalMs: 100,
    snapshotIntervalMs: 250,
    ...over,
  });
}

/**
 * Leave behind exactly what an EARLIER run into the same artifacts directory
 * leaves: its own run directory holding `counters.json` with its own role.
 */
function seedSiblingCounters(
  h: Harness,
  label: string,
  runKind: "measured" | "resume" | "smoke"
): void {
  const runDir = join(h.artifactsDir, label);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "counters.json"),
    JSON.stringify({
      runKind,
      runDir,
      window: {
        startedIso: "2026-10-06T20:00:00.000Z",
        endedIso: "2026-10-06T20:10:00.000Z",
      },
      rss: {
        rows: 12,
        uniqueTrel: 12,
        duplicateRows: 0,
        nonMonotonic: false,
        firstTrelS: 0.1,
        lastTrelS: 1.2,
        peakVmrssKb: 190000,
      },
      snapshots: 3,
      acceptedStimuli: 1,
      settledStimuli: 1,
      storeRecords: 4,
      storeCensus: { message: 2, head: 2 },
    }),
    "utf8"
  );
}

afterEach(async () => {
  await disposeAllPtySessions();
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("probeReadiness — a non-submitting readiness probe", () => {
  it("proves readiness by echo + clear and never writes an Enter", async () => {
    const h = makeHarness();
    const session = await openPty({
      command: process.execPath,
      args: childArgs(h),
      cwd: h.cwd,
    });
    const verdict = await probeReadiness(session, {
      tokenPrefix: "iknow-ready",
      probeTimeoutMs: 4000,
      echoTimeoutMs: 1500,
      attempts: 3,
    });

    assert.equal(
      verdict.echoed,
      true,
      `the composer must visibly echo the token; evidence: ${verdict.evidence}`
    );
    assert.equal(
      verdict.cleared,
      true,
      `the token must be gone after the composer clear; evidence: ${verdict.evidence}`
    );
    assert.equal(
      verdict.enterWrites,
      0,
      `a readiness probe must never submit; got: ${JSON.stringify(session.writes)}`
    );
    assert.equal(verdict.ready, true, verdict.detail);

    const stored = existsSync(h.storePath)
      ? readFileSync(h.storePath, "utf8")
      : "";
    assert.ok(
      !stored.includes(verdict.token),
      "the probe token must not have been persisted as a user message"
    );
    await session.dispose();
  });

  it("sees a surface that never goes quiet, so silence can never be read as idle", async () => {
    const h = makeHarness();
    const session = await openPty({
      command: process.execPath,
      args: childArgs(h),
      cwd: h.cwd,
    });

    // Wait for the first frame: tsx startup dominates the first few hundred ms.
    const deadline = Date.now() + 10_000;
    while (session.totalBytes === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(
      session.totalBytes > 0,
      "the fixture child must render a first frame"
    );
    const before = session.totalBytes;
    await new Promise((r) => setTimeout(r, 600));
    const idleBytes = session.totalBytes - before;
    const afterProbe = session.totalBytes;
    await probeReadiness(session, {
      tokenPrefix: "iknow-ready",
      probeTimeoutMs: 4000,
      echoTimeoutMs: 1500,
      attempts: 2,
    });
    const probeBytes = session.totalBytes - afterProbe;

    assert.ok(
      idleBytes > 1000,
      `an idle screen must still be producing frames; got ${idleBytes} bytes in 600ms`
    );
    assert.ok(
      probeBytes > idleBytes,
      `the probe window must be busier than idle alone, never silent; got ${probeBytes}`
    );
    await session.dispose();
  });

  it("fails loudly (not silently) when the surface never echoes the token", async () => {
    const h = makeHarness();
    // `sh -c 'stty raw -echo; sleep 30'` is a real terminal with ECHO OFF, so
    // nothing it receives can appear on screen. A surface that never echoes must
    // be reported as not ready, never papered over.
    const session = await openPty({
      command: "sh",
      args: ["-c", "stty raw -echo; sleep 30"],
      cwd: h.cwd,
    });
    const verdict = await probeReadiness(session, {
      tokenPrefix: "iknow-ready",
      probeTimeoutMs: 120,
      echoTimeoutMs: 120,
      attempts: 1,
    });

    assert.equal(
      verdict.echoed,
      false,
      `expected no echo; evidence: ${verdict.evidence}`
    );
    assert.equal(verdict.ready, false);
    assert.equal(verdict.enterWrites, 0);
    await session.dispose();
  });
});

describe("runTuiCalibration — the measured sequence on a live terminal", () => {
  it("verifies first input AND follow-up from persisted events, then quits cleanly", async () => {
    const h = makeHarness();
    const result = await runTuiCalibration(protocol(h));

    assert.deepEqual(
      result.report.blockedBy,
      [],
      `an unqualified pass must block nothing; report: ${JSON.stringify(result.report)}`
    );
    assert.equal(result.report.verdict, "usable");
    assert.equal(result.readiness.ready, true, result.readiness.detail);
    assert.deepEqual(
      result.acceptance.map((r) => [r.tag, r.verdict]),
      [
        ["S1", "accepted"],
        ["S2", "accepted"],
      ],
      `every stimulus needs a persisted acceptance; got: ${JSON.stringify(result.acceptance)}`
    );
    for (const record of result.acceptance) {
      assert.ok(
        record.accepted_at_ms !== null &&
          record.settled_at_ms !== null &&
          record.accepted_at_ms < record.settled_at_ms,
        `acceptance is DELAYED and precedes settlement, so the two are distinct observations: ${JSON.stringify(record)}`
      );
      assert.ok(
        record.accepted_event_id !== null,
        `acceptance must cite an event id: ${JSON.stringify(record)}`
      );
      assert.ok(
        record.input_anchor !== null,
        `acceptance must be corroborated by a boundary:input anchor: ${JSON.stringify(record)}`
      );
      assert.ok(
        record.settled_anchor !== null,
        `settlement must cite a terminal anchor: ${JSON.stringify(record)}`
      );
      assert.ok(
        record.due_at_ms !== record.sent_at_ms,
        `due / sent must be recorded separately: ${JSON.stringify(record)}`
      );
    }

    assert.equal(result.stop.cause, "clean_quit");
    assert.equal(result.stop.natural, true, result.stop.reason);
    assert.equal(
      result.exitStatus?.code,
      0,
      `expected exit 0; got: ${JSON.stringify(result.exitStatus)}`
    );
    assert.deepEqual(
      result.strayProcesses,
      [],
      "no process may survive teardown"
    );
    assert.deepEqual(result.report.blockedBy, []);
    // This harness has NO sibling run on disk. Nothing was pooled, so the gate
    // may pass — but it compared nothing, and a fixed "samples were kept
    // separate" diagnostic would claim a verification that never happened.
    const pooling = result.report.checks.find(
      (c) => c.id === "evidence.no_pooling"
    );
    assert.equal(pooling?.ok, true, JSON.stringify(pooling));
    assert.ok(
      (pooling?.detail ?? "").includes("no other run's counters were present"),
      `with no sibling on disk the check must say so; got: ${pooling?.detail}`
    );
  });

  it("separates a sibling resume run instead of comparing the run against itself", async () => {
    const h = makeHarness();
    seedSiblingCounters(h, "resume1", "resume");

    const result = await runTuiCalibration(protocol(h));

    assert.deepEqual(
      result.otherRuns.map((c) => c.runKind),
      ["resume"],
      `the sibling run on disk must be READ; passing only this run's own counters made the pooling clause vacuous. got: ${JSON.stringify(result.otherRuns)}`
    );
    const pooling = result.report.checks.find(
      (c) => c.id === "evidence.no_pooling"
    );
    assert.equal(
      pooling?.ok,
      true,
      `a resume sibling is kept separate, not pooled; got: ${JSON.stringify(pooling)}`
    );
  });

  it("blocks the verdict when a SIBLING run claims the measured role", async () => {
    const h = makeHarness();
    seedSiblingCounters(h, "measured-again", "measured");

    const result = await runTuiCalibration(protocol(h));

    // A second measured run means the measured slot is contested, which is
    // exactly the pooling the gate exists to catch — and with only this run's
    // own counters in the set, the clause was true whatever the disk held.
    const pooling = result.report.checks.find(
      (c) => c.id === "evidence.no_pooling"
    );
    assert.equal(
      pooling?.ok,
      false,
      `a second measured run must fail the pooling gate; got: ${JSON.stringify(pooling)}`
    );
    assert.ok(
      result.report.blockedBy.includes("evidence.no_pooling"),
      `the pooling gate must block the verdict; got: ${JSON.stringify(result.report.blockedBy)}`
    );
    assert.deepEqual(
      result.otherRuns.map((c) => c.runKind),
      ["measured"],
      `the contested sibling must be visible in the result; got: ${JSON.stringify(result.otherRuns)}`
    );
  });

  it("derives every counter from the retained artifacts and keeps output volume out of it", async () => {
    const h = makeHarness();
    // Pre-seeded so the baseline offset is a real position in the file: without
    // it the counters would (correctly) include the conversation's own seed turn.
    initStore(
      { dataDir: h.dataDir, cwd: h.cwd, conversationId: h.conversationId },
      "earlier turn"
    );
    const result = await runTuiCalibration(protocol(h));

    assert.equal(
      result.counters?.acceptedStimuli,
      2,
      "two accepted stimuli, derived from the retained store copy"
    );
    assert.equal(
      result.counters?.storeCensus.message,
      5,
      "the seeded turn, the two accepted stimuli and their two replies"
    );
    assert.equal(result.counters?.settledStimuli, 2);
    assert.equal(
      result.counters?.storeCensus.native_state,
      4,
      "two input + two terminal boundaries"
    );
    assert.equal(
      result.counters?.storeCensus.head,
      5,
      "one trailing head per message"
    );
    assert.equal(
      result.counters?.storeCensus.outcome,
      2,
      "one outcome per settled turn"
    );
    assert.ok(
      (result.counters?.rss.rows ?? 0) > 0,
      "the RSS sample file must exist and be counted from its rows"
    );
    assert.equal(
      result.index.ok,
      true,
      `the payload index must verify: ${JSON.stringify(result.index.mismatches)}`
    );

    // The screen produced far more bytes than the two messages; acceptance still
    // cites two persisted events, never a byte count.
    const snapshots = readFileSync(
      join(h.artifactsDir, "pty-fixture", "snapshots", "screen-001.txt"),
      "utf8"
    );
    assert.ok(snapshots.length > 0, "a retained screen snapshot must exist");
    assert.equal(
      result.acceptance.filter((r) => r.accepted_event_id !== null).length,
      2
    );
  });

  it("verifies a resume in the SAME conversation, without creating a new session file", async () => {
    const h = makeHarness();
    // A pre-existing conversation: the resume must extend it, not start a new one.
    initStore(
      { dataDir: h.dataDir, cwd: h.cwd, conversationId: h.conversationId },
      "earlier turn"
    );
    const before = listSessionFiles({
      dataDir: h.dataDir,
      cwd: h.cwd,
      conversationId: h.conversationId,
    });

    const result = await runTuiCalibration(
      protocol(h, {
        label: "pty-resume",
        runKind: "resume",
        stimuli: [{ at: 300, tag: "R1", text: "RESUME-STIMULUS-TEXT" }],
      })
    );

    assert.equal(
      result.acceptance[0]?.verdict,
      "accepted",
      JSON.stringify(result.acceptance)
    );
    assert.equal(
      result.acceptance[0]?.accepted_event_id,
      "e1",
      "the resume lands on the next event id of the SAME conversation"
    );
    assert.equal(result.acceptance[0]?.settled_anchor, "e2");
    assert.deepEqual(
      listSessionFiles({
        dataDir: h.dataDir,
        cwd: h.cwd,
        conversationId: h.conversationId,
      }),
      before,
      "a resume must not create another conversation file"
    );
    assert.equal(
      result.report.runKind,
      "resume",
      "a resume run declares its role instead of borrowing the measured slot"
    );
    assert.equal(
      result.runKind,
      "resume",
      `the result must carry the same role as the report and the counters; report: ${result.report.runKind}, counters: ${String(result.counters?.runKind)}`
    );
    assert.deepEqual(
      result.report.blockedBy,
      [],
      `report: ${JSON.stringify(result.report.blockedBy)}`
    );
  });

  it("halts on a recorded refusal instead of spinning to the inner wall", async () => {
    const h = makeHarness();
    // S2 becomes due while S1's round is still running, so the scheduler
    // refuses the stimulus it could not submit. That refusal is final — there
    // is no blind resend — so once S1 has settled nothing further can be
    // delivered or verified and the run must close, rather than keep polling on
    // a stimulus that can never be submitted until the inner wall expires.
    const result = await runTuiCalibration(
      protocol(h, {
        stimuli: [
          { at: 300, tag: "S1", text: "FIRST-STIMULUS-TEXT" },
          { at: 800, tag: "S2", text: "REFUSED-STIMULUS-TEXT" },
        ],
        delivery: {
          chunkBytes: 8,
          chunkDelayMs: 5,
          settleBeforeSubmit: true,
          settleWaitMs: 0,
          acceptTimeoutMs: 30000,
          retryEnter: false,
        },
        child: {
          command: process.execPath,
          // A round that settles far inside the inner wall, so the only thing
          // that can keep the run open afterwards is the refused stimulus.
          // The margin is deliberately wide: the wall must not be reachable
          // before the round settles even on a loaded machine.
          args: childArgs(h, {
            "accept-delay-ms": 200,
            "round-ms": 2500,
          }),
        },
        stop: {
          minSettleMs: 100,
          horizonMs: 200,
          exitGraceMs: 3000,
          innerWallMs: 30000,
        },
      })
    );

    const kinds = result.events.map((e) => e.kind);
    assert.equal(
      result.acceptance[1]?.verdict,
      "refused",
      `the refused stimulus must be recorded as refused; got: ${JSON.stringify(result.acceptance)}`
    );
    assert.equal(
      result.acceptance[1]?.sent_at_ms,
      null,
      "a refused stimulus was never submitted"
    );
    assert.ok(
      kinds.includes("sequence_halted"),
      `a refused stimulus leaves nothing to deliver or verify, so the run must halt; got: ${JSON.stringify(kinds)}`
    );
    assert.ok(
      !kinds.includes("wall_exhausted"),
      `the run must not spin to the inner wall once the refusal is recorded; got: ${JSON.stringify(kinds)}`
    );
    assert.deepEqual(
      result.strayProcesses,
      [],
      "a halting run must still reap everything it started"
    );
  });

  it("reports an observer error as its own failed check, never as clean", async () => {
    const h = makeHarness();
    const loc = {
      dataDir: h.dataDir,
      cwd: h.cwd,
      conversationId: h.conversationId,
    };
    initStore(loc, "earlier turn");
    // A malformed COMPLETE line followed by ANOTHER complete line: the
    // production parser drops only a TRAILING corrupt line, so this store is
    // genuinely malformed and the reader must report it rather than read past
    // it. That is the state a real mid-run corruption leaves behind.
    appendRaw(loc, '{"type":"head","id":"e0"');
    appendRaw(loc, JSON.stringify({ type: "head", id: "e0" }));

    const result = await runTuiCalibration(protocol(h));

    assert.ok(
      result.events.some((e) => e.kind === "observer_error"),
      `the run must journal the reader error; got: ${JSON.stringify(result.events.map((e) => e.kind))}`
    );
    const observer = result.report.checks.find(
      (c) => c.id === "observer.no_errors"
    );
    assert.equal(
      observer?.ok,
      false,
      `a store reader error must fail the observer gate; got: ${JSON.stringify(observer)}`
    );
    assert.equal(
      observer?.detail,
      "the store reader reported an observer error",
      `the gate's own NO diagnostic must be the one reachable; got: ${JSON.stringify(observer)}`
    );
    assert.ok(
      result.report.blockedBy.includes("observer.no_errors"),
      `the observer gate must block the verdict; got: ${JSON.stringify(result.report.blockedBy)}`
    );
    assert.equal(
      result.report.usable,
      false,
      "an observer error can never sit beside a usable verdict"
    );
  });

  it("stops before Enter when a real session-store fault appears after readiness", async () => {
    const h = makeHarness();
    const loc = {
      dataDir: h.dataDir,
      cwd: h.cwd,
      conversationId: h.conversationId,
    };
    let injectedFault = false;
    const result = await runTuiCalibration(
      protocol(h, {
        stimuli: [{ at: 0, tag: "S1", text: "NO-ENTER-AFTER-OBSERVER-FAULT" }],
      }),
      {
        log: (line) => {
          if (!injectedFault && line.startsWith("readiness:")) {
            injectedFault = true;
            // The readiness callback runs after the real PTY probe succeeds and before the
            // first measured tick. Append a complete malformed JSON line to the real store.
            appendRaw(loc, "{");
          }
        },
      }
    );

    assert.equal(
      injectedFault,
      true,
      "the test fault follows the readiness phase"
    );
    assert.equal(result.readiness.ready, true, result.readiness.detail);
    const kinds = result.events.map((event) => event.kind);
    const observerAt = kinds.indexOf("observer_error");
    const haltAt = kinds.indexOf("sequence_halted");
    assert.ok(
      observerAt >= 0,
      `the malformed store must be observed; got: ${kinds}`
    );
    assert.ok(
      haltAt > observerAt,
      `the sequence halts after observing the fault; got: ${kinds}`
    );
    assert.ok(
      !kinds.includes("enter_sent"),
      `no Enter may be sent after the observer reports failure; got: ${kinds}`
    );
    assert.equal(
      result.acceptance[0]?.due_at_ms,
      0,
      "the stimulus was due on the first tick"
    );
    assert.equal(result.acceptance[0]?.sent_at_ms, null);
    assert.equal(result.acceptance[0]?.verdict, "observer-error");
    assert.deepEqual(
      result.strayProcesses,
      [],
      "the failed run must reap its child and relay"
    );
  });

  it("classifies a wall exhaustion as forced and never as a natural completion", async () => {
    const h = makeHarness();
    const result = await runTuiCalibration(
      protocol(h, {
        stimuli: [{ at: 200, tag: "S1", text: "TOO-LATE-STIMULUS" }],
        stop: {
          minSettleMs: 100,
          horizonMs: 200,
          exitGraceMs: 3000,
          innerWallMs: 400,
        },
      })
    );

    assert.notEqual(
      result.stop.cause,
      "clean_quit" as const,
      `a wall exhaustion is not a clean quit; got: ${result.stop.cause}`
    );
    assert.equal(result.stop.natural, false, result.stop.reason);
    assert.equal(
      result.report.usable,
      false,
      "a forced stop can never be usable"
    );
    assert.ok(
      result.report.blockedBy.includes("stop.clean_natural_exit"),
      `the stop gate must block the verdict; got: ${JSON.stringify(result.report.blockedBy)}`
    );
    // A stimulus the wall cut off was never accepted. `x === null ||
    // x !== undefined` was a TAUTOLOGY over the declared `number | null`, so it
    // stayed green even with the acceptance logic deleted — it said nothing
    // about acceptance at all.
    const record = result.acceptance[0];
    const NOT_ACCEPTED: readonly Verdict[] = [
      "pending",
      "refused",
      "timeout",
      "observer-error",
    ];
    assert.ok(
      record !== undefined && NOT_ACCEPTED.includes(record.verdict),
      `a stimulus cut off by the wall must not read as accepted; got: ${JSON.stringify(record)}`
    );
    assert.equal(
      record?.accepted_at_ms,
      null,
      `an unaccepted stimulus must carry no acceptance time; got: ${JSON.stringify(record)}`
    );
    assert.equal(
      record?.accepted_event_id,
      null,
      `an unaccepted stimulus must cite no event; got: ${JSON.stringify(record)}`
    );
    assert.deepEqual(
      result.strayProcesses,
      [],
      "a forced run must still reap everything it started"
    );
  });

  it("leaves no live process after teardown, and the retained store is production-valid", async () => {
    const h = makeHarness();
    const session = await openPty({
      command: process.execPath,
      args: childArgs(h),
      cwd: h.cwd,
    });
    const childPid = session.childPid;
    const relayPid = session.relayPid;
    assert.ok(
      isProcessAlive(childPid),
      `the fixture child must really run; pid: ${childPid}`
    );

    await session.dispose();

    assert.equal(
      isProcessAlive(childPid),
      false,
      `the child process group must be gone; pid: ${childPid}`
    );
    assert.equal(
      isProcessAlive(relayPid),
      false,
      `the relay must be gone; pid: ${relayPid}`
    );

    // A real run afterwards, so the retained store is checked against the
    // production parser rather than against the reader alone.
    const result = await runTuiCalibration(protocol(h));
    assert.ok(
      result.report.checks.some(
        (c) => c.id === "store.production_valid" && c.ok
      )
    );
    const checked = validateWholeFile(
      sessionFilePath({
        dataDir: h.dataDir,
        cwd: h.cwd,
        conversationId: h.conversationId,
      })
    );
    assert.equal(
      checked.error,
      null,
      `the measured store must satisfy the production parser; got: ${String(checked.error)}`
    );
    assert.deepEqual(result.strayProcesses, []);
  });
});
