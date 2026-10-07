/**
 * Evidence completeness: independent tally, explicit failure states, and the hash index.
 *
 * Why it exists (issue 1219 requirement 4): `tally.py` resolved every `{sha,bytes}`
 * reference against disk and verified BOTH the sha256 and the byte length — that part was
 * right and is kept. What it lacked was the notion of FAILURE: parse failures, missing
 * blobs and broken references all rolled up into counts a reader could mistake for
 * completeness. Here each of those is an explicit `evidence_status: failed` with a code.
 *
 * Three separations this module enforces, because conflating them is what made the #1212
 * pilot row self-contradictory (`EXCLUDE:oracle-or-grader` beside `reward=1`):
 *  1. Evidence status is derived from retained artifacts, never from a claim elsewhere.
 *  2. The task/grader outcome is reported separately and is never read to excuse evidence.
 *  3. Zero broken references proves the integrity of what WAS retained, never that nothing
 *     was lost whole — so the assessment carries that caveat explicitly.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  type Dirent,
} from "node:fs";
import { join } from "node:path";

import { writeFileFsync } from "./ledger.js";

/** Bumped when the tally shape changes, so a stale tally.json cannot be mistaken for this one. */
export const TALLY_SCHEMA_VERSION = 1;

export interface Tally {
  readonly schema_version: number;
  readonly attempt_dir: string;
  readonly trace_files: number;
  /**
   * False when the whole `trace/` directory is absent. Distinct from `trace_files: 0`:
   * an attempt that retained no traces lost nothing it can prove, whereas a missing
   * directory may mean the record was lost whole.
   */
  readonly trace_dir_present: boolean;
  readonly parse_failures: number;
  readonly record_census: Readonly<Record<string, number>>;
  readonly tokens: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_creation_input_tokens: number;
    readonly cache_read_input_tokens: number;
  };
  readonly llm_calls: {
    readonly total: number;
    readonly status_ok: number;
    readonly without_dispatch_evidence: number;
    readonly referenced_by_a_turn: number;
  };
  readonly tool_calls: {
    readonly total: number;
    readonly status_histogram: Readonly<Record<string, number>>;
    readonly result_captured_true: number;
    readonly referenced_by_a_turn: number;
  };
  readonly evidence: {
    readonly refs_distinct: number;
    readonly resolved_sha_and_bytes: number;
    readonly broken: number;
    readonly missing_on_disk: number;
    readonly missing_sample: ReadonlyArray<string>;
    readonly blobs_on_disk: number;
    readonly orphan_blobs: number;
  };
}

/** A `{sha, bytes}` blob reference found anywhere inside a trace record. */
interface BlobRef {
  readonly sha: string;
  readonly bytes: number;
}

