/**
 * auto-memory T3: ingest pipeline — extract → ops → persist.
 *
 * Spec: specs/auto-memory.md D2/D4; ADR-0031 Decision 2/3/5.
 *
 * Three independent stages, deliberately not fused:
 *
 *   extractMemoryCandidates  LLM half — the only stage that needs a model.
 *   decideMemoryOps          pure half — BM25 neighbor + the decision table.
 *   persistMemoryOps         IO half  — the `memory_save` atomic write path.
 *
 * Keeping them apart is what makes the ops testable with a fake LLM and
 * the decision table testable with no model at all. The extraction prompt
 * lives here and nowhere else — the loop engine owns turn mechanics, not
 * memory semantics (ADR-0031 "why not alternatives").
 *
 * Everything auto-written carries `source: auto` in its frontmatter. That is
 * an unknown-extra field, round-tripped verbatim by parse/serialize, so no
 * schema version bump is involved.
 */
import { randomBytes as nodeRandomBytes } from "node:crypto";

import { scoreMemoryEntries } from "./bm25.js";
import { detectCapabilityObservation } from "./capability-gate.js";
import { MemoryExtractError } from "./errors.js";
import { runMemoryGc, type MemoryGcResult } from "./gc.js";
import { normalizeMemoryType } from "./schema.js";
import type { MemoryEntryV1 } from "./schema.js";
import { listStoreEntries, type StoredMemoryEntry } from "./store.js";
import { tokenize } from "./tokenize.js";
import {
  refreshMemoryIndexLine,
  upsertMemoryIndex,
  validateAffirmativePhrasing,
  writeMemoryEntryAtomic,
} from "./tools/save.js";

/** Provenance marker written into the frontmatter of every auto entry. */
export const AUTO_MEMORY_SOURCE = "auto";

/** At most this many candidates are taken from one extraction pass. */
export const MAX_CANDIDATES_PER_INGEST = 8;

/** Candidates the model is less sure of than this never reach the store. */
export const MIN_CANDIDATE_CONFIDENCE = 0.6;

/** Prompt-side cap so joined rules cannot drown the transcript. */
export const STATIC_LAYER_PROMPT_CAP = 24_000;

const MIN_IMPORTANCE = 1;
const MAX_IMPORTANCE = 5;

/**
 * Decision floors for the extraction decision table. Static heuristics with
 * no tuning evidence yet (ADR-0031 consequences) — they live together so a
 * future calibration ticket has one place to touch.
 */
/** Fraction of the candidate's title tokens the neighbor must also carry. */
const SAME_SUBJECT_FLOOR = 0.6;
/** Fraction of the candidate's tokens the neighbor must carry to be a duplicate. */
const NEAR_DUPLICATE_FLOOR = 0.5;
/** At or above this the candidate says nothing the neighbor does not. */
const RESTATEMENT_FLOOR = 0.9;

/**
 * Minimal LLM seam. The memory context deliberately does not depend on
 * `ModelAdapter`: extraction needs one prompt in and one string out, and a
 * narrow interface is what lets tests pass a three-line fake.
 */
export interface MemoryExtractLlm {
  readonly complete: (prompt: string, signal?: AbortSignal) => Promise<string>;
}

/** One atomic fact the model proposes keeping. */
export interface MemoryCandidate {
  readonly title: string;
  readonly body: string;
  readonly type: string;
  readonly importance: number;
  /**
   * Dream-only: existing slugs the model says this candidate supersedes.
   * Extraction never sets it — a candidate carrying `replaces` is routed to
   * a SUPERSEDE op by the dream path, never through the decide table.
   */
  readonly replaces?: readonly string[];
}

export type MemoryOpKind = "ADD" | "UPDATE" | "SUPERSEDE" | "NOOP";

/** The write decision (ADR-0031 Decision 2). Extraction emits ADD/UPDATE/NOOP;
 * SUPERSEDE stays a valid kind for the dream merge path. */
export type MemoryOp =
  | { readonly kind: "ADD"; readonly candidate: MemoryCandidate }
  | {
      readonly kind: "UPDATE";
      readonly slug: string;
      readonly candidate: MemoryCandidate;
      /** The stored entry's ttl_days, carried over so UPDATE cannot clobber it. */
      readonly ttlDays?: number;
    }
  | {
      readonly kind: "SUPERSEDE";
      readonly supersedes: string[];
      readonly candidate: MemoryCandidate;
    }
  | {
      readonly kind: "NOOP";
      readonly slug: string;
      readonly candidate: MemoryCandidate;
      readonly reason: string;
    };

