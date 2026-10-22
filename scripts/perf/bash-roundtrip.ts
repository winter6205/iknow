#!/usr/bin/env npx tsx
/**
 * scripts/perf/bash-roundtrip.ts — measurement tool (no pass/fail gate).
 *
 * Measures the per-call wall-clock latency of a REAL fenced bash call —
 * `bash -c true` inside a bwrap sandbox — and prints the distribution
 * (p50 / p95 / min / max / mean) over 50 calls issued through ONE tool
 * instance, i.e. one "session": the fence inputs, the protected-target
 * wiring and the credential read mask are exactly the work a session-level
 * cache would amortize, so this is the number the plan's fence/egress work
 * moves.
 *
 * Usage:
 *   npx tsx scripts/perf/bash-roundtrip.ts
 *
 * Output:
 *   - stdout: ONE JSON line (the machine-readable result, quotable in a PR)
 *   - stderr: a short human-readable header + any diagnostics
 *
 *   {
 *     "type": "bash-roundtrip-perf",
 *     "iterations": 50,
 *     "warmupIterations": 3,
 *     "command": "true",
 *     "fence": "on",
 *     "fsMode": "workspace",
 *     "timeoutMs": 60000,
 *     "p50Ms": <number>, "p95Ms": <number>,
 *     "minMs": <number>, "maxMs": <number>, "meanMs": <number>,
 *     "totalMs": <number>,
 *     "fenceNamespaceIsolated": <bool>,
 *     "bwrapVersion": "<string>", "node": "<version>"
 *   }
 *
 * NO threshold: this is a measurement, not a gate. It exits 0 whenever the
 * fence actually ran, and it never fails a build on a slow machine — the
 * numbers are the output, the exit code is not a verdict. It exits non-zero
 * only when the fence could not run at all (no bwrap on PATH, or a call that
 * did not exit 0): it never prints invented numbers.
 *
 * How the fence is enabled: the tool is built with the workspace fs-isolation
 * tier (`createFsModeContext("workspace")` → home visible read-only, writes
 * limited to the task root + the session tmp), the real `homedir()` as
 * `homeRoot`, and the checkout this script lives in as both `workspaceRoot`
 * (the name-pattern scan scope) and the task root (the cwd the command runs
 * in). `fenceRetired` is left unset, so the fence is ON and `--unshare-net`
 * is always in effect. The `fenceNamespaceIsolated` field is a cheap probe
 * (the sandbox's own mount-namespace id vs. this process's) that shows the
 * call really ran inside a namespace and not on the bare host.
 *
 * Cleanup: the only host state this script creates is ONE temp dir (the
 * session `$TMPDIR` the fence's credential-mask covers live under); it is
 * removed in a `finally`. No process, socket or port outlives the run.
 *
 * Master parity: this file uses only symbols that exist on master
 * (`createBashTool`, `createFsModeContext`), so the very same file can be
 * copied into a master checkout and run there for the baseline.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createBashTool } from "../../src/harness/aci/tools/bash.js";
import { createFsModeContext } from "../../src/harness/sandbox/fs-mode.js";

/** Measured calls (the plan's number). */
const ITERATIONS = 50;
/** Unmeasured calls: JIT / page-cache warmup, outside the measured window. */
const WARMUP_ITERATIONS = 3;
/** The command under measurement — the cheapest possible payload. */
const COMMAND = "true";
/**
 * Per-call runtime budget. The default (10 s) is enough for a healthy host,
 * but a loaded machine must not turn into a spurious "the fence is broken"
 * failure; the deadline arm is the same code path the default takes.
 */
const TIMEOUT_MS = 60_000;

const here = dirname(fileURLToPath(import.meta.url));
/** The checkout this script lives in — task root + name-pattern scan scope. */
const repoRoot = resolve(here, "..", "..");

/** The bash handler's result envelope (`{ output, meta? }`). */
interface BashEnvelope {
  readonly output: string;
}

