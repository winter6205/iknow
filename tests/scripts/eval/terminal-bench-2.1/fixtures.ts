/**
 * Shared fixture builders for the terminal-bench-2.1 headless eval tests.
 *
 * Why this exists: every required regression in this suite is about what the tooling
 * does with REAL files on disk — stale records, partially written JSONL, fsynced
 * `started` records left by a killed child. Hand-rolled inline fixtures in ten test
 * files would drift from each other, so the one place that builds a run identity, an
 * attempt directory or a trace lives here and is shared.
 *
 * This file is NOT a test file (no `.test.ts` suffix), so vitest never collects it.
 * It contains no credentials and no settings contents by construction: settings are
 * always represented by a sha256 string, never by a body.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RunIdentity } from "../../../../scripts/eval/terminal-bench-2.1/identities.ts";

const roots: string[] = [];

/**
 * Create a temp directory that `cleanupTempRoots` will remove. The basename is part
 * of the directory name so a leaked temp dir is still attributable to a test file.
 */
export function tempRoot(basename: string): string {
  const root = mkdtempSync(join(tmpdir(), `iknow-${basename}-`));
  roots.push(root);
  return root;
}

/** Remove every temp root created by `tempRoot` in this process. */
export function cleanupTempRoots(): void {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A complete, non-placeholder run identity. Tests override single fields to go stale. */
export function identityFor(overrides: Partial<RunIdentity> = {}): RunIdentity {
  return {
    runId: "run-1219",
    task: "db-wal-recovery",
    image: "python:3.11-slim",
    imageDigest: "sha256:aaa111",
    datasetCommit: "7131e4375048a0e408a8fb404b5f499d726b695b",
    bundleSha256:
      "1525d540457b0cb5a68535890eb2960319fcb4a25126c62b51273954ac1b27e7",
    nodeArchiveSha256:
      "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    runnerVersion: "tb2.1-attempt/1",
    outputLayout: "trace/ logs/ process/ meta/",
    ...overrides,
  };
}

export interface AttemptDirOptions {
  /** Reward text written to logs/verifier/reward.txt; omit to leave the file absent. */
  reward?: string;
  /** Bytes written to logs/verifier/ctrf.json; omit to leave the file absent. */
  ctrfBytes?: number;
  /** Grader stdout; drives result-line and network-marker extraction. */
  graderLog?: string;
  /** ask.stderr content, including the stop envelope JSON line when present. */
  askStderr?: string;
}

/**
 * Build an attempt output directory in the real on-disk layout the runner uses.
 * Sub-directories are created eagerly so evidence code can walk them safely.
 */
export function makeAttemptDir(
  root: string,
  options: AttemptDirOptions = {}
): string {
  const dir = join(root, "attempt-1");
  for (const sub of ["trace/blobs", "logs/verifier", "process", "meta"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  if (options.reward !== undefined) {
    writeFileSync(join(dir, "logs/verifier/reward.txt"), options.reward);
  }
  if (options.ctrfBytes !== undefined) {
    writeFileSync(
      join(dir, "logs/verifier/ctrf.json"),
      "x".repeat(options.ctrfBytes)
    );
  }
  if (options.graderLog !== undefined) {
    writeFileSync(join(dir, "process/grader.log"), options.graderLog);
  }
  if (options.askStderr !== undefined) {
    writeFileSync(join(dir, "process/ask.stderr"), options.askStderr);
  }
  return dir;
}

export interface TraceRecordSeed {
  recordType: "session" | "llm_call" | "turn" | "tool_call";
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  llmCallId?: string;
  toolCallId?: string;
  status?: string;
  resultCaptured?: boolean;
  refs?: ReadonlyArray<{ sha: string; bytes: number }>;
}

/** Write one JSONL line per seed record into `<attemptDir>/trace/<name>.jsonl`. */
export function writeTrace(
  attemptDir: string,
  name: string,
  records: TraceRecordSeed[]
): void {
  const lines = records.map((seed) => JSON.stringify(seedToRecord(seed)));
  writeFileSync(
    join(attemptDir, "trace", `${name}.jsonl`),
    `${lines.join("\n")}\n`
  );
}

/** Write a blob whose real sha256/byte length match the reference the trace will cite. */
export function writeBlob(
  attemptDir: string,
  content: string,
  sha: string
): void {
  writeFileSync(join(attemptDir, "trace/blobs", sha), content);
}

/** The four token counters a real `llm_call` record carries. */
const TOKEN_KEYS = [
  ["input_tokens", "inputTokens"],
  ["output_tokens", "outputTokens"],
  ["cache_creation_input_tokens", "cacheCreationInputTokens"],
  ["cache_read_input_tokens", "cacheReadInputTokens"],
] as const;

/** Assign `key` only when the seed set it, so an absent counter stays absent on disk. */
function setIfDefined(
  record: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  if (value !== undefined) record[key] = value;
}

function seedToRecord(seed: TraceRecordSeed): Record<string, unknown> {
  const record: Record<string, unknown> = { record_type: seed.recordType };
  setIfDefined(record, "status", seed.status);
  setIfDefined(record, "llm_call_id", seed.llmCallId);
  setIfDefined(record, "tool_call_id", seed.toolCallId);
  setIfDefined(record, "result_captured", seed.resultCaptured);
  for (const [key, field] of TOKEN_KEYS) setIfDefined(record, key, seed[field]);
  if (seed.refs !== undefined)
    record.refs = seed.refs.map((ref) => ({ ...ref }));
  if (seed.recordType === "turn") {
    record.llm_call_ids = seed.llmCallId ? [seed.llmCallId] : [];
    record.tool_call_ids = seed.toolCallId ? [seed.toolCallId] : [];
  }
  return record;
}

/** Write raw (possibly malformed) JSONL, for parse-failure coverage. */
export function writeRawTrace(
  attemptDir: string,
  name: string,
  body: string
): void {
  mkdirSync(dirname(join(attemptDir, "trace", `${name}.jsonl`)), {
    recursive: true,
  });
  writeFileSync(join(attemptDir, "trace", `${name}.jsonl`), body);
}

/** The grader output shape the real tasks emit: a real result line, no network marker. */
export const PASSING_GRADER_LOG =
  "Running tests\n7 passed in 4.20s\nreward written\n";