function walkRefs(node: unknown, out: BlobRef[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walkRefs(item, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (typeof record.sha === "string" && typeof record.bytes === "number") {
    out.push({ sha: record.sha, bytes: record.bytes });
  }
  for (const value of Object.values(record)) walkRefs(value, out);
}

function emptyTokens(): Record<string, number> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

/** Accumulators for one trace file; kept as a plain object so the loop stays readable. */
interface TallyAccumulators {
  census: Record<string, number>;
  tokens: Record<string, number>;
  llmTotal: number;
  llmOk: number;
  llmWithoutDispatch: number;
  turnLlmIds: Set<string>;
  toolIds: Set<string>;
  turnToolIds: Set<string>;
  toolTotal: number;
  toolStatuses: Record<string, number>;
  toolResultsCaptured: number;
  parseFailures: number;
  refs: BlobRef[];
}

function newAccumulators(): TallyAccumulators {
  return {
    census: {},
    tokens: emptyTokens(),
    llmTotal: 0,
    llmOk: 0,
    llmWithoutDispatch: 0,
    turnLlmIds: new Set(),
    toolIds: new Set(),
    turnToolIds: new Set(),
    toolTotal: 0,
    toolStatuses: {},
    toolResultsCaptured: 0,
    parseFailures: 0,
    refs: [],
  };
}

/** Fold one parsed trace record into the accumulators, keyed on `record_type`. */
function accumulate(
  record: Record<string, unknown>,
  acc: TallyAccumulators
): void {
  const type =
    typeof record.record_type === "string" ? record.record_type : "unknown";
  acc.census[type] = (acc.census[type] ?? 0) + 1;
  if (type === "llm_call") accumulateLlmCall(record, acc);
  else if (type === "turn") accumulateTurn(record, acc);
  else if (type === "tool_call") accumulateToolCall(record, acc);
  walkRefs(record, acc.refs);
}

function accumulateLlmCall(
  record: Record<string, unknown>,
  acc: TallyAccumulators
): void {
  acc.llmTotal += 1;
  if (record.status === "ok") acc.llmOk += 1;
  if (!record.dispatch_evidence) acc.llmWithoutDispatch += 1;
  for (const key of Object.keys(acc.tokens)) {
    const value = record[key];
    if (typeof value === "number")
      acc.tokens[key] = (acc.tokens[key] ?? 0) + value;
  }
}

function accumulateTurn(
  record: Record<string, unknown>,
  acc: TallyAccumulators
): void {
  for (const id of stringArray(record.llm_call_ids)) acc.turnLlmIds.add(id);
  for (const id of stringArray(record.tool_call_ids)) acc.turnToolIds.add(id);
}

function accumulateToolCall(
  record: Record<string, unknown>,
  acc: TallyAccumulators
): void {
  acc.toolTotal += 1;
  if (typeof record.tool_call_id === "string")
    acc.toolIds.add(record.tool_call_id);
  const status = typeof record.status === "string" ? record.status : "unknown";
  acc.toolStatuses[status] = (acc.toolStatuses[status] ?? 0) + 1;
  if (record.result_captured === true) acc.toolResultsCaptured += 1;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Resolve distinct references against what is actually on disk, verifying sha AND bytes. */
function resolveEvidence(acc: TallyAccumulators, blobDir: string) {
  const distinct = new Map<string, BlobRef>();
  for (const ref of acc.refs) distinct.set(`${ref.sha}:${ref.bytes}`, ref);
  let resolved = 0;
  let broken = 0;
  const missingSample: string[] = [];
  for (const ref of distinct.values()) {
    const path = join(blobDir, ref.sha);
    let body: Buffer;
    try {
      body = readFileSync(path);
    } catch {
      missingSample.push(ref.sha.slice(0, 12));
      continue;
    }
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== ref.sha || body.length !== ref.bytes) broken += 1;
    else resolved += 1;
  }
  const onDisk = safeReaddir(blobDir).filter((e) => e.isFile());
  const referenced = new Set([...distinct.values()].map((ref) => ref.sha));
  return {
    refs_distinct: distinct.size,
    resolved_sha_and_bytes: resolved,
    broken,
    missing_on_disk: missingSample.length,
    missing_sample: missingSample.slice(0, 10),
    blobs_on_disk: onDisk.length,
    orphan_blobs: onDisk.filter((entry) => !referenced.has(entry.name)).length,
  };
}

/** List a directory, treating an absent one as empty rather than as a crash. */
function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Tally one attempt directory. Pure with respect to the attempt: it only reads.
 *
 * An absent `trace/` directory tallies to zero rather than throwing: a throw here was
 * indistinguishable from a tally that never ran, and both got reported as a success.
 */
export function tallyAttempt(attemptDir: string): Tally {
  const traceDir = join(attemptDir, "trace");
  const blobDir = join(traceDir, "blobs");
  const acc = newAccumulators();
  const traceDirPresent = existsSync(traceDir);
  const traceFiles = safeReaddir(traceDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(traceDir, entry.name))
    .sort();

  for (const file of traceFiles) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Counted, never silently dropped: an unparseable line is lost evidence.
        acc.parseFailures += 1;
        continue;
      }
      if (parsed !== null && typeof parsed === "object") {
        accumulate(parsed as Record<string, unknown>, acc);
      }
    }
  }

  const linkedTools = [...acc.turnToolIds].filter((id) => acc.toolIds.has(id));
  return {
    schema_version: TALLY_SCHEMA_VERSION,
    attempt_dir: attemptDir,
    trace_files: traceFiles.length,
    trace_dir_present: traceDirPresent,
    parse_failures: acc.parseFailures,
    record_census: acc.census,
    tokens: acc.tokens as Tally["tokens"],
    llm_calls: {
      total: acc.llmTotal,
      status_ok: acc.llmOk,
      without_dispatch_evidence: acc.llmWithoutDispatch,
      referenced_by_a_turn: [...acc.turnLlmIds].length,
    },
    tool_calls: {
      total: acc.toolTotal,
      status_histogram: acc.toolStatuses,
      result_captured_true: acc.toolResultsCaptured,
      referenced_by_a_turn: linkedTools.length,
    },
    evidence: resolveEvidence(acc, blobDir),
  };
}

export type EvidenceFailureCode =
  | "tally-failed"
  | "zero-traces"
  | "unknown-expectation"
  | "parse-failure"
  | "missing-blob"
  | "broken-reference";

export interface EvidenceFailure {
  readonly code: EvidenceFailureCode;
  readonly detail: string;
}

export interface EvidenceAssessment {
  readonly status: "complete" | "failed";
  readonly failures: ReadonlyArray<EvidenceFailure>;
  /** The task/grader outcome, reported independently of the evidence status. */
  readonly outcome: { readonly reward: string; readonly graderExit: number };
  /** Why zero broken references is not a completeness claim. */
  readonly integrityOnlyNote: string;
}

const INTEGRITY_NOTE =
  "Zero broken references proves the integrity of retained references; it does not prove " +
  "the absence of lost whole records, because a whole record lost takes its references " +
  "with it and leaves nothing to break.";

