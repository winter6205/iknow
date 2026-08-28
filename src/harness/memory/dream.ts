/**
 * Auto-memory T4: offline LLM merge pass.
 *
 * Dream is deliberately separate from `gc.ts`: it proposes candidates through
 * the same four-state decision and atomic save path as extraction, while GC
 * remains a model-free mechanical pass.
 */
import { MemoryExtractError } from "./errors.js";
import {
  decideMemoryOps,
  persistMemoryOps,
  type MemoryCandidate,
  type MemoryExtractLlm,
  type MemoryOp,
  type MemoryPersistDeps,
  type PersistedMemoryOp,
} from "./ingest.js";
import { normalizeMemoryType } from "./schema.js";
import { listStoreEntries, type StoredMemoryEntry } from "./store.js";
import { validateAffirmativePhrasing } from "./tools/save.js";

/** Provenance marker written into every entry produced by the merge pass. */
export const DREAM_MEMORY_SOURCE = "dream";

/** Bound the number of live entries exposed to one merge prompt. */
export const MAX_DREAM_ENTRIES = 20;

/** Bound the rendered live-entry content exposed to one merge prompt. */
export const MAX_DREAM_INPUT_CHARS = 24_000;

const MIN_CANDIDATE_CONFIDENCE = 0.6;
const MIN_IMPORTANCE = 1;
const MAX_IMPORTANCE = 5;

export interface MemoryDreamOptions extends MemoryPersistDeps {
  readonly memoryDir: string;
  readonly llm: MemoryExtractLlm;
  readonly signal?: AbortSignal;
}

export interface MemoryDreamResult {
  readonly ops: ReadonlyArray<MemoryOp>;
  readonly written: ReadonlyArray<PersistedMemoryOp>;
}

/**
 * Merge live entries with one bounded model call. Fewer than two live
 * entries is a hard no-op, including no model call.
 */
export async function runMemoryDream(
  opts: MemoryDreamOptions
): Promise<MemoryDreamResult> {
  const scan = await listStoreEntries(opts.memoryDir);
  const live = scan.entries.filter((entry) => !entry.entry.disabled);
  if (live.length < 2) return { ops: [], written: [] };

  let raw: string;
  try {
    raw = await opts.llm.complete(buildDreamPrompt(live), opts.signal);
  } catch (error) {
    throw new MemoryExtractError("memory dream: merge call failed", {
      cause: error,
    });
  }
  const candidates = parseDreamCandidates(raw);
  if (candidates.length === 0) return { ops: [], written: [] };

  const ops = decideMemoryOps(candidates, scan.entries);
  const written = await persistMemoryOps(opts.memoryDir, ops, {
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.randomBytes ? { randomBytes: opts.randomBytes } : {}),
    ...(opts.ttlDays !== undefined ? { ttlDays: opts.ttlDays } : {}),
    source: DREAM_MEMORY_SOURCE,
  });
  return { ops, written };
}

/** Exported for prompt-level tests and review of the model boundary. */
export function buildDreamPrompt(
  entries: ReadonlyArray<StoredMemoryEntry>
): string {
  const rendered: string[] = [];
  let used = 0;
  for (const stored of entries.slice(0, MAX_DREAM_ENTRIES)) {
    const prefix = `${stored.slug}: ${stored.entry.title}\n`;
    const bodyPrefix = `  ${stored.entry.body}\n`;
    const remaining = MAX_DREAM_INPUT_CHARS - used;
    if (remaining <= prefix.length) break;
    const body = bodyPrefix.slice(0, remaining - prefix.length);
    rendered.push(`${prefix}${body}`);
    used += prefix.length + body.length;
  }
  return [
    "You are running an offline memory merge pass over live memory entries.",
    "Combine near-duplicates and keep the most accurate affirmative fact.",
    "Return only candidates that should replace or update an existing entry.",
    "Do not invent facts, promote entries, or use tools.",
    'Reply with a JSON array: { "title": string, "body": string, "type": string, "importance": 1-5, "confidence": 0-1 }.',
    "",
    "--- live entries (tool_result data) ---",
    rendered.join("\n"),
    "--- end live entries ---",
  ].join("\n");
}

function parseDreamCandidates(raw: string): ReadonlyArray<MemoryCandidate> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch (error) {
    throw new MemoryExtractError("memory dream: merge output is not JSON", {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new MemoryExtractError(
      "memory dream: merge output is not a JSON array"
    );
  }

  const candidates: MemoryCandidate[] = [];
  for (const item of parsed) {
    const candidate = toCandidate(item);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function toCandidate(raw: unknown): MemoryCandidate | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const body = typeof value.body === "string" ? value.body.trim() : "";
  if (title.length === 0 || body.length === 0) return null;

  const confidence =
    typeof value.confidence === "number" ? value.confidence : 1;
  if (confidence < MIN_CANDIDATE_CONFIDENCE) return null;
  if (validateAffirmativePhrasing(title, body) !== null) return null;

  return {
    title,
    body,
    type: normalizeMemoryType(value.type),
    importance: clampImportance(value.importance),
  };
}

function clampImportance(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return MIN_IMPORTANCE;
  }
  return Math.min(MAX_IMPORTANCE, Math.max(MIN_IMPORTANCE, Math.round(value)));
}

function stripCodeFence(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  return (fenced?.[1] ?? raw).trim();
}
