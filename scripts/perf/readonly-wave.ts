#!/usr/bin/env npx tsx
/**
 * scripts/perf/readonly-wave.ts — measurement tool (no pass/fail gate).
 *
 * Measures how the ACI executor splits ONE round of 5 read-only bash calls
 * into waves, and how long that round takes on the wall clock.
 *
 * The wave count is OBSERVED, never inferred: the executor is driven with a
 * stub `inner` Executor that records every batch it receives (how many calls
 * are in each batch, and when it ran) and sleeps a fixed 50 ms per call
 * instead of running bash. The executor runs ONE wave at a time, so the
 * stub's execution intervals fall into groups: the calls of one wave
 * overlap in time, and two waves never do. The number of those groups IS
 * the wave count. Today bash is `isConcurrencySafe: false`, so the 5 calls
 * run as 5 waves of 1; when read-only bash becomes concurrency-safe per
 * call, the same 5 calls run as 1 wave of 5.
 *
 * The inner-batch count is reported next to the wave count because the two
 * are not the same number: the executor hands the inner one CALL per
 * invocation, so a wave of 5 concurrent calls reaches the inner as 5
 * batches of 1. `innerBatches` / `batchSizes` describe that hand-off;
 * `waves` describes the wave the calls were scheduled in.
 *
 * The commands are the REAL shape of a read-only round (cheap, genuinely
 * read-only). They are not executed: the stub inner intercepts every call.
 *
 * POLICY: the measurement runs under a NON-DEFAULT permission policy
 * (`bash: "allow"`). bash's DEFAULT verdict is `ask`, and under `ask` the
 * executor asks for every call and runs the round one call at a time — the
 * five calls would NOT share a wave. The measurement therefore pins the
 * deterministic `allow` branch, and it DISCLOSES that in the output: the
 * JSON line carries `policy` + `policyIsDefault`, and the stderr header says
 * it too. A reader of the quoted artifact must not mistake `waves=1` for the
 * default policy's speed-up.
 *
 * Usage:
 *   npx tsx scripts/perf/readonly-wave.ts
 *
 * Output:
 *   - stdout: ONE JSON line (the machine-readable result, quotable in a PR)
 *   - stderr: a short human-readable header
 *
 *   {
 *     "type": "readonly-wave-perf",
 *     "calls": 5,
 *     "policy": "bash=allow (non-default: the default bash verdict is ask)",
 *     "policyIsDefault": false,
 *     "waves": <number of waves the round was split into>,
 *     "innerBatches": <inner.executeAll invocations>,
 *     "batchSizes": [<calls per inner batch>, ...],
 *     "totalMs": <wall clock of the measured round>,
 *     "perWaveMs": [<duration of each wave>, ...],
 *     "maxConcurrentCalls": <calls in flight at the same time>,
 *     "perCallSleepMs": 50,
 *     "warmupRounds": 1,
 *     "commands": ["pwd", "ls", "git status", "cat package.json", "ls src/harness"],
 *     "bwrapPresent": <bool>,
 *     "fencePosture": "retired",
 *     "node": "<version>"
 *   }
 *
 * `waves` is the number a reviewer compares between master and this branch;
 * `maxConcurrentCalls` is the second, independent signal that the calls in
 * one wave really overlapped, and `totalMs` says what the split costs.
 *
 * NO threshold: this is a measurement, not a gate. It never fails a build on
 * a slow machine — the numbers are the output, the exit code is not a
 * verdict. It exits non-zero only when the round did not produce one
 * well-formed result per call: it never prints invented numbers.
 *
 * bwrap: the bash tool factory probes for bwrap at construction
 * (`requireBwrap`) unless the fence is retired, so the tool is built with
 * `fenceRetired: { get: () => true }` and the script runs on a host without
 * bubblewrap. The handler never runs here (the stub inner intercepts every
 * call), so the fence posture cannot affect what is measured: the wave
 * splitter's verdict for each call, which the tool's `aci` metadata decides.
 *
 * Cleanup: the only host state this script creates is ONE temp dir (the bash
 * tool's session `$TMPDIR`); it is removed in a `finally`. No process,
 * socket or port outlives the run — bash is never executed.
 *
 * Master parity: this file uses only symbols that exist on master
 * (`createBashTool`, `createAciExecutor`, `createPermissionPolicy`, the
 * `AciCatalog` / `AciToolDef` / `Executor` / `ToolCall` /
 * `ToolExecutionResult` types), so the very same file can be copied into a
 * master checkout and run there for the baseline. That is what makes the
 * comparison meaningful: same file, same commands, same stub, two trees.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createAciExecutor } from "../../src/harness/aci/aci-executor.js";
import { createPermissionPolicy } from "../../src/harness/aci/permission.js";
import { createBashTool } from "../../src/harness/aci/tools/bash.js";
import type { AciCatalog, AciToolDef } from "../../src/harness/aci/types.js";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../src/harness/tools/types.js";

/** The read-only round under measurement: 5 cheap, genuinely read-only commands. */
const COMMANDS: ReadonlyArray<string> = [
  "pwd",
  "ls",
  "git status",
  "cat package.json",
  "ls src/harness",
];
/** Per-call sleep in the stub inner executor — makes the wave count visible in the timing too. */
const PER_CALL_SLEEP_MS = 50;
/** Unmeasured rounds (JIT / page-cache warmup), outside the measured window. */
const WARMUP_ROUNDS = 1;
/**
 * The permission policy the measured round runs under — NOT the default one.
 *
 * bash's default verdict is `ask` (`execute` category default). Under `ask`
 * the executor asks for every call and runs the round one call at a time, so
 * the five read-only calls would NOT share a wave. The measurement pins the
 * deterministic `allow` branch and SAYS SO in its output.
 */