/** What the caller observed: either a tally, or the fact that the tally itself failed. */
export type TallyOutcome =
  | { readonly kind: "tally"; readonly tally: Tally }
  | { readonly kind: "tally-failed"; readonly message: string };

export interface AssessmentInput {
  readonly reward: string;
  readonly graderExit: number;
  /** How many trace files the attempt was expected to retain; `null` when unknowable. */
  readonly expectedTraces: number | null;
}

function tallyFailures(
  tally: Tally,
  expectedTraces: number | null
): EvidenceFailure[] {
  const failures: EvidenceFailure[] = [];
  if (expectedTraces === null) {
    failures.push({
      code: "unknown-expectation",
      detail: "expected trace count was not recorded",
    });
  } else if (tally.trace_files < expectedTraces) {
    failures.push({
      code: "zero-traces",
      detail: `retained ${tally.trace_files} trace file(s), expected ${expectedTraces}`,
    });
  }
  if (tally.parse_failures > 0) {
    failures.push({
      code: "parse-failure",
      detail: `${tally.parse_failures} unparseable trace line(s)`,
    });
  }
  if (tally.evidence.missing_on_disk > 0) {
    failures.push({
      code: "missing-blob",
      detail: `${tally.evidence.missing_on_disk} referenced blob(s) absent from disk`,
    });
  }
  if (tally.evidence.broken > 0) {
    failures.push({
      code: "broken-reference",
      detail: `${tally.evidence.broken} reference(s) failed sha256 or byte-length verification`,
    });
  }
  return failures;
}

/**
 * Turn a tally (or a tally failure) into an explicit evidence status. The task outcome is
 * carried through unchanged: reward=1 beside a failed evidence status is a real finding.
 */
export function assessEvidence(
  outcome: TallyOutcome,
  input: AssessmentInput
): EvidenceAssessment {
  const base = {
    outcome: { reward: input.reward, graderExit: input.graderExit },
    integrityOnlyNote: INTEGRITY_NOTE,
  };
  if (outcome.kind === "tally-failed") {
    return {
      ...base,
      status: "failed",
      failures: [{ code: "tally-failed", detail: outcome.message }],
    };
  }
  const failures = tallyFailures(outcome.tally, input.expectedTraces);
  return {
    ...base,
    status: failures.length === 0 ? "complete" : "failed",
    failures,
  };
}

export interface HashIndexPayload {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface HashIndex {
  readonly indexVersion: 1;
  readonly dir: string;
  readonly payloads: ReadonlyArray<HashIndexPayload>;
}

const INDEX_NAME = "hash-index.json";

/**
 * Build the payload list for a directory.
 *
 * The index excludes ITSELF and any temporary index file: indexing a half-written index
 * would make the index self-referential and unverifiable, which is how a hash index stops
 * proving anything.
 */
export function buildHashIndex(dir: string): HashIndex {
  const payloads = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name !== INDEX_NAME && !name.startsWith(`${INDEX_NAME}.`))
    .sort()
    .map((name) => {
      const body = readFileSync(join(dir, name));
      return {
        path: name,
        sha256: createHash("sha256").update(body).digest("hex"),
        bytes: body.length,
      };
    });
  return { indexVersion: 1, dir, payloads };
}

/**
 * Write the hash index atomically: payloads are finalized first, then the index is fsynced
 * to a temp name and renamed into place, so a reader never observes a partial index.
 */
export function writeHashIndex(dir: string): string {
  const index = buildHashIndex(dir);
  const finalPath = join(dir, INDEX_NAME);
  const tempPath = join(dir, `${INDEX_NAME}.tmp`);
  writeFileFsync(tempPath, `${JSON.stringify(index, null, 2)}\n`);
  renameSync(tempPath, finalPath);
  return finalPath;
}

export interface HashIndexMismatch {
  readonly path: string;
  readonly problem: "missing" | "size" | "digest";
}

export interface HashIndexVerification {
  readonly ok: boolean;
  readonly checked: number;
  readonly mismatches: ReadonlyArray<HashIndexMismatch>;
}

/** Verify every payload's digest AND byte length on readback. */
export function verifyHashIndex(indexPath: string): HashIndexVerification {
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as HashIndex;
  const mismatches: HashIndexMismatch[] = [];
  for (const payload of index.payloads) {
    const path = join(index.dir, payload.path);
    let body: Buffer;
    try {
      body = readFileSync(path);
    } catch {
      mismatches.push({ path: payload.path, problem: "missing" });
      continue;
    }
    if (body.length !== payload.bytes) {
      mismatches.push({ path: payload.path, problem: "size" });
      continue;
    }
    if (createHash("sha256").update(body).digest("hex") !== payload.sha256) {
      mismatches.push({ path: payload.path, problem: "digest" });
    }
  }
  return {
    ok: mismatches.length === 0,
    checked: index.payloads.length,
    mismatches,
  };
}

/** True when a path is a directory that exists; used by callers before a tally. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