export interface PersistedMemoryOp {
  readonly slug: string;
  readonly kind: MemoryOpKind;
}

export interface MemoryPersistDeps {
  /** ISO-8601 timestamp for updated_at; defaults to the real clock. */
  readonly now?: () => string;
  /** 6 bytes hex = 12-char slug; defaults to node:crypto randomBytes. */
  readonly randomBytes?: (n: number) => Buffer;
  /** TTL stamped on newly written auto entries; 0 (default) = never expires. */
  readonly ttlDays?: number;
  /** Provenance marker for the write path; defaults to `source: auto`. */
  readonly source?: string;
}

export interface MemoryIngestOptions extends MemoryPersistDeps {
  readonly memoryDir: string;
  /** The conversation slice to mine. Blank input short-circuits with no LLM call. */
  readonly transcript: string;
  readonly llm: MemoryExtractLlm;
  /** User + project AGENTS.md / rules text. Absent or blank = prompt without that block. */
  readonly staticLayer?: string;
  readonly signal?: AbortSignal;
  /** Reference time for the post-write GC pass. */
  readonly nowMs?: number;
  /** Active-entry ceiling handed to GC. */
  readonly cap?: number;
  /** Run mechanical GC after persisting. Default true. */
  readonly gc?: boolean;
}

export interface MemoryIngestResult {
  readonly ops: ReadonlyArray<MemoryOp>;
  readonly written: ReadonlyArray<PersistedMemoryOp>;
  /** Absent when `gc: false` or when nothing was written. */
  readonly gc?: MemoryGcResult;
}

// -- stage 1: extract --------------------------------------------------------

/**
 * The extraction prompt. Kept in the memory context so the loop engine never
 * carries memory semantics, and exported so a review can read the exact text
 * the model sees.
 */
export function buildExtractPrompt(
  transcript: string,
  staticLayer = ""
): string {
  const layer = clipStaticLayer(staticLayer.trim());
  return [
    "You are mining a finished coding session for facts worth keeping across future sessions.",
    "",
    "Keep only broadly-applicable knowledge: project conventions, architectural decisions,",
    "gotchas, and hard constraints. Never keep per-task state (what was edited this session,",
    "what the user asked for today, transient file paths, or debugging chatter).",
    "",
    "Never output a candidate that repeats or paraphrases the project or user instruction files already loaded in every session.",
    "Never keep what the repository itself shows: architecture, file paths, or fixes already merged.",
    "Keep corrections the user made to your work, and preferences the user explicitly confirmed.",
    "Include keywords in the conversation's own language — when the conversation is not in English, carry its key terms verbatim in the candidate's title or body so lexical recall can match.",
    "",
    "Write every fact in affirmative phrasing — state what to do, not what to avoid.",
    "Prohibitions belong in the permission policy, not in memory. A candidate phrased as a",
    'prohibition ("never X", "don\'t X") will be discarded.',
    "",
    "Reply with a JSON array and nothing else. Each element:",
    '  { "title": string, "body": string, "type": string, "importance": 1-5, "confidence": 0-1 }',
    "Reply with [] when the session contains no such fact.",
    "",
    ...(layer.length > 0
      ? [
          "--- project and user instructions (already loaded; do not re-output) ---",
          layer,
          "--- end instructions ---",
          "",
        ]
      : []),
    "--- session transcript ---",
    transcript,
    "--- end transcript ---",
  ].join("\n");
}

function clipStaticLayer(layer: string): string {
  if (layer.length <= STATIC_LAYER_PROMPT_CAP) return layer;
  const dropped = layer.length - STATIC_LAYER_PROMPT_CAP;
  return `${layer.slice(0, STATIC_LAYER_PROMPT_CAP)}[truncated ${dropped} chars]`;
}

/**
 * Run one extraction pass and return the candidates that survive the gates:
 * affirmative phrasing, minimum confidence, non-empty title/body, importance
 * clamped to 1..5, batch capped at MAX_CANDIDATES_PER_INGEST.
 *
 * A blank transcript short-circuits without spending an LLM call. Transport
 * failures and unparseable output both surface as `MemoryExtractError` so the
 * host has exactly one error type to swallow.
 */