const POLICY_BY_NAME: Readonly<Record<string, "allow" | "deny" | "ask">> = {
  bash: "allow",
};
/** The policy, in the words the JSON line carries. */
const POLICY_DESCRIPTION =
  "bash=allow (non-default: the default bash verdict is ask)";
/** Whether the measured policy is the default one — it is not. */
const POLICY_IS_DEFAULT = false;

const here = dirname(fileURLToPath(import.meta.url));
/** The checkout this script lives in — the bash tool's cwd. */
const repoRoot = resolve(here, "..", "..");

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** bwrap on PATH? (context only — the script never needs it). */
function bwrapPresent(): boolean {
  const probe = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

/** A hand-written catalog over the real tool defs (the test idiom). */
function makeCatalog(tools: ReadonlyArray<AciToolDef>): AciCatalog {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return Object.freeze({
    get: (name: string) => byName.get(name),
    all: () => Object.freeze([...tools]) as ReadonlyArray<AciToolDef>,
  });
}

/** One batch the inner executor received: how many calls, and when it ran. */
interface InnerBatch {
  readonly size: number;
  readonly startedAt: number;
  endedAt: number;
}

/** The recording stub: it never runs bash, it only observes the batches. */
interface RecordingInner {
  readonly executor: Executor;
  readonly batches: ReadonlyArray<InnerBatch>;
  readonly maxConcurrentCalls: () => number;
}

/**
 * The stub inner executor. It NEVER runs bash: each call sleeps a fixed
 * amount and returns a well-formed result, so the round's wall clock and the
 * wave count are both observable without a sandbox.
 */
function makeRecordingInner(sleepMs: number): RecordingInner {
  const batches: InnerBatch[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const executor: Executor = Object.freeze({
    // The parameters are annotated: `Object.freeze` does not carry a
    // contextual type into the literal, so an inferred parameter would be an
    // implicit `any` under `noImplicitAny`.
    executeAll: async (batch: ReadonlyArray<ToolCall>) => {
      const record: InnerBatch = {
        size: batch.length,
        startedAt: performance.now(),
        endedAt: 0,
      };
      batches.push(record);
      const results: ToolExecutionResult[] = await Promise.all(
        batch.map(async (call: ToolCall): Promise<ToolExecutionResult> => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            await sleep(sleepMs);
            return {
              kind: "ok",
              toolUseId: call.id,
              payload: [{ type: "text", text: `stub:${call.name}` }],
            };
          } finally {
            inFlight -= 1;
          }
        })
      );
      record.endedAt = performance.now();
      return results;
    },
  });
  return {
    executor,
    batches,
    maxConcurrentCalls: () => maxInFlight,
  };
}

/**
 * The observed waves: the batches grouped by OVERLAPPING execution
 * intervals. The executor runs one wave at a time, so the calls of one wave
 * overlap and two waves never do — the groups are the waves.
 */
function groupIntoWaves(
  batches: ReadonlyArray<InnerBatch>
): ReadonlyArray<{ readonly size: number; readonly durationMs: number }> {
  const ordered = [...batches].sort((a, b) => a.startedAt - b.startedAt);
  const groups: Array<{ size: number; startedAt: number; endedAt: number }> =
    [];
  for (const batch of ordered) {
    const last = groups[groups.length - 1];
    if (last !== undefined && batch.startedAt < last.endedAt) {
      last.size += batch.size;
      last.endedAt = Math.max(last.endedAt, batch.endedAt);
      continue;
    }
    groups.push({
      size: batch.size,
      startedAt: batch.startedAt,
      endedAt: batch.endedAt,
    });
  }
  return groups.map((group) => ({
    size: group.size,
    durationMs: group.endedAt - group.startedAt,
  }));
}

/** One measured round: the wave split and the wall clock. */
interface RoundResult {
  readonly totalMs: number;
  readonly waves: number;
  readonly waveSizes: ReadonlyArray<number>;
  readonly perWaveMs: ReadonlyArray<number>;
  readonly innerBatches: number;
  readonly batchSizes: ReadonlyArray<number>;
  readonly maxConcurrentCalls: number;
}

