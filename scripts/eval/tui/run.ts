/**
 * The measured orchestrator for #1219 TUI calibration.
 *
 * WHY four explicit phases: the measured stimulus sequence must not be able to
 * contaminate its own evidence. Phase 1 (readiness) is a NON-SUBMITTING probe
 * recorded under its own key. Phase 2 is the measured timetable, and every
 * claim in its report is derived from the persisted store relative to a baseline
 * taken BEFORE the probe. Taking it first is safe because the probe only types,
 * reads back and clears in the composer: it never submits, so it adds no
 * `type:"message"` record, and the acceptance predicate could not match it
 * either way. Phase 3 stops the process and names the stop cause.
 * Phase 4 derives the counters from the retained bytes and emits the
 * machine-readable check report.
 *
 * The verdict rule is one-way: a failed REQUIRED check makes `usable` false.
 * There is no path from "a check failed" to an unconditional `usable`, because
 * that is precisely how a 2-of-4-rejected run was previously indistinguishable
 * from a clean 4/4.
 *
 * Run: `npx tsx scripts/eval/tui/run.ts --protocol <protocol.json>`
 */
import type { Dirent } from "node:fs";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AcceptanceLedger, type AcceptanceRecord } from "./acceptance.js";
import { SUBMIT_KEYSTROKE, decideDelivery, planChunks } from "./delivery.js";
import {
  appendRssRow,
  buildIndex,
  deriveCounters,
  separateRuns,
  verifyIndex,
  writeIndexAtomic,
  writeSnapshot,
  type ArtifactRefs,
  type RunCounters,
} from "./evidence.js";
import { parseProtocol, type Protocol, type RunKind } from "./protocol.js";
import {
  isProcessAlive,
  openPty,
  probeReadiness,
  tail,
  type PtySession,
  type ReadinessVerdict,
} from "./pty.js";
import {
  SessionTailReader,
  listSessionFiles,
  sessionFilePath,
  takeBaseline,
  validateWholeFile,
  type Baseline,
} from "./session-store-reader.js";
import {
  decideStop,
  type ExitStatus,
  type StopDecision,
} from "./stop-policy.js";
import {
  buildCheckReport,
  type CheckFact,
  type CheckReport,
} from "./check-report.js";

// The verdict surface stays reachable from here, so the extraction moved the
// implementation without moving a single name.
export {
  REQUIRED_CHECK_IDS,
  buildCheckReport,
  type Check,
  type CheckFact,
  type CheckReport,
} from "./check-report.js";

/** One journalled step, at run-relative milliseconds. */
export interface RunEvent {
  readonly tRelMs: number;
  readonly kind: string;
  readonly detail: string;
}

export interface RunResult {
  readonly label: string;
  readonly runKind: RunKind;
  readonly artifactsDir: string;
  readonly readiness: ReadinessVerdict;
  readonly stop: StopDecision;
  readonly exitStatus: ExitStatus | null;
  readonly report: CheckReport;
  readonly acceptance: readonly AcceptanceRecord[];
  readonly counters: RunCounters | null;
  readonly otherRuns: readonly RunCounters[];
  /** The payload index, with the digest that binds this verdict to it. */
  readonly index: {
    readonly path: string;
    readonly ok: boolean;
    readonly mismatches: readonly string[];
    readonly sha256: string;
    readonly sizeBytes: number;
  };
  readonly strayProcesses: readonly number[];
  readonly events: readonly RunEvent[];
  /** Set when a phase threw; the verdict is `unusable` and the reason is kept. */
  readonly failure: string | null;
}

export interface RunOptions {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

const POLL_INTERVAL_MS = 100;

/** The verdict file. Held back from the payload index it verifies. */
const VERDICT_FILE = "check-report.json";

interface Artifacts {
  readonly runDir: string;
  readonly rssCsv: string;
  readonly snapshotsDir: string;
  readonly storeCopy: string;
  readonly baselineJson: string;
}

interface RunState {
  readonly protocol: Protocol;
  readonly artifacts: Artifacts;
  readonly reader: SessionTailReader;
  readonly ledger: AcceptanceLedger;
  readonly baseline: Baseline;
  readonly session: PtySession;
  readonly refused: Set<string>;
  readonly events: RunEvent[];
  lastRssAtMs: number;
  lastSnapshotAtMs: number;
  busySinceMs: number | null;
  observerFailed: boolean;
  wallExceeded: boolean;
  quitSent: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void timer.unref?.();
  });
}

