/**
 * Skill index entry history (`specs/skill-index-increment.md` / ADR-0098):
 * the set of skill names that have entered this session's model index
 * (= opening frozen-table names ∪ appended deltas), persisted with the session.
 *
 * Why a JSON set rather than append-only lines:
 *   - The history has exactly one use — full-set diff: `modelIndex − history`.
 *     It's a rewritable name set, not a log: no timestamps, sources, or order
 *     semantics (ascending name output is just render stability). An
 *     append-only format would carry parsing/dedup/conflict-merge overhead
 *     (does a hand-edited duplicate name count twice?) for an audit stream
 *     nobody consumes.
 *   - This module is the only writer; there is no concurrent append
 *     (contrast the todo ledger, where append-only human-readable lines are
 *     an ADR-0085 product requirement).
 *   - So: one authoritative JSON, whole-set atomic write (tmp + rename, same
 *     shape as session-store / todo-write atomic saves). The file IS the
 *     current truth; no replay ambiguity.
 *
 * Location mirrors the todo ledger's conversation-folder leaf:
 * `<projectDir>/<sanitize(conversationId)>/<SKILL_INDEX_LEDGER_FILE>`.
 * projectDir is injected by the host via `SessionStore.getProjectDir()`
 * (ADR-0071's single `(baseDir, projectIdentityRoot)` decision point); this
 * module never recomputes it.
 *
 * Semantic boundaries:
 *   - empty: fresh session initial value = the opening model-index name set
 *     (`initialNames`).
 *   - invalid: writes of unknown names are ignored — if the injected
 *     `isIndexedName` predicate says it's not on the model index, it's not
 *     accepted. Slash-envelope body loading never writes entry history; this
 *     module provides no envelope-side write channel (the only mutator is
 *     `addMany`; the rejection list comes from the caller's predicate).
 *   - concurrent: append and persist happen in ONE beat — the in-memory set
 *     changes and the receipt returns only after a successful write; failure
 *     → `write_failed` and the caller must not treat a messages append as
 *     "entered". Concurrent calls serialize through a promise queue
 *     (read-modify-write can't trample itself).
 *   - exception: write failure → typed error; read failure / corruption →
 *     typed error (never silently rebuild as empty, which would re-paste
 *     already-entered names as new listings).
 *
 * No dependency on messages: `snapshot()` / `has()` read only this module's
 * set — compaction rewriting messages leaves the set intact.
 *
 * Non-goals: eligibility judgment ("has description, not disabled") lives in
 * `catalog.ts:modelIndexIneligibility`; this module neither writes messages,
 * injects, nor renders deltas.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sanitizeConversationSegment } from "../session-roots.js";
import { createSerialQueue } from "../../util/serial-queue.js";

/** Leaf name in the conversation folder (single literal declaration point, sibling of todos.md / trace.jsonl). */
export const SKILL_INDEX_LEDGER_FILE = "skill-index.json";

/** Persisted schema version. Wrong shape / wrong version → `read_failed` (no guessing, no migration). */
export const SKILL_INDEX_LEDGER_VERSION = 1;

/** Typed failure discriminators (consumers branch on `kind`, never parse the message). */
export type SkillIndexLedgerErrorKind =
  "invalid_conversation_id" | "read_failed" | "write_failed";

export interface SkillIndexLedgerErrorContext {
  readonly conversationId: string;
  /** Failure detail (IO code / parse reason); may be an empty string. */
  readonly detail: string;
}

/**
 * Typed error for persist/load of the entry history.
 *
 * Why not a `ToolExecutionError` subclass: this error never faces the model
 * (the model neither writes history nor reads this file) — a persist failure
 * is a host-side signal, same tier as `SessionRootError` / `SessionStoreError`.
 * Extending `Error` keeps it `instanceof`-checkable, and `kind` lets callers
 * branch (e.g. `write_failed` → don't append the delta this round).
 */