export async function extractMemoryCandidates(
  transcript: string,
  llm: MemoryExtractLlm,
  signal?: AbortSignal,
  staticLayer?: string
): Promise<ReadonlyArray<MemoryCandidate>> {
  if (transcript.trim().length === 0) return [];

  let raw: string;
  try {
    raw = await llm.complete(
      buildExtractPrompt(transcript, staticLayer ?? ""),
      signal
    );
  } catch (error) {
    throw new MemoryExtractError("memory ingest: extraction call failed", {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch (error) {
    throw new MemoryExtractError(
      "memory ingest: extraction output is not JSON",
      { cause: error }
    );
  }
  if (!Array.isArray(parsed)) {
    throw new MemoryExtractError(
      "memory ingest: extraction output is not a JSON array"
    );
  }

  const out: MemoryCandidate[] = [];
  for (const raw of parsed) {
    const candidate = toCandidate(raw);
    if (candidate === null) continue;
    out.push(candidate);
    if (out.length === MAX_CANDIDATES_PER_INGEST) break;
  }
  return out;
}

/** At or above this, the candidate restates one static-layer chunk. */
export const STATIC_LAYER_OVERLAP_FLOOR = 0.9;
const STATIC_LAYER_CHUNK_TOKEN_CAP = 80;

/**
 * Drop extract candidates that restate AGENTS.md / rules, before the
 * four-state table. Pure: no IO, no model.
 *
 * Overlap is scored per paragraph (large paragraphs split into token
 * windows) so a long instruction file cannot saturate containment.
 * Empty static layer: leave every candidate. Empty candidate tokens: drop
 * only when the layer itself has tokens.
 */
export function dropOverlappingStaticLayer(
  candidates: ReadonlyArray<MemoryCandidate>,
  staticLayer: string
): ReadonlyArray<MemoryCandidate> {
  const chunks = layerChunks(staticLayer);
  if (chunks.length === 0) return candidates;
  return candidates.filter((candidate) => {
    const candTokens = tokens(`${candidate.title} ${candidate.body}`);
    if (candTokens.size === 0) return false;
    return !chunks.some(
      (chunk) => containment(candTokens, chunk) >= STATIC_LAYER_OVERLAP_FLOOR
    );
  });
}

function layerChunks(staticLayer: string): ReadonlyArray<ReadonlySet<string>> {
  const out: Array<ReadonlySet<string>> = [];
  for (const para of staticLayer.split(/\n\n+/)) {
    const seq = tokenize(para);
    if (seq.length === 0) continue;
    if (seq.length <= STATIC_LAYER_CHUNK_TOKEN_CAP) {
      out.push(new Set(seq));
      continue;
    }
    for (let i = 0; i < seq.length; i += STATIC_LAYER_CHUNK_TOKEN_CAP) {
      out.push(new Set(seq.slice(i, i + STATIC_LAYER_CHUNK_TOKEN_CAP)));
    }
  }
  return out;
}

// -- stage 2: decide ---------------------------------------------------------

/**
 * Map candidates onto the extraction decision table against the live store.
 * Pure: no IO, no clock read, no model.
 *
 * The nearest neighbor comes from the existing BM25-lite ranking; the verdict
 * then comes from bounded token-containment ratios, because BM25 scores are
 * unbounded and cannot carry a stable threshold.
 *
 * Extraction is conservative by design: ADD / UPDATE / NOOP only. SUPERSEDE
 * is never produced here — replacement of an entry is the dream path's job.
 */
export function decideMemoryOps(
  candidates: ReadonlyArray<MemoryCandidate>,
  existing: ReadonlyArray<StoredMemoryEntry>
): ReadonlyArray<MemoryOp> {
  const live = existing.filter((e) => !e.entry.disabled);
  return candidates.map((candidate) => decideOne(candidate, live));
}

function decideOne(
  candidate: MemoryCandidate,
  live: ReadonlyArray<StoredMemoryEntry>
): MemoryOp {
  const neighbor = nearestNeighbor(candidate, live);
  if (neighbor === null) return { kind: "ADD", candidate };

  const subject = containment(
    tokens(candidate.title),
    tokens(neighbor.entry.title)
  );
  const covered = containment(
    tokens(`${candidate.title} ${candidate.body}`),
    tokens(`${neighbor.entry.title} ${neighbor.entry.body}`)
  );

  if (subject < SAME_SUBJECT_FLOOR && covered < NEAR_DUPLICATE_FLOOR) {
    return { kind: "ADD", candidate };
  }
  if (covered >= RESTATEMENT_FLOOR) {
    return {
      kind: "NOOP",
      slug: neighbor.slug,
      candidate,
      reason: "restates a stored entry",
    };
  }
  return {
    kind: "UPDATE",
    slug: neighbor.slug,
    candidate,
    ttlDays: neighbor.entry.ttl_days,
  };
}

/** Highest BM25-lite hit, or null when the store has no live entry. */
function nearestNeighbor(
  candidate: MemoryCandidate,
  live: ReadonlyArray<StoredMemoryEntry>
): StoredMemoryEntry | null {
  if (live.length === 0) return null;
  const candidateTokens = tokenize(`${candidate.title} ${candidate.body}`);
  if (candidateTokens.length === 0) return null;
  const tokenizedLive = live.filter(
    (entry) => tokenize(`${entry.entry.title} ${entry.entry.body}`).length > 0
  );
  if (tokenizedLive.length === 0) return null;
  const scored = scoreMemoryEntries(
    `${candidate.title} ${candidate.body}`,
    tokenizedLive.map((e) => e.entry)
  );
  const top = scored[0];
  return top === undefined ? null : (tokenizedLive[top.index] ?? null);
}

// -- stage 3: persist --------------------------------------------------------

/**
 * Apply ops through the `memory_save` write path. Returns what landed; NOOPs
 * return nothing.
 *
 * The affirmative-phrasing gate runs here as well as at extract, ahead of any
 * disk mutation: the write path is the trust boundary, and a hand-built op
 * must not be able to smuggle a prohibition past a gate that only guarded the
 * model's output.
 *
 * The runtime capability gate also runs here (ADR-0086), but drops the op
 * instead of throwing: an extract / dream candidate is model output, and one
 * unusable candidate must not cost the user turn or the sibling writes.
 */
export async function persistMemoryOps(
  memoryDir: string,
  ops: ReadonlyArray<MemoryOp>,
  deps?: MemoryPersistDeps
): Promise<ReadonlyArray<PersistedMemoryOp>> {
  const now = deps?.now ?? (() => new Date().toISOString());
  const random = deps?.randomBytes ?? ((n: number) => nodeRandomBytes(n));
  const ttlDays = deps?.ttlDays ?? 0;

  for (const op of ops) {
    if (op.kind === "NOOP") continue;
    const reason = validateAffirmativePhrasing(
      op.candidate.title,
      op.candidate.body
    );
    if (reason !== null) {
      throw new MemoryExtractError(
        `memory ingest: rejected: negative_form — ${reason}`
      );
    }
  }

  const written: PersistedMemoryOp[] = [];
  for (const op of ops) {
    if (mustNotPersist(op)) continue;
    const slug = op.kind === "UPDATE" ? op.slug : random(6).toString("hex");
    // UPDATE preserves the neighbor's stored ttl_days (the candidate carries
    // no TTL of its own); a hand-built UPDATE without one falls back to deps.
    const opTtlDays = op.kind === "UPDATE" ? (op.ttlDays ?? ttlDays) : ttlDays;
    const entry = buildEntry({
      slug,
      candidate: op.candidate,
      updatedAt: now(),
      ttlDays: opTtlDays,
      source: deps?.source ?? AUTO_MEMORY_SOURCE,
      supersedes: op.kind === "SUPERSEDE" ? op.supersedes : null,
    });
    // The index row is rendered from what the writer stored (folded there, at
    // the one choke point every writer shares), so a candidate title carrying
    // newlines cannot orphan a second MEMORY.md row.
    const stored = await writeMemoryEntryAtomic(memoryDir, slug, entry);
    // ADD / SUPERSEDE append a row; UPDATE rewrites the slug's existing row so
    // the title in the index matches the stored entry (SC10).
    await (op.kind === "UPDATE"
      ? refreshMemoryIndexLine(memoryDir, slug, stored)
      : upsertMemoryIndex(memoryDir, slug, stored));
    written.push({ slug, kind: op.kind });
  }
  return written;
}

/**
 * True when the op must not reach disk, for either reason:
 *   - NOOP — the decide table already chose not to write it;
 *   - runtime capability / environment-availability observation
 *     (runtime-capability-memory-gate T2 / ADR-0086) — dropped here rather
 *     than thrown, because the caller is a background pass (extract / dream)
 *     and one bad candidate must not fail the user turn or block its
 *     siblings. Same predicate as the `memory_save` gate, so a hand-built op
 *     cannot smuggle what the tool refuses.
 */
function mustNotPersist(op: MemoryOp): boolean {
  if (op.kind === "NOOP") return true;
  return (
    detectCapabilityObservation({
      title: op.candidate.title,
      body: op.candidate.body,
    }) !== null
  );
}

function buildEntry(input: {
  slug: string;
  candidate: MemoryCandidate;
  updatedAt: string;
  ttlDays: number;
  source: string;
  supersedes: string[] | null;
}): MemoryEntryV1 {
  const entry: MemoryEntryV1 & { source: string } = {
    id: input.slug,
    type: input.candidate.type,
    importance: input.candidate.importance,
    ttl_days: input.ttlDays,
    disabled: false,
    supersedes: input.supersedes,
    title: input.candidate.title,
    body: input.candidate.body,
    updated_at: input.updatedAt,
    source: input.source,
  };
  return entry;
}

// -- orchestrator ------------------------------------------------------------

/**
 * One ingest pass: read the store, extract, decide, persist, then run
 * mechanical GC so ttl evictions and the active-entry cap are applied.
 *
 * Errors are typed and propagate: the caller — the host wire, ADR-0031
 * Decision 5 — is the layer that decides to swallow them, not this one.
 */
export async function ingestMemory(
  opts: MemoryIngestOptions
): Promise<MemoryIngestResult> {
  const extracted = await extractMemoryCandidates(
    opts.transcript,
    opts.llm,
    opts.signal,
    opts.staticLayer
  );
  const candidates = dropOverlappingStaticLayer(
    extracted,
    opts.staticLayer ?? ""
  );
  if (candidates.length === 0) return { ops: [], written: [] };

  const scan = await listStoreEntries(opts.memoryDir);
  const ops = decideMemoryOps(candidates, scan.entries);
  const written = await persistMemoryOps(opts.memoryDir, ops, {
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.randomBytes ? { randomBytes: opts.randomBytes } : {}),
    ...(opts.ttlDays !== undefined ? { ttlDays: opts.ttlDays } : {}),
    ...(opts.source !== undefined ? { source: opts.source } : {}),
  });
  if (written.length === 0 || opts.gc === false) return { ops, written };

  const gc = await runMemoryGc(opts.memoryDir, {
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
    ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
  });
  return { ops, written, gc };
}

// -- helpers (not exported; index.ts re-export policy) -----------------------

/** Unwrap a ```json fenced block; return the input unchanged when unfenced. */
function stripCodeFence(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  return (fenced?.[1] ?? raw).trim();
}

/** Validate + normalize one raw candidate; null when it fails a gate. */
function toCandidate(raw: unknown): MemoryCandidate | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  const body = typeof o.body === "string" ? o.body.trim() : "";
  if (title.length === 0 || body.length === 0) return null;

  // Absent confidence reads as certain: an extractor that omits the field is
  // not thereby less trustworthy than one that reports 1.0.
  const confidence = typeof o.confidence === "number" ? o.confidence : 1;
  if (confidence < MIN_CANDIDATE_CONFIDENCE) return null;

  if (validateAffirmativePhrasing(title, body) !== null) return null;

  // Closed enum (#731): the model is free to invent a label, but only the
  // five legal values survive; anything else lands as `note`.
  const type = normalizeMemoryType(o.type);
  return { title, body, type, importance: clampImportance(o.importance) };
}

function clampImportance(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return MIN_IMPORTANCE;
  }
  return Math.min(MAX_IMPORTANCE, Math.max(MIN_IMPORTANCE, Math.round(value)));
}

/** Token set used by four-state neighbor rules and static-layer overlap. */
function tokens(s: string): ReadonlySet<string> {
  return new Set(tokenize(s));
}

/**
 * Fraction of `a` that `b` also contains, in [0, 1]. Directional on purpose:
 * four-state asks how much of the candidate is already stored; the static
 * overlap gate asks how much of the candidate restates one instruction chunk.
 */
function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0) return 0;
  let hits = 0;
  for (const t of a) if (b.has(t)) hits++;
  return hits / a.size;
}