function artifactsFor(protocol: Protocol): Artifacts {
  const runDir = join(protocol.artifactsDir, protocol.label);
  const snapshotsDir = join(runDir, "snapshots");
  mkdirSync(snapshotsDir, { recursive: true });
  return {
    runDir,
    rssCsv: join(runDir, "rss.csv"),
    snapshotsDir,
    storeCopy: join(runDir, "store.jsonl"),
    baselineJson: join(runDir, "baseline.json"),
  };
}

function journal(
  state: RunState,
  tRelMs: number,
  kind: string,
  detail: string
): void {
  state.events.push({ tRelMs, kind, detail });
}

/** Read the child's RSS from procfs. A missing entry yields a dead row, not a throw. */
function readRssKb(pid: number): number | null {
  try {
    const match = /VmRSS:\s+(\d+) kB/.exec(
      readFileSync(`/proc/${pid}/status`, "utf8")
    );
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function sampleRss(state: RunState, tRelMs: number): void {
  if (tRelMs - state.lastRssAtMs < state.protocol.rssIntervalMs) return;
  state.lastRssAtMs = tRelMs;
  const kb = readRssKb(state.session.childPid);
  appendRssRow(state.artifacts.rssCsv, {
    tRelS: tRelMs,
    iso: new Date().toISOString(),
    pid: state.session.childPid,
    vmrssKb: kb ?? 0,
    alive: kb === null ? 0 : 1,
  });
}

function takeSnapshot(state: RunState, tRelMs: number): void {
  if (tRelMs - state.lastSnapshotAtMs < state.protocol.snapshotIntervalMs)
    return;
  state.lastSnapshotAtMs = tRelMs;
  const index = state.events.filter((e) => e.kind === "snapshot").length + 1;
  writeSnapshot(
    state.artifacts.snapshotsDir,
    index,
    tail(state.session.since(0), 4000)
  );
  journal(state, tRelMs, "snapshot", `screen-${index}`);
}

function observe(state: RunState, tRelMs: number): void {
  const poll = state.reader.poll();
  state.ledger.observe(poll, tRelMs);
  if (poll.error !== null) {
    state.observerFailed = true;
    journal(state, tRelMs, "observer_error", poll.error.message);
  }
  state.busySinceMs = state.ledger.busy ? (state.busySinceMs ?? tRelMs) : null;
}

async function writePaced(
  session: PtySession,
  text: string,
  protocol: Protocol,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  for (const chunk of planChunks(text, protocol.delivery)) {
    if (chunk.delayMs > 0) await sleep(chunk.delayMs);
    session.write(chunk.text);
  }
}

async function submit(args: {
  readonly state: RunState;
  readonly tag: string;
  readonly text: string;
  readonly tRelMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<void> {
  const { state, tag, text, tRelMs, sleep } = args;
  // Mark BEFORE writing: a crash between the mark and the keystroke must leave
  // an unverified submission on record, never an untracked one. The verdict is
  // honored rather than assumed: a stimulus the ledger already refuses (a
  // refusal is final) or already sent must not be typed at all, or the run
  // would blind-resend exactly the input it recorded as undeliverable.
  if (!state.ledger.markSent(tag, tRelMs)) {
    journal(
      state,
      tRelMs,
      "submission_skipped",
      `${tag}: already refused or already submitted; nothing was typed`
    );
    return;
  }
  await writePaced(state.session, text, state.protocol, sleep);
  journal(state, tRelMs, "enter_sent", `${tag} (${text.length} chars)`);
  state.session.write(SUBMIT_KEYSTROKE);
}

function expireAcceptance(state: RunState, tRelMs: number): void {
  for (const record of state.ledger.records()) {
    if (record.sent_at_ms === null || record.verdict !== "pending") continue;
    if (tRelMs - record.sent_at_ms <= state.protocol.delivery.acceptTimeoutMs)
      continue;
    state.ledger.markTimeout(
      record.tag,
      tRelMs,
      "no persisted acceptance evidence inside acceptTimeoutMs"
    );
    journal(
      state,
      tRelMs,
      "submission_failed",
      `${record.tag}: acceptance timed out`
    );
  }
}

/** One scheduler tick: observe, sample, then take at most one delivery step. */
async function tick(
  state: RunState,
  tRelMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<"continue" | "halt"> {
  observe(state, tRelMs);
  if (state.ledger.hasObserverError) return "halt";
  sampleRss(state, tRelMs);
  takeSnapshot(state, tRelMs);
  expireAcceptance(state, tRelMs);
  const decision = decideDelivery({
    protocol: state.protocol,
    ledger: state.ledger,
    nowMs: tRelMs,
    busy: state.ledger.busy,
    busySinceMs: state.busySinceMs,
  });
  if (
    decision.action === "submit" &&
    decision.tag !== null &&
    decision.text !== null
  ) {
    await submit({
      state,
      tag: decision.tag,
      text: decision.text,
      tRelMs,
      sleep,
    });
  }
  if (
    decision.action === "refused" &&
    decision.tag !== null &&
    !state.refused.has(decision.tag)
  ) {
    state.refused.add(decision.tag);
    state.ledger.markRefused(decision.tag, tRelMs, decision.reason);
    journal(
      state,
      tRelMs,
      "submission_failed",
      `${decision.tag}: ${decision.reason}`
    );
  }
  if (state.ledger.hasObserverError) return "halt";
  return noProgressLeft(state) ? "halt" : "continue";
}

/**
 * True when nothing further can be delivered or verified.
 *
 * The historical rule was "every scheduled stimulus was sent" (`p_idx >=
 * len(pending)`), which fired while the last acceptance evidence was still being
 * written and turned an in-flight round into a silent stop. Here a run stays
 * open while any stimulus is still DELIVERABLE OR any record is still waiting
 * for its acceptance or its settlement; only final verdicts (settled / refused
 * / timeout / observer error) close it.
 */
function noProgressLeft(state: RunState): boolean {
  if (state.ledger.records().some(isDeliverable)) return false;
  return !state.ledger.records().some(isInFlight);
}

/**
 * A stimulus that can still reach the composer: never written, and not already
 * refused. A refusal is final — there is no blind resend — so once it is
 * recorded nothing further can be delivered, whatever the host does next.
 */
function isDeliverable(record: {
  verdict: string;
  sent_at_ms: number | null;
}): boolean {
  if (record.sent_at_ms !== null) return false;
  return record.verdict !== "refused";
}

function isInFlight(record: {
  verdict: string;
  sent_at_ms: number | null;
  settled_at_ms: number | null;
}): boolean {
  if (record.sent_at_ms === null) return false;
  if (record.verdict === "pending") return true;
  return record.verdict === "accepted" && record.settled_at_ms === null;
}

/** Phase 2: the measured timetable. */
async function runMeasuredSequence(
  state: RunState,
  sleep: (ms: number) => Promise<void>,
  now: () => number
): Promise<number> {
  const start = now();
  for (;;) {
    const tRelMs = now() - start;
    if (tRelMs > state.protocol.stop.innerWallMs) {
      state.wallExceeded = true;
      journal(
        state,
        tRelMs,
        "wall_exhausted",
        `inner wall ${state.protocol.stop.innerWallMs}ms reached`
      );
      return tRelMs;
    }
    const outcome = await tick(state, tRelMs, sleep);
    if (outcome === "halt") {
      journal(
        state,
        tRelMs,
        "sequence_halted",
        "no stimulus can progress; evidence retained"
      );
      return tRelMs;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * The run-relative time at which the run MAY issue `/quit`, or null when it may
 * never do so: accepted AND settled AND idleness proven. The frozen horizon is
 * measured FROM the last settlement and must actually be waited out — checking it
 * the instant a round settled is the check that never passes.
 */
function quitableAt(state: RunState): number | null {
  if (state.wallExceeded || state.observerFailed) return null;
  if (!state.ledger.allSettled() || !state.ledger.idleProven) return null;
  const lastSettled = state.ledger.lastSettledAtMs();
  if (lastSettled === null) return null;
  const wait = Math.max(
    state.protocol.stop.minSettleMs,
    state.protocol.stop.horizonMs
  );
  return lastSettled + wait;
}

/** Phase 3: `/quit` and a verified clean exit, or an explicit forced stop. */
async function stopChild(
  state: RunState,
  tRelMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<{ exit: ExitStatus | null; stop: StopDecision }> {
  const readyAt = quitableAt(state);
  if (readyAt !== null) {
    const holdMs = Math.max(0, readyAt - tRelMs);
    if (holdMs > 0) {
      journal(
        state,
        tRelMs,
        "horizon_hold",
        `holding ${holdMs}ms for the frozen horizon`
      );
      await sleep(holdMs);
      tRelMs += holdMs;
    }
    state.quitSent = true;
    journal(
      state,
      tRelMs,
      "quit_sent",
      "/quit after every stimulus settled and the horizon elapsed"
    );
    state.session.write("/quit");
    state.session.write(SUBMIT_KEYSTROKE);
    const exit = await state.session.waitExit(state.protocol.stop.exitGraceMs);
    journal(
      state,
      tRelMs,
      "child_exit",
      exit === null ? "no exit observed inside the grace" : JSON.stringify(exit)
    );
    return {
      exit,
      stop: decideStop(stopArgs(state, tRelMs, exit, exit === null)),
    };
  }
  journal(
    state,
    tRelMs,
    "forced_stop",
    "preconditions unmet; terminating instead of upgrading to a clean run"
  );
  await state.session.killGroup("preconditions unmet");
  const exit = await state.session.waitExit(state.protocol.stop.exitGraceMs);
  return {
    exit,
    stop: decideStop(
      stopArgs(state, tRelMs, exit, exit === null || !state.quitSent)
    ),
  };
}

function stopArgs(
  state: RunState,
  tRelMs: number,
  exit: ExitStatus | null,
  forced: boolean
) {
  return {
    requiredTags: state.ledger.tags,
    acceptedTags: state.ledger.acceptedTags(),
    settledTags: state.ledger.settledTags(),
    lastSettledAtMs: state.ledger.lastSettledAtMs(),
    nowMs: tRelMs,
    horizonMs: state.protocol.stop.horizonMs,
    quitSent: state.quitSent,
    exit,
    wallExceeded: state.wallExceeded,
    forced,
    idleProven: state.ledger.idleProven,
  };
}

/** Credential-shaped text must never reach a retained artifact. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /"apiKey"\s*:/,
  /ANTHROPIC_API_KEY\s*=/,
  /IKNOW_LLM_API_KEY\s*=/,
];

function listTextArtifacts(dir: string, prefix = ""): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      names.push(...listTextArtifacts(join(dir, entry.name), rel));
      continue;
    }
    if (/\.(json|jsonl|txt|csv)$/.test(entry.name)) names.push(rel);
  }
  return names;
}

function scanForSecrets(dir: string): string[] {
  const found: string[] = [];
  for (const rel of listTextArtifacts(dir)) {
    const body = readFileSync(join(dir, rel), "utf8");
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(body)) found.push(rel);
    }
  }
  return [...new Set(found)];
}

function retainStore(state: RunState): void {
  try {
    copyFileSync(state.baseline.path, state.artifacts.storeCopy);
  } catch {
    // The store may never have been created; `store.production_valid` then fails.
  }
  writeFileSync(
    state.artifacts.baselineJson,
    JSON.stringify(
      {
        conversationId: state.baseline.conversationId,
        byteOffset: state.baseline.byteOffset,
        eventIds: state.baseline.eventIds,
        path: state.baseline.path,
      },
      null,
      2
    ),
    "utf8"
  );
}

/** Phase 4: derive every number from the retained bytes, then index them. */
function finalizeEvidence(
  state: RunState,
  window: { startedIso: string; endedIso: string }
): RunCounters | null {
  retainStore(state);
  const refs: ArtifactRefs = {
    runDir: state.artifacts.runDir,
    runKind: state.protocol.runKind,
    rssCsv: state.artifacts.rssCsv,
    snapshotsDir: state.artifacts.snapshotsDir,
    storeJsonl: state.artifacts.storeCopy,
    baselineJson: state.artifacts.baselineJson,
    window,
  };
  let counters: RunCounters | null = null;
  try {
    counters = deriveCounters(refs);
  } catch {
    counters = null;
  }
  writeFileSync(
    join(state.artifacts.runDir, "acceptance.json"),
    JSON.stringify(state.ledger.records(), null, 2),
    "utf8"
  );
  writeFileSync(
    join(state.artifacts.runDir, "events.jsonl"),
    renderEvents(state.events),
    "utf8"
  );
  writeFileSync(
    join(state.artifacts.runDir, "counters.json"),
    JSON.stringify(counters, null, 2),
    "utf8"
  );
  return counters;
}

function renderEvents(events: readonly RunEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** Everything the phases produced, before the verdict is derived. */
interface Phases {
  readonly readiness: ReadinessVerdict;
  readonly stopped: {
    readonly exit: ExitStatus | null;
    readonly stop: StopDecision;
  };
  readonly counters: RunCounters | null;
  readonly index: {
    readonly path: string;
    readonly ok: boolean;
    readonly mismatches: string[];
    readonly sha256: string;
    readonly sizeBytes: number;
  };
  readonly secrets: readonly string[];
}

/**
 * Build the run state, releasing the PTY if it cannot be built.
 *
 * The `try`/`finally` in `runTuiCalibration` owns teardown, but it is entered
 * only once the state exists — so a throw in between would orphan the relay and
 * its child. Nothing in here throws today (`takeBaseline` swallows every error
 * and the ledger's constructor cannot fail), which is precisely why the gap is
 * worth closing: the first assertion added here would otherwise leak processes.
 */
async function buildState(
  session: PtySession,
  protocol: Protocol,
  artifacts: Artifacts
): Promise<RunState> {
  try {
    const location = {
      dataDir: protocol.dataDir,
      cwd: protocol.cwd,
      conversationId: protocol.conversationId,
    };
    const baseline = takeBaseline(location);
    return {
      protocol,
      artifacts,
      reader: new SessionTailReader({ location, baseline }),
      ledger: new AcceptanceLedger({ baseline, stimuli: protocol.stimuli }),
      baseline,
      session,
      refused: new Set<string>(),
      events: [],
      lastRssAtMs: -Infinity,
      lastSnapshotAtMs: -Infinity,
      busySinceMs: null,
      observerFailed: false,
      wallExceeded: false,
      quitSent: false,
    };
  } catch (err) {
    await session.dispose();
    throw err;
  }
}

/**
 * Run the four phases and emit the verdict.
 *
 * Teardown is unconditional: the PTY, the child process group and the relay are
 * released on every path — a reader throw, a wall exhaustion or an interruption
 * included — so a failed run leaves no live process behind. The verdict is built
 * AFTER teardown, because `teardown.no_stray_process` is an observation about
 * what survived, not an assumption.
 */
export async function runTuiCalibration(
  protocol: Protocol,
  opts: RunOptions = {}
): Promise<RunResult> {
  const now = opts.now ?? ((): number => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((): void => {});
  const artifacts = artifactsFor(protocol);
  const startedIso = new Date().toISOString();
  const session = await openPty({
    command: protocol.child.command,
    args: protocol.child.args,
    cwd: protocol.cwd,
    rows: 40,
    cols: 120,
  });
  const state = await buildState(session, protocol, artifacts);

  let phases: Phases | null = null;
  let failure: string | null = null;
  // The outer watchdog is the hard cap on the whole run. It is deliberately
  // LONGER than the inner wall plus the exit grace, so it can only fire when
  // something the inner bounds did not cover hung — never to race the graceful
  // path it protects.
  const watchdog = setTimeout(() => {
    state.observerFailed = true;
    void session.killGroup(`outer watchdog at ${protocol.outerWatchdogMs}ms`);
  }, protocol.outerWatchdogMs);
  void watchdog.unref?.();
  try {
    phases = await runPhases({ state, sleep, now, startedIso, log });
  } catch (err) {
    failure = String(err);
    log(`run failed: ${failure}`);
  } finally {
    clearTimeout(watchdog);
    await session.dispose();
  }
  const stray = [session.childPid, session.relayPid].filter(
    (pid) => pid > 0 && isProcessAlive(pid)
  );
  log(`teardown: stray pids ${JSON.stringify(stray)}`);
  return assemble(state, phases, stray, failure);
}

/** The four measured phases, in order. */
async function runPhases(args: {
  readonly state: RunState;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly startedIso: string;
  readonly log: (line: string) => void;
}): Promise<Phases> {
  const { state, sleep, now, startedIso, log } = args;
  // Phase 1 — readiness, recorded separately from the measured sequence.
  const readiness = await probeReadiness(
    state.session,
    state.protocol.readiness
  );
  journal(state, 0, "readiness_probe", readiness.detail);
  log(`readiness: ${readiness.detail}`);
  // Phase 2 — the measured timetable.
  const sequenceEnd = await runMeasuredSequence(state, sleep, now);
  // Phase 3 — stop and classify, never upgrade.
  const stopped = await stopChild(state, sequenceEnd, sleep);
  // Phase 4 — derive from the retained bytes, then index them.
  const counters = finalizeEvidence(state, {
    startedIso,
    endedIso: new Date().toISOString(),
  });
  return {
    readiness,
    stopped,
    counters,
    index: writeIndex(state),
    secrets: scanForSecrets(state.artifacts.runDir),
  };
}

function conversationCountIsOne(state: RunState): boolean {
  const location = {
    dataDir: state.protocol.dataDir,
    cwd: state.protocol.cwd,
    conversationId: state.protocol.conversationId,
  };
  const files = listSessionFiles(location);
  return files.length === 1 && files[0] === sessionFilePath(location);
}

function writeIndex(state: RunState): Phases["index"] {
  // The verdict file is held back: it carries this index's own verification
  // result, so it cannot also be one of the index's payloads.
  const { entries } = buildIndex(state.protocol.artifactsDir, {
    exclude: [VERDICT_FILE],
  });
  const written = writeIndexAtomic(state.protocol.artifactsDir, entries, {
    label: `#1219 TUI calibration (${state.protocol.label}) artifact index`,
  });
  const verified = verifyIndex(state.protocol.artifactsDir);
  return {
    path: written.path,
    ok: verified.ok,
    mismatches: verified.mismatches,
    ...indexDigest(written.path),
  };
}

/** The index's own digest, so the verdict is bound to the index it verified. */
function indexDigest(path: string): {
  readonly sha256: string;
  readonly sizeBytes: number;
} {
  try {
    const bytes = readFileSync(path);
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    };
  } catch {
    return { sha256: "", sizeBytes: 0 };
  }
}

/** `??` and `&&` are decision points too; routing them through named helpers
 *  keeps each function's complexity readable instead of arithmetic. */
function orElse<T>(value: T | null | undefined, fallback: T): T {
  return value === null || value === undefined ? fallback : value;
}

function all(...values: readonly boolean[]): boolean {
  return values.every((v) => v);
}

/** The phase output with every optional resolved, so the verdict code stays flat. */
interface ResolvedPhases {
  readonly readiness: ReadinessVerdict;
  readonly stop: StopDecision;
  readonly exit: ExitStatus | null;
  readonly counters: RunCounters | null;
  readonly otherRuns: readonly RunCounters[];
  readonly index: RunResult["index"];
  readonly secrets: readonly string[];
  /** False when a phase threw: nothing below was observed at all. */
  readonly ran: boolean;
}

/**
 * Every OTHER run's retained counters: one `counters.json` per run directory
 * below the artifacts root.
 *
 * WHY read the directory: the pooling check compares THIS run against the runs
 * that share its artifacts directory, so handing `separateRuns` only this run's
 * own counters made the comparison an empty set — the check then passed
 * whatever the disk held. A sibling that cannot be parsed is skipped rather
 * than guessed at; a run whose counters were never derived wrote `null`.
 */
function siblingCounters(
  artifactsDir: string,
  ownRunDir: string
): RunCounters[] {
  const found: RunCounters[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(artifactsDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = join(artifactsDir, entry.name);
    if (runDir === ownRunDir) continue;
    const counters = readRunCounters(join(runDir, "counters.json"));
    if (counters !== null) found.push(counters);
  }
  return found;
}

function readRunCounters(path: string): RunCounters | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<RunCounters>;
    if (
      typeof candidate.runKind !== "string" ||
      typeof candidate.runDir !== "string"
    )
      return null;
    return candidate as RunCounters;
  } catch {
    return null;
  }
}

function resolvePhases(
  state: RunState,
  phases: Phases | null,
  failure: string | null
): ResolvedPhases {
  const counters = orElse(phases?.counters, null);
  return {
    readiness: orElse(phases?.readiness, failedReadiness()),
    stop: orElse(
      phases?.stopped.stop,
      unprovenStop(orElse(failure, "the run failed before a stop decision"))
    ),
    exit: orElse(phases?.stopped.exit, null),
    counters,
    otherRuns: siblingCounters(
      state.protocol.artifactsDir,
      state.artifacts.runDir
    ),
    index: orElse(phases?.index, missingIndex()),
    secrets: orElse(phases?.secrets, [] as readonly string[]),
    ran: phases !== null,
  };
}

/** Collect the observed facts. Every field is a reading, never a constant. */
function observedFacts(
  state: RunState,
  resolved: ResolvedPhases,
  stray: readonly number[],
  failure: string | null
): CheckFact {
  const ran = resolved.ran;
  return {
    label: state.protocol.label,
    runKind: state.protocol.runKind,
    readinessProven: resolved.readiness.ready,
    allAccepted: all(
      ran,
      state.ledger.acceptedTags().length === state.ledger.tags.length
    ),
    allSettled: all(ran, state.ledger.allSettled()),
    idleProven: all(ran, state.ledger.idleProven),
    stopNatural: resolved.stop.natural,
    indexVerified: resolved.index.ok,
    countersDerived: resolved.counters !== null,
    noPooling: countersBelongToThisRun(state, resolved),
    singleSessionFile: conversationCountIsOne(state),
    // An observer error never throws: it sets `observerFailed` and the tick
    // returns "halt", so a phase throw alone would have left this check green
    // while the run had in fact stopped reading the store it is judged on.
    observerClean: all(ran, failure === null, !state.observerFailed),
    storeValid: validateWholeFile(state.artifacts.storeCopy).error === null,
    teardownClean: stray.length === 0,
    noSecrets: resolved.secrets.length === 0,
  };
}

/**
 * A run's counters must come from its OWN artifact directory and carry its own
 * role. A resume or smoke run is additionally required NOT to claim the measured
 * slot, so pooling the two can never happen silently.
 */
function countersBelongToThisRun(
  state: RunState,
  resolved: ResolvedPhases
): boolean {
  const counters = resolved.counters;
  if (counters === null) return false;
  if (
    counters.runDir !== state.artifacts.runDir ||
    counters.runKind !== state.protocol.runKind
  )
    return false;
  if (state.protocol.runKind !== "measured") return true;
  // The measured role must be claimed ONCE across every run on disk, so the
  // measured split spans this run AND the siblings `resolvePhases` read.
  return separateRuns([counters, ...resolved.otherRuns]).measured !== null;
}

/**
 * Name what the pooling gate actually compared.
 *
 * WHY: the gate table in `check-report.ts` carries one fixed diagnostic, so a
 * run whose artifacts directory holds no sibling would otherwise report "resume
 * and smoke samples were kept separate" for a comparison that never happened.
 * The verdict is still `ok` — nothing was pooled — but it says so.
 */
function withHonestPoolingDetail(
  report: CheckReport,
  resolved: ResolvedPhases
): CheckReport {
  if (resolved.otherRuns.length > 0) return report;
  return {
    ...report,
    checks: report.checks.map((c) =>
      c.id === "evidence.no_pooling"
        ? {
            ...c,
            detail:
              "no other run's counters were present, so nothing could be pooled into this one",
          }
        : c
    ),
  };
}

/** Derive the verdict from what the phases observed. Never from a constant. */
function assemble(
  state: RunState,
  phases: Phases | null,
  stray: readonly number[],
  failure: string | null
): RunResult {
  const resolved = resolvePhases(state, phases, failure);
  const report = withHonestPoolingDetail(
    buildCheckReport(observedFacts(state, resolved, stray, failure)),
    resolved
  );
  writeVerdict(state, { report, resolved, stray, failure });
  return {
    label: state.protocol.label,
    // The role this run declared, not a constant: hard-coding "measured" made a
    // resume or smoke run report the measured slot, contradicting the
    // `counters.runKind` in its own artifact.
    runKind: state.protocol.runKind,
    artifactsDir: state.artifacts.runDir,
    readiness: resolved.readiness,
    stop: resolved.stop,
    exitStatus: resolved.exit,
    report,
    acceptance: state.ledger.records(),
    counters: resolved.counters,
    otherRuns: resolved.otherRuns,
    index: resolved.index,
    strayProcesses: stray,
    events: state.events,
    failure,
  };
}

function missingIndex(): RunResult["index"] {
  return {
    path: "",
    ok: false,
    mismatches: ["no index was written"],
    sha256: "",
    sizeBytes: 0,
  };
}

function writeVerdict(
  state: RunState,
  args: {
    readonly report: CheckReport;
    readonly resolved: ResolvedPhases;
    readonly stray: readonly number[];
    readonly failure: string | null;
  }
): void {
  writeFileSync(
    join(state.artifacts.runDir, VERDICT_FILE),
    JSON.stringify(
      {
        report: args.report,
        stop: args.resolved.stop,
        readiness: args.resolved.readiness,
        exit: args.resolved.exit,
        stray_processes: args.stray,
        failure: args.failure,
      },
      null,
      2
    ),
    "utf8"
  );
}

function unprovenStop(reason: string): StopDecision {
  return {
    cause: "unproven",
    natural: false,
    readyToStop: false,
    missing: [],
    usable: false,
    reason,
  };
}

function failedReadiness(): ReadinessVerdict {
  return {
    ready: false,
    echoed: false,
    cleared: false,
    token: "",
    attempts: 0,
    enterWrites: 0,
    detail: "the readiness probe never ran",
    evidence: "",
  };
}

/** CLI entry. Exit 0 only for an unconditional `usable` verdict. */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.protocolPath === null) {
    console.error(
      "usage: tsx scripts/eval/tui/run.ts --protocol <protocol.json> [--artifacts <dir>]"
    );
    return 2;
  }
  const parsed = parseProtocol(
    JSON.parse(readFileSync(args.protocolPath, "utf8")) as unknown
  );
  const protocol =
    args.artifactsDir === null
      ? parsed
      : { ...parsed, artifactsDir: args.artifactsDir };
  const result = await runTuiCalibration(protocol, {
    log: (line) => console.error(line),
  });
  console.log(JSON.stringify(result.report, null, 2));
  return result.report.usable ? 0 : 1;
}

interface CliArgs {
  readonly protocolPath: string | null;
  readonly artifactsDir: string | null;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let protocolPath: string | null = null;
  let artifactsDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--protocol") protocolPath = argv[++i] ?? null;
    if (argv[i] === "--artifacts") artifactsDir = argv[++i] ?? null;
  }
  return { protocolPath, artifactsDir };
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]));

if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(String(err));
      process.exitCode = 2;
    }
  );
}