export class SkillIndexLedgerError extends Error {
  override readonly name: string = "SkillIndexLedgerError";
  readonly kind: SkillIndexLedgerErrorKind;
  readonly conversationId: string;
  readonly detail: string;

  constructor(
    kind: SkillIndexLedgerErrorKind,
    context: SkillIndexLedgerErrorContext,
    options?: { readonly cause?: unknown }
  ) {
    super(
      `skill index ledger ${kind}: ${context.conversationId}` +
        (context.detail === "" ? "" : ` — ${context.detail}`),
      options
    );
    this.kind = kind;
    this.conversationId = context.conversationId;
    this.detail = context.detail;
  }
}

/** `addMany` receipt: names actually accepted this round + full post-write snapshot. */
export interface SkillIndexAddReceipt {
  /** Names newly entered this round (existing + invalid excluded), ascending. */
  readonly added: readonly string[];
  /** Full history after the write (ascending) — same authority as `snapshot()`. */
  readonly snapshot: readonly string[];
}

export interface SkillIndexLedger {
  /** Has this name entered? (reads only this module's set, never messages). */
  has(name: string): boolean;
  /** Full-history snapshot (ascending, NEW array; caller mutation can't poison internals). */
  snapshot(): readonly string[];
  /**
   * Append model-index names and persist in the SAME beat: the receipt comes
   * only after a successful write; failure throws
   * `SkillIndexLedgerError("write_failed")` with the in-memory set unchanged.
   * Unseen legal names → `added`; existing or invalid names → ignored
   * (no throw, no rewrite).
   */
  addMany(names: readonly string[]): Promise<SkillIndexAddReceipt>;
}

export interface CreateSkillIndexLedgerOptions {
  /**
   * Session-folder root (`SessionStore.getProjectDir()`) — injected through
   * the same seam as the todo ledger; this module doesn't compute it.
   */
  readonly projectDir: string;
  /** Conversation id; sanitized into the leaf directory segment (`..` / `/` can't escape). */
  readonly conversationId: string;
  /**
   * The session's opening model-index names (frozen-table projection). On
   * resume these union with the persisted history — frozen names are never
   * re-appended.
   */
  readonly initialNames: readonly string[];
  /**
   * Predicate for the current model-index face (names of `catalog.modelIndex()`).
   * Names failing it are ignored — the single entry point for "unknown names
   * are not written".
   */
  readonly isIndexedName: (name: string) => boolean;
}

/** Atomic write: tmp + rename; any failure cleans tmp, the existing file keeps its last complete content. */
async function writeAtomic(filePath: string, text: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  try {
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(tmpPath, text, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `${code}: ${error.message}`;
  }
  return String(error);
}

/**
 * Load the persisted history. `not_found` (new session / no file) is not an
 * error — return null and let `initialNames` seed the set; everything else
 * (IO / parse / shape / version) is a typed `read_failed`: silently rebuilding
 * as empty would re-paste already-entered names as new listings.
 */
async function readPersistedNames(
  filePath: string,
  conversationId: string
): Promise<readonly string[] | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SkillIndexLedgerError(
      "read_failed",
      { conversationId, detail: errorDetail(error) },
      { cause: error }
    );
  }
  const parsed = parseLedgerFile(raw);
  if (parsed === undefined) {
    throw new SkillIndexLedgerError("read_failed", {
      conversationId,
      detail: `invalid ledger file: ${filePath}`,
    });
  }
  return parsed;
}

/**
 * Strict parse: must be `{version: 1, names: string[]}` with non-empty string
 * elements. Hand edits / half-written files / old versions → undefined
 * (caller throws `read_failed`).
 */
function parseLedgerFile(raw: string): readonly string[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record["version"] !== SKILL_INDEX_LEDGER_VERSION) return undefined;
  const names = record["names"];
  if (!Array.isArray(names)) return undefined;
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) return undefined;
  }
  return names as readonly string[];
}