/** Exit code carried by the handler's JSON payload, or undefined if absent. */
function exitCodeOf(envelope: unknown): number | undefined {
  const output = (envelope as BashEnvelope | null | undefined)?.output;
  if (typeof output !== "string") return undefined;
  try {
    const parsed = JSON.parse(output) as { code?: unknown };
    return typeof parsed.code === "number" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

/** stdout carried by the handler's JSON payload ("" when absent). */
function stdoutOf(envelope: unknown): string {
  const output = (envelope as BashEnvelope | null | undefined)?.output;
  if (typeof output !== "string") return "";
  try {
    const parsed = JSON.parse(output) as { stdout?: unknown };
    return typeof parsed.stdout === "string" ? parsed.stdout : "";
  } catch {
    return "";
  }
}

function median(sorted: ReadonlyArray<number>): number {
  if (sorted.length === 0) return Number.NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function percentile(sorted: ReadonlyArray<number>, fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  );
  return sorted[idx] as number;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** bwrap's version banner, or undefined when bwrap is not on PATH. */
function bwrapVersion(): string | undefined {
  const probe = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) return undefined;
  return (probe.stdout ?? "").trim() || undefined;
}

/** The bash tool this script drives. */
type BashTool = ReturnType<typeof createBashTool>;

/** One fenced call; throws when the call did not exit 0. */
async function callBash(tool: BashTool, command: string): Promise<unknown> {
  const envelope = await tool.handler({
    command,
    timeout_ms: TIMEOUT_MS,
  });
  const code = exitCodeOf(envelope);
  if (code !== 0) {
    throw new Error(
      `fenced bash call did not exit 0 (code=${String(code)}) for command ${JSON.stringify(command)}`
    );
  }
  return envelope;
}

/**
 * Fence probe (unmeasured): the sandbox's own mount-namespace id must differ
 * from this process's — that is what "the fence really ran" means here. A
 * probe failure is reported, never fatal: the measurement is still valid, the
 * probe is only evidence.
 */
async function probeFenceNamespace(tool: BashTool): Promise<boolean> {
  try {
    const probe = await callBash(tool, "readlink /proc/self/ns/mnt");
    const inside = stdoutOf(probe).trim();
    const host = readlinkSync("/proc/self/ns/mnt");
    return inside.length > 0 && inside !== host;
  } catch (err) {
    console.error(
      `[bash-roundtrip-perf] fence probe failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }
}

/** The measured loop: N fenced calls, one wall-clock sample each. */
async function measureLoop(
  tool: BashTool,
  iterations: number
): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await callBash(tool, COMMAND);
    samples.push(performance.now() - t0);
  }
  return samples;
}

/** The one-line JSON report (stdout). */
function buildReport(
  samples: ReadonlyArray<number>,
  totalMs: number,
  fenceNamespaceIsolated: boolean,
  version: string
): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((acc, value) => acc + value, 0) / samples.length;
  return JSON.stringify({
    type: "bash-roundtrip-perf",
    iterations: ITERATIONS,
    warmupIterations: WARMUP_ITERATIONS,
    command: COMMAND,
    fence: "on",
    fsMode: "workspace",
    timeoutMs: TIMEOUT_MS,
    p50Ms: round3(median(sorted)),
    p95Ms: round3(percentile(sorted, 0.95)),
    minMs: round3(sorted[0] as number),
    maxMs: round3(sorted[sorted.length - 1] as number),
    meanMs: round3(mean),
    totalMs: round3(totalMs),
    fenceNamespaceIsolated,
    bwrapVersion: version,
    node: process.version,
  });
}

async function main(): Promise<void> {
  const version = bwrapVersion();
  if (version === undefined) {
    console.error(
      "[bash-roundtrip-perf] bwrap is not available on PATH — the fence cannot run. " +
        "Install bubblewrap (>= 0.11.1) and retry; refusing to print numbers for a fence that never ran."
    );
    process.exit(1);
  }

  console.error(
    `[bash-roundtrip-perf] fence=workspace bwrap=${version} node=${process.version} ` +
      `iterations=${ITERATIONS} warmup=${WARMUP_ITERATIONS} command=${COMMAND}`
  );

  // ONE session-scoped tmp dir: the fence's credential-mask covers live under
  // it, and it is the only host state this script creates.
  const fenceTmp = await mkdtemp(join(tmpdir(), "iknow-bash-roundtrip-"));
  try {
    const tool = createBashTool(repoRoot, {
      fsMode: createFsModeContext("workspace"),
      homeRoot: homedir(),
      workspaceRoot: repoRoot,
      tmpDir: fenceTmp,
    });

    const fenceNamespaceIsolated = await probeFenceNamespace(tool);

    // Warmup: JIT + page cache, outside the measured window.
    for (let i = 0; i < WARMUP_ITERATIONS; i++) await callBash(tool, COMMAND);

    const totalStart = performance.now();
    const samples = await measureLoop(tool, ITERATIONS);
    const totalMs = performance.now() - totalStart;

    console.log(buildReport(samples, totalMs, fenceNamespaceIsolated, version));
  } finally {
    await rm(fenceTmp, { recursive: true, force: true });
  }
}

void main().catch((err: unknown) => {
  console.error(
    `[bash-roundtrip-perf] fenced bash measurement failed: ${
      err instanceof Error ? err.message : String(err)
    }`
  );
  process.exit(1);
});