async function runRound(opts: {
  readonly catalog: AciCatalog;
  readonly policy: ReturnType<typeof createPermissionPolicy>;
  readonly calls: ReadonlyArray<ToolCall>;
}): Promise<RoundResult> {
  const recorder = makeRecordingInner(PER_CALL_SLEEP_MS);
  const executor = createAciExecutor({
    inner: recorder.executor,
    catalog: opts.catalog,
    policy: opts.policy,
  });
  const started = performance.now();
  const results = await executor.executeAll(opts.calls);
  const totalMs = performance.now() - started;

  // Every call must have produced one well-formed result, in input order:
  // a short or failed round is reported, never papered over with numbers.
  if (results.length !== opts.calls.length) {
    throw new Error(
      `expected ${opts.calls.length} results, got ${results.length}`
    );
  }
  for (const [index, result] of results.entries()) {
    const expected = opts.calls[index];
    if (expected === undefined) continue;
    if (result.kind !== "ok") {
      throw new Error(
        `call ${expected.id} did not succeed (kind=${result.kind})`
      );
    }
    if (result.toolUseId !== expected.id) {
      throw new Error(
        `result ${index} carries toolUseId ${result.toolUseId}, expected ${expected.id}`
      );
    }
  }

  const waves = groupIntoWaves(recorder.batches);
  return {
    totalMs,
    waves: waves.length,
    waveSizes: waves.map((wave) => wave.size),
    perWaveMs: waves.map((wave) => round3(wave.durationMs)),
    innerBatches: recorder.batches.length,
    batchSizes: recorder.batches.map((batch) => batch.size),
    maxConcurrentCalls: recorder.maxConcurrentCalls(),
  };
}

async function main(): Promise<void> {
  const bwrap = bwrapPresent();

  console.error(
    `[readonly-wave-perf] calls=${COMMANDS.length} perCallSleepMs=${PER_CALL_SLEEP_MS} ` +
      `warmupRounds=${WARMUP_ROUNDS} bwrapPresent=${String(bwrap)} node=${process.version}`
  );
  console.error(
    `[readonly-wave-perf] policy=${POLICY_DESCRIPTION} policyIsDefault=${POLICY_IS_DEFAULT} — ` +
      "the wave count below is the NON-DEFAULT allow branch; under the default " +
      "policy (bash=ask) the calls are asked one at a time and run one at a time."
  );
  console.error(
    "[readonly-wave-perf] master-parity: this file uses only symbols that exist on " +
      "master (createBashTool / createAciExecutor / createPermissionPolicy), so the very " +
      "same file can be copied into a master checkout and run there for the baseline."
  );
  console.error(
    "[readonly-wave-perf] no threshold: this is a measurement, not a gate — the numbers " +
      "are the output, the exit code is not a verdict."
  );

  // ONE temp dir: the bash tool's session `$TMPDIR` (the only host state this
  // script creates) — removed in the `finally` below.
  const sessionTmp = await mkdtemp(join(tmpdir(), "iknow-readonly-wave-"));
  try {
    const tool = createBashTool(repoRoot, {
      tmpDir: sessionTmp,
      // ADR-0119 ruling 5: the factory's bwrap probe is skipped when the fence
      // is retired, so the script runs on a host without bubblewrap. The
      // handler never runs here, so the posture cannot affect the measurement.
      fenceRetired: { get: () => true },
    });
    const catalog = makeCatalog([tool]);
    // bash is "execute" (default: ask); the measurement wants the deterministic
    // allow branch, so the call is admitted without an approval round-trip.
    // The policy is NON-DEFAULT and the output discloses it (see POLICY_*).
    const policy = createPermissionPolicy({ byName: POLICY_BY_NAME });
    const calls: ToolCall[] = COMMANDS.map((command, index) => ({
      id: `readonly-wave-${index + 1}`,
      name: "bash",
      input: { command },
    }));

    // Warmup: JIT / first-call overhead, outside the measured window.
    for (let i = 0; i < WARMUP_ROUNDS; i++) {
      await runRound({ catalog, policy, calls });
    }

    const measured = await runRound({ catalog, policy, calls });

    console.error(
      `[readonly-wave-perf] waves=${measured.waves} waveSizes=[${measured.waveSizes.join(",")}] ` +
        `innerBatches=${measured.innerBatches} batchSizes=[${measured.batchSizes.join(",")}] ` +
        `totalMs=${round3(measured.totalMs)} ` +
        `maxConcurrentCalls=${measured.maxConcurrentCalls}`
    );
    console.log(
      JSON.stringify({
        type: "readonly-wave-perf",
        calls: calls.length,
        policy: POLICY_DESCRIPTION,
        policyIsDefault: POLICY_IS_DEFAULT,
        waves: measured.waves,
        waveSizes: measured.waveSizes,
        innerBatches: measured.innerBatches,
        batchSizes: measured.batchSizes,
        totalMs: round3(measured.totalMs),
        perWaveMs: measured.perWaveMs,
        maxConcurrentCalls: measured.maxConcurrentCalls,
        perCallSleepMs: PER_CALL_SLEEP_MS,
        warmupRounds: WARMUP_ROUNDS,
        commands: COMMANDS,
        bwrapPresent: bwrap,
        fencePosture: "retired",
        node: process.version,
      })
    );
  } finally {
    await rm(sessionTmp, { recursive: true, force: true });
  }
}

void main().catch((err: unknown) => {
  console.error(
    `[readonly-wave-perf] measurement failed: ${
      err instanceof Error ? err.message : String(err)
    }`
  );
  process.exit(1);
});