/** Ascending by name — same order as catalog's `byName`, so writes/snapshots are deterministic. */
function sortNames(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Construction-time validation: conversationId seeds the leaf directory name,
 * so an empty string has nowhere to land. Throws synchronously (before any
 * IO), fail-closed like `resolveConversationDir`.
 */
function assertConversationId(conversationId: string): void {
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    throw new SkillIndexLedgerError("invalid_conversation_id", {
      conversationId: String(conversationId),
      detail: "conversationId is required and must be a non-empty string",
    });
  }
}

/** This conversation's history leaf path — sanitization reuses the SSOT; `..` / `/` can't escape. */
function ledgerPath(projectDir: string, conversationId: string): string {
  return join(
    projectDir,
    sanitizeConversationSegment(conversationId),
    SKILL_INDEX_LEDGER_FILE
  );
}

/**
 * Canonical file body: `{version, names}` + trailing newline, names ascending.
 * The whole set is written at once, so the file is always some complete
 * successful write.
 */
function serializeLedger(names: Iterable<string>): string {
  return `${JSON.stringify(
    { version: SKILL_INDEX_LEDGER_VERSION, names: sortNames(names) },
    null,
    2
  )}\n`;
}

/**
 * Build the ledger and load persisted history (construction reads the disk,
 * so the resume path needs no second beat).
 *
 * Load semantics = `initialNames ∪ persisted` (both are names that entered;
 * accepted unconditionally). `isIndexedName` gates only NEW writes; names
 * delisted / disabled mid-session are not reconciled against existing entries
 * (a documented assumption), so the predicate never prunes what's already in.
 */
export async function createSkillIndexLedger(
  options: CreateSkillIndexLedgerOptions
): Promise<SkillIndexLedger> {
  const { projectDir, conversationId } = options;
  assertConversationId(conversationId);
  const filePath = ledgerPath(projectDir, conversationId);

  const persisted = await readPersistedNames(filePath, conversationId);
  const names = new Set<string>();
  // Frozen-table names enter unconditionally: they already entered at session
  // opening. `isIndexedName` is only the new-write gate — pruning existing
  // entries would make them re-paste as new listings.
  for (const name of options.initialNames) {
    if (typeof name === "string" && name.length > 0) names.add(name);
  }
  for (const name of persisted ?? []) names.add(name);

  const runExclusive = createSerialQueue();

  /** Gate + dedupe: the names actually accepted this round. Invalid names are ignored (no throw). */
  const claimNewNames = (incoming: readonly string[]): Set<string> => {
    const added = new Set<string>();
    for (const name of incoming) {
      if (typeof name !== "string" || name.length === 0) continue;
      if (!options.isIndexedName(name)) continue;
      if (names.has(name)) continue;
      added.add(name);
    }
    return added;
  };

  /** Only a successful write mutates the in-memory set and returns a receipt; failure typed-throws with the set unchanged (same beat). */
  const commit = async (added: Set<string>): Promise<SkillIndexAddReceipt> => {
    if (added.size === 0) return { added: [], snapshot: sortNames(names) };
    const next = new Set(names);
    for (const name of added) next.add(name);
    try {
      await writeAtomic(filePath, serializeLedger(next));
    } catch (error) {
      throw new SkillIndexLedgerError(
        "write_failed",
        { conversationId, detail: errorDetail(error) },
        { cause: error }
      );
    }
    for (const name of added) names.add(name);
    return { added: sortNames(added), snapshot: sortNames(names) };
  };

  const addMany = (
    incoming: readonly string[]
  ): Promise<SkillIndexAddReceipt> =>
    runExclusive(() => commit(claimNewNames(incoming)));

  return Object.freeze({
    has: (name: string): boolean => typeof name === "string" && names.has(name),
    snapshot: (): readonly string[] => sortNames(names),
    addMany,
  });
}
