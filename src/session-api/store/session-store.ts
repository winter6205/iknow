/**
 * Stateless filesystem-backed session store.
 *
 * Why stateless: concurrency serialization is the hub's responsibility.
 * This class is a thin typed-IO wrapper over
 * `<baseDir>/projects/<slug>/<conversationId>/` (ADR-0071 / ADR-0087).
 * Every failure path throws a typed SessionStoreError — never a bare Error.
 *
 * ADR-0027: single on-disk shape.
 *   - Authority: `<id>.jsonl` — single-file append-only JSONL (session header
 *     record, id/parent message events, trailing head record; codec in
 *     jsonl.ts). save() writes ONLY this; load() prefers it.
 *   - Read fallback: `<id>.json` — legacy SessionFileV1 JSON, ONLY read by
 *     load() during the migration window (legacy-only `.json` → load → save
 *     → JSONL authority on the next save). save() does NOT write the legacy
 *     mirror (expand-phase compat ended; tests migrated off direct `.json`
 *     reads).
 *   - Detection is by EXTENSION: load prefers `<id>.jsonl`, falls back to
 *     `<id>.json` (legacy path unchanged).
 *   - appendEvents/readHead/writeHead are JSONL-only primitives (the commit
 *     hooks and rewind layers build on them). They MUST be called under the
 *     hub serialize queue — the store stays stateless, no in-store locking
 *     (same posture as save()).
 *   - save() is append-only AWARE — it aligns the caller's projection with
 *     the persisted head chain (longest common prefix) and only appends the
 *     divergent tail, so a rewound-away branch survives every subsequent
 *     save. rewindToAnchor() moves the persisted head to an earlier turn
 *     boundary WITHOUT truncating the log.
 */
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import path from "node:path";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  StopReason,
  SupplierStopDetail,
} from "../../harness/index.js";
import type { SessionStoreError } from "./errors.js";
import { closeoutOrphanToolUses } from "./closeout-projection.js";
import {
  resolveRewindAnchor,
  splitTurns,
  withCheckpointAnchors,
} from "./checkpoint.js";
import type {
  FileIntentTarget,
  ParsedSessionLog,
  PreimageRef,
  PublishedNativeStateSelection,
  SessionEventRecord,
  SessionFileIntentRecord,
  SessionHeadRecord,
  SessionNativeStateRecord,
  SessionOperationFactRecord,
  SessionOutcomeRecord,
  SessionTitleRecord,
  SessionTailRecord,
  SecurityInterruptionRecord,
} from "./jsonl.js";
import {
  chainFromHead,
  headChainEvents,
  isStopReason,
  jsonDeepEqual,
  latestTitleText,
  matchCodePreimage,
  messageEventId,
  parseSessionJsonl,
  projectSessionLog,
  resolvePublishedNativeState,
  resolveTitleText,
  resolveTurnOutcomes,
  serializeSessionLog,
  SESSION_JSONL_EXT,
  sessionFileToJsonl,
} from "./jsonl.js";
import {
  fileIntentInputField,
  isNativeStateSha,
  nativeStateInputField,
  operationFactInputField,
  parseNativeStateBody,
  readNativeStateBody,
  writeNativeStateBody,
} from "./native-state-store.js";
import {
  buildRewindTargetsFromLog,
  type LedgerRewindTarget,
} from "./rewind-targets.js";
import type { SessionFileV1 } from "./schema.js";
import {
  extractTitle,
  isNewFormatSession,
  sanitizeSessionFile,
} from "./schema.js";
import type {
  NativeStateBoundary,
  NativeStateMessage,
  NativeStateSnapshot,
} from "../../shared/native-state-port.js";
import type { RuntimeOperationFact } from "../../shared/runtime-persistence.js";
import { MAX_WORKSPACE_ROOT_CHARS } from "../../config/workspace-root.js";
import {
  MAX_ROOT_DETAIL_CHARS,
  sanitizeConversationSegment,
  SessionRootError,
} from "../../harness/session-roots.js";
import {
  computeProjectSlug,
  MAX_PROJECT_IDENTITY_ROOT_BYTES,
} from "../../shared/project-slug.js";
import {
  PROJECTS_DIR_NAME,
  SUBAGENT_TRACE_DIR_NAME,
} from "../../shared/session-tree-names.js";

export type SessionBindingStatus = "unbound" | "invalid" | "bound";

/**
 * One operation-fact append. `anchorEventId` and `baseBodySha` are deliberately
 * NOT here: they name the log this fact is appended to, so the store resolves
 * them from the log it is the single writer of (see `appendOperationFact`).
 */
export interface AppendOperationFactInput {
  /** Store session id — the identity the transcript is keyed by. */
  readonly id: string;
  /** Stable caller-supplied fact identity; a repeat is deduped, not doubled. */
  readonly factId: string;
  readonly fact: RuntimeOperationFact<NativeStateMessage>;
  /** Turn the fact belongs to, when the turn identity is known. */
  readonly turnId?: string;
}

/** Metadata returned by list(); intentionally excludes messages.
 *
 *  `workspaceRoot` (Postel): mirror of the additive optional field on
 *  `SessionFileV1` — omitted from the entry (not serialized as null) when
 *  the underlying file lacks it. Legacy v3/v4 files sanitize cleanly
 *  without the field, so a missing key is the canonical "unbound" state
 *  (sanitize never backfills cwd / process.cwd). */
export interface SessionListEntry {
  readonly conversation_id: string;
  readonly updatedAt: string;
  /** Text excerpt from the most recent assistant turn ("" if none). */
  readonly lastFinalText: string;
  /** UI title (renamed from `summary`). ADR-0113: = the latest title
   *  event's text; with no title event = the extractTitle placeholder
   *  (header `title` is only a cache). */
  readonly title: string;
  /** Whether the persisted workspace binding is executable as-is. */
  readonly bindingStatus: SessionBindingStatus;
  /** Per-session workspace-root bind (ABS optional; absent = unbound,
   *  legacy files sanitize through). Wire field name stays
   *  `workspaceRoot` (snake-less camel) to match the file shape verbatim. */
  readonly workspaceRoot?: string;
}

/**
 * Listing projection. Two consumers share the directory scan but differ in
 * what they may hide:
 *  - "presentation" (TUI / web picker): a blank title has nothing to show, so
 *    the row is omitted rather than rendered as a placeholder. Broken
 *    ("invalid") bindings stay listed so they can be rebound.
 *  - "occupancy" (ADR-0070 worktree-claim check): a persisted workspaceRoot is
 *    a claim regardless of title, so the blank-title filter is lifted — hiding a
 *    blank-title bound claim would let two sessions silently double-claim a tree.
 * Both keep the no-assistant-text filter and the skip-corrupt policy.
 */
type ListProjection = "presentation" | "occupancy";

/**
 * Project namespace under the shared pool root.
 *
 * ADR-0071: the
 * grouping key is `projectIdentityRoot`, not `cwd`. cwd moves with worktree
 * rebinds; the identity root is stable across rebinds (per
 * `docs/CONTEXT.md`).
 *
 * Layout: `<baseDir>/projects/<basename(root)>-<sha1(root)[:12]>`.
 * basename keeps it human-browsable; the sha1 suffix disambiguates same-named
 * projects at different paths. Pure: no IO, no `process.cwd()` fallback.
 *
 * Empty / blank / relative / non-normalizable inputs fail closed with a
 * typed `SessionRootError` (same kind vocabulary as `resolveSessionRoots`).
 * The default-cwd fallback of the earlier contract was removed: a caller
 * without an explicit root must decide where the namespace belongs.
 */
export function resolveProjectSessionDir(
  baseDir: string,
  projectIdentityRoot: string
): string {
  requireValidRoot(projectIdentityRoot, "projectIdentityRoot");
  // Slug formula and cap SSOT: shared/project-slug.ts
  // (harness/background/paths.ts resolveTasksDir consumes the same function
  // and the same cap).
  return join(
    baseDir,
    PROJECTS_DIR_NAME,
    computeProjectSlug(projectIdentityRoot)
  );
}

/**
 * Resolve the per-conversation folder under an already-resolved project
 * directory (the output of `resolveProjectSessionDir`). The leaf is the
 * `conversationId` verbatim, so a UUID-shaped id passes through unchanged
 * (sanitize is the identity on `[A-Za-z0-9_-]`).
 *
 * Folder name = `conversationId` verbatim; pure function,
 * no IO, no `process.cwd()` fallback. Path-hostile inputs (containing `/`
 * / `..` / `\0`) are sanitized so they CANNOT escape `projectDir` — `..`
 * becomes `__`, slashes become `_`. Over-length inputs (>255 bytes single
 * segment) fail closed without silent truncation.
 */
export function resolveConversationDir(opts: {
  readonly projectDir: string;
  readonly conversationId: string;
}): string {
  const id = opts.conversationId;
  if (typeof id !== "string" || id.length === 0) {
    throw new SessionRootError(
      "missing_root",
      "conversationId is required and was not provided"
    );
  }
  if (id.length > MAX_CONVERSATION_ID_BYTES) {
    throw new SessionRootError(
      "invalid_root",
      `conversationId length ${id.length} exceeds ${MAX_CONVERSATION_ID_BYTES} bytes`
    );
  }
  // Sanitize even on the success path so a permissive `..` / `/` cannot
  // escape via path-join downstream. The slug remains stable across calls.
  const segment = sanitizeConversationSegment(id);
  return join(opts.projectDir, segment);
}

/**
 * ADR-0071: per-conversation trace anchor =
 * `<projectDir>/<conversationId>/trace.jsonl`. The same baseDir + the same
 * projectIdentityRoot + the same conversationId always derive the same
 * absolute file path — starting the same session of the same repo from a
 * different cwd keeps the path stable (cross-cwd consistency is ADR-0071's
 * core invariant).
 *
 * Derived rather than string-concatenated: reuses `resolveConversationDir`'s
 * sanitize and length bounds, so callers can't each re-implement path-join
 * and regress into `..` / `/` escapes.
 */
export const TRACE_FILE_NAME = "trace.jsonl";

export function resolveConversationTraceFilePath(opts: {
  readonly projectDir: string;
  readonly conversationId: string;
}): string {
  return join(resolveConversationDir(opts), TRACE_FILE_NAME);
}

/**
 * Re-exported from `shared/session-tree-names.ts` —
 * the single-literal SSOT lives in the shared layer (neutral to
 * session-store / harness manager / traceserver). This re-export preserves
 * back-compat for older callers importing
 * `SUBAGENT_TRACE_DIR_NAME` from here.
 */
export { SUBAGENT_TRACE_DIR_NAME } from "../../shared/session-tree-names.js";

export function resolveSubagentTraceDir(opts: {
  readonly projectDir: string;
  readonly conversationId: string;
}): string {
  return join(resolveConversationDir(opts), SUBAGENT_TRACE_DIR_NAME);
}

/**
 * Per-segment single-component cap on most POSIX-style filesystems.
 * Enforced as a typed boundary (no silent truncation) so callers see the
 * rejection instead of an arbitrary cut-off id producing an unexpected
 * `mkdir EEXIST` or hash-collision.
 */
const MAX_CONVERSATION_ID_BYTES = 255;

function requireValidRoot(value: string, label: string): void {
  if (typeof value !== "string") {
    throw new SessionRootError(
      "missing_root",
      `${label} is required and was not provided`
    );
  }
  const trimmed = value.trim();
  // The cap comes from shared/project-slug.ts — the same constant as
  // harness/background/paths.ts resolveTasksDir, so roots of 121–255 chars
  // are accepted on both sides (a divergent local cap would throw in that
  // range and orphan registry entries).
  if (trimmed === "" || trimmed.length > MAX_PROJECT_IDENTITY_ROOT_BYTES) {
    throw new SessionRootError(
      "missing_root",
      `${label} is required and must be non-empty`
    );
  }
  if (!path.isAbsolute(trimmed)) {
    throw new SessionRootError(
      "invalid_root",
      `${label} must be an absolute path, got '${trimmed.slice(0, MAX_ROOT_DETAIL_CHARS)}'`
    );
  }
}

export class SessionStore {
  private readonly projectDir: string;

  constructor(baseDir: string, projectIdentityRoot: string) {
    this.projectDir = resolveProjectSessionDir(baseDir, projectIdentityRoot);
  }

  /**
   * ADR-0071: read-only projection of
   * the resolved session project directory
   * (`<baseDir>/projects/<basename>-<sha1[:12]>`). Consumers whose per-call
   * leaf lives INSIDE the session folder — the todo ledger `todoDir` seam
   * (`resolveConversationTodoPath`) and the trace anchor — take
   * this same root from the store instead of recomputing
   * `resolveProjectSessionDir` at their own assembly sites, so there is
   * exactly one `(baseDir, projectIdentityRoot)` decision per host process
   * and the three entries (chat / serve / TUI) cannot drift into two
   * different project folders for the same conversation.
   */
  getProjectDir(): string {
    return this.projectDir;
  }

  /** Per-conversation folder under the project dir. Pure projection of
   *  `projectDir` + `id` — see `resolveConversationDir` for the contract. */
  private conversationDir(id: string): string {
    return resolveConversationDir({
      projectDir: this.projectDir,
      conversationId: id,
    });
  }

  /**
   * Load and validate a session file.
   * Detection by extension: `<id>.jsonl` (JSONL authority, projected to the
   * current-head transcript) wins; otherwise legacy `<id>.json`.
   * The JSONL projection backfills synthetic tool_result(s) for orphan
   * tool_use(s) — process closeout — so consumers never receive an
   * API-illegal transcript.
   * Throws: not_found | parse_failed | schema_invalid | io_error
   */
  async load(id: string): Promise<SessionFileV1> {
    const jsonlRaw = await this.tryReadFile(this.jsonlPath(id), id);
    if (jsonlRaw !== null) {
      let log: ParsedSessionLog;
      try {
        log = parseSessionJsonl(jsonlRaw);
      } catch (err) {
        throw this.attachId(id, err);
      }
      try {
        const file = projectSessionLog(log);
        // Migrate messagesCount-only checkpoints to their
        // event-id anchor against the current head chain.
        const anchored = withDerivedAnchors(
          file,
          headChainEvents(log).map((e) => e.id)
        );
        return {
          ...anchored,
          messages: closeoutOrphanToolUses(anchored.messages),
        };
      } catch (err) {
        throw this.attachId(id, err);
      }
    }
    const raw = await this.readRaw(id);
    const parsed = this.parseJson({ id, raw });
    try {
      const file = sanitizeSessionFile(parsed);
      // A legacy file's message order is exactly what the
      // JSONL migration writes (e0..e{N-1}), so the anchor derives from the
      // message position.
      return withDerivedAnchors(
        file,
        file.messages.map((_, i) => messageEventId(i))
      );
    } catch (err) {
      // sanitize is pure and lacks store identity; reattach id for the typed contract.
      const field = (err as { field?: string }).field;
      throw {
        kind: "schema_invalid",
        conversation_id: id,
        field: field ?? "root",
      } satisfies SessionStoreError;
    }
  }

  /**
   * Atomic write: tmp file then rename, so a crash never leaves a half-written file.
   * Writes ONLY the JSONL authority (`<id>.jsonl`). The legacy `.json` mirror
   * is NOT written (expand-phase compat ended; tests migrated off
   * direct `.json` reads). Load still falls back to a legacy-only `.json`,
   * so a legacy-only session's first save migrates it to JSONL authority
   * (`fullRewritePlan` is the natural migrator — the `readJsonlLog` not_found
   * branch sets `log = null` and triggers it).
   *
   * The JSONL write is append-only AWARE (planSessionSave). The
   * caller's `file.messages` projection is aligned with the persisted head
   * chain by longest common prefix:
   *   - identical projection → header-refresh only (records preserved
   *     verbatim, no new event/head records);
   *   - head chain is a prefix of the projection → append the tail events
   *     parented at the current head;
   *   - projection is a strict prefix of the head chain → append only a
   *     head record moving the head backward (reset-shaped save);
   *   - divergent projection → append the suffix as a new branch parented
   *     at the LCP boundary (fork; the abandoned suffix stays in the file).
   * Existing event/head records are NEVER dropped, so a rewound-away branch
   * survives every subsequent save. A fresh session, a legacy-only mirror,
   * or a corrupt log falls back to a full rewrite (self-heal; the
   * simple non-append-aware shape).
   * Throws: write_failed
   */
  async save(opts: {
    readonly id: string;
    readonly file: SessionFileV1;
  }): Promise<void> {
    const { id, file } = opts;
    const jsonlPath = this.jsonlPath(id);
    const jsonlTmp = `${jsonlPath}.tmp`;
    try {
      await mkdir(this.conversationDir(id), { recursive: true });
      let log: ParsedSessionLog | null = null;
      try {
        log = await this.readJsonlLog(id, jsonlPath, {
          legacyIsWriteFailed: false,
        });
      } catch (err) {
        // not_found (fresh / legacy-only) | parse_failed | schema_invalid
        // (corrupt log) → full rewrite, which also self-heals the file.
        // io_error is a genuine write-path failure → write_failed below.
        if ((err as { kind?: string }).kind === "io_error") throw err;
        log = null;
      }
      const plan = planSessionSave(gateTitleToEvent(file, log), log);
      await writeFile(jsonlTmp, plan.jsonl, "utf8");
      await rename(jsonlTmp, jsonlPath);
    } catch (err) {
      const typed = err as { kind?: string; cause?: unknown };
      throw {
        kind: "write_failed",
        conversation_id: id,
        cause:
          typed.kind === "io_error" && typeof typed.cause === "string"
            ? typed.cause
            : errMsg(err),
      } satisfies SessionStoreError;
    }
  }

  /**
   * Append message events to the JSONL log WITHOUT rewriting the file
   * (host-injected commit hooks call this mid-turn). Each event
   * gets a fresh `e<maxIndex+1>` id chained from the persisted head, followed
   * by a new head record — so a backward head (rewind) forks a new branch and
   * the old chain stays in the file.
   *
   * Cheap = append-only (one read of the log + one append syscall); safe to
   * call repeatedly. MUST be called under the hub serialize queue (the store
   * is stateless; no in-store locking).
   *
   * JSONL-only: a legacy `.json`-only session must be save()d once first
   * (migration-on-save). Empty `events` is a no-op.
   * Throws: not_found | write_failed | parse_failed | schema_invalid | io_error
   *
   * `thinkingMs` is the assistant-turn thinking duration (ms) persisted to
   * disk. The key is attached only when (a) `opts.thinkingMs` is provided
   * AND (b) the event role is assistant; `thinkingMs <= 0` or non-finite is
   * invalid → field absent (a pinned boundary shape). tool_result / user /
   * system events never carry the key (the commit seam passes one value per
   * batch, carried only at assistant commits; tool_result commits pass
   * undefined — even if a message happens to be assistant the key stays
   * off, since the hub's commit closure passes thinkingMs only on the main
   * stepWithTrace path).
   *
   * `preimages` maps `tool_use_id → PreimageRef` for workspace writes captured
   * during this commit batch. A `tool_result` block whose id is present and is
   * NOT an error gets `codePreimage` stamped on its event record; every other
   * event (and an errored tool_result) leaves the key absent. The stamp is
   * transcript-side only — model message content is never modified. Absent map
   * → byte-identical to the pre-capture behavior.
   */
  async appendEvents(opts: {
    readonly id: string;
    readonly events: ReadonlyArray<AnthropicNativeMessage>;
    /** Thinking duration (ms) carried by assistant commits; tool_result /
     *  other batches = undefined. */
    readonly thinkingMs?: number;
    /** tool_use_id → captured preimage, for stamping successful tool_result
     *  events; absent/empty → no stamping. */
    readonly preimages?: ReadonlyMap<string, PreimageRef>;
  }): Promise<void> {
    const { id, events, thinkingMs, preimages } = opts;
    if (events.length === 0) return;
    const path = this.jsonlPath(id);
    const log = await this.readJsonlLog(id, path, {
      legacyIsWriteFailed: true,
    });
    // Only persist thinkingMs when its boundary shape is valid (> 0 and
    // finite).
    const stampableThinkingMs =
      typeof thinkingMs === "number" &&
      Number.isFinite(thinkingMs) &&
      thinkingMs > 0
        ? thinkingMs
        : undefined;
    let next = log.maxEventIndex + 1;
    let parent = log.head;
    const lines: string[] = [];
    for (const message of events) {
      const eventId = messageEventId(next++);
      // Each event carries its own ingest timestamp (under the per-tool
      // commit pattern the user/assistant/tool stamps are close but
      // distinguishable).
      const codePreimage = matchCodePreimage(message, preimages);
      const record: SessionEventRecord = {
        type: "message",
        id: eventId,
        parent,
        message,
        createdAt: new Date().toISOString(),
        // Attach the key only for assistant events + a valid
        // stampableThinkingMs. A batch contains exactly one assistant
        // message (loop-engine commits one assistant message at a time), so
        // the conditional spread never forks across events within a batch —
        // uniform key behavior per batch.
        ...(message.role === "assistant" && stampableThinkingMs !== undefined
          ? { thinkingMs: stampableThinkingMs }
          : {}),
        // Successful tool_result whose tool_use_id was captured → stamp its
        // preimage ref. Errored tool_results are excluded (matchCodePreimage),
        // so a failed write never claims a preimage it did not produce.
        ...(codePreimage !== undefined ? { codePreimage } : {}),
      };
      lines.push(JSON.stringify(record));
      parent = eventId;
    }
    lines.push(JSON.stringify({ type: "head", id: parent }));
    try {
      await appendFile(path, `${lines.join("\n")}\n`, "utf8");
    } catch (err) {
      throw {
        kind: "write_failed",
        conversation_id: id,
        cause: errMsg(err),
      } satisfies SessionStoreError;
    }
  }

  /**
   * ADR-0113: append one title event (`{type:"title", text}`) to the JSONL
   * tail — pure append, single line, does not touch the message chain or the
   * head pointer (projectSessionLog walks the chain and naturally never
   * projects title events). The event text is the title's authority; the
   * header `title` is only a cache, refreshed on the next save by the
   * overwrite gate, and the read paths (load/list) already reflect the event
   * text immediately via projection.
   *
   * Called by the title-generation module. JSONL-only: a legacy
   * `.json`-only session must be save()d once first to migrate (same
   * migration signal as appendEvents). MUST be called under the hub
   * serialize queue — the store stays lock-free (same posture as
   * appendEvents/writeHead).
   * Throws: not_found | write_failed (legacy-only / IO) | parse_failed |
   *   schema_invalid (field "title": empty / whitespace-only text; corrupt
   *   log) | io_error
   */
  async appendTitle(opts: {
    readonly id: string;
    readonly text: string;
  }): Promise<void> {
    const { id, text } = opts;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw {
        kind: "schema_invalid",
        conversation_id: id,
        field: "title",
      } satisfies SessionStoreError;
    }
    const path = this.jsonlPath(id);
    // readJsonlLog: not_found / legacy→write_failed / corrupt→typed error。
    await this.readJsonlLog(id, path, { legacyIsWriteFailed: true });
    const record: SessionTitleRecord = { type: "title", text };
    try {
      await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    } catch (err) {
      throw {
        kind: "write_failed",
        conversation_id: id,
        cause: errMsg(err),
      } satisfies SessionStoreError;
    }
  }

  /**
   * ADR-0126: append one outcome record (`{type:"outcome", turnId,
   * stopReason}`) to the JSONL tail — the authoritative terminal state of the
   * settled host turn whose terminal message event is `turnId`. Pure append,
   * single line: it never touches the message chain or the head pointer, so
   * the record can never be mistaken for conversation content and an
   * abandoned branch's outcome never projects (see `resolveTurnOutcomes`).
   *
   * Called by the hub right after a turn's messages are persisted. JSONL-only:
   * a legacy `.json`-only session must be save()d once first to migrate (same
   * migration signal as appendEvents/appendTitle). MUST be called under the
   * hub serialize queue — the store stays lock-free.
   * Throws: not_found | write_failed (legacy-only / IO) | parse_failed |
   *   schema_invalid (field "outcome": stopReason outside the StopReason
   *   union) | io_error
   */
  async appendOutcome(opts: {
    readonly id: string;
    readonly turnId: string;
    readonly stopReason: StopReason;
    readonly supplierDetail?: SupplierStopDetail;
    /** ADR-0135: structured cause + bounded cleanup for a turn interrupted
     *  by the confirmed-violation escalation. Absent for every other stop,
     *  including a user Ctrl+C — the key's absence is what keeps the two
     *  indistinguishable-but-different events apart. */
    readonly securityInterruption?: SecurityInterruptionRecord;
  }): Promise<void> {
    const { id, turnId, stopReason, supplierDetail, securityInterruption } =
      opts;
    if (!isStopReason(stopReason)) {
      throw {
        kind: "schema_invalid",
        conversation_id: id,
        field: "outcome",
      } satisfies SessionStoreError;
    }
    // ADR-0135: a security interruption rides the existing `cancelled`
    // reason. Rejecting any other reason here keeps the persisted record
    // self-consistent — a stop that claims a security cause without being a
    // cancellation would be a lie a reviewer could act on.
    if (securityInterruption !== undefined && stopReason !== "cancelled") {
      throw {
        kind: "schema_invalid",
        conversation_id: id,
        field: "outcome",
      } satisfies SessionStoreError;
    }
    const path = this.jsonlPath(id);
    await this.readJsonlLog(id, path, { legacyIsWriteFailed: true });
    const record: SessionOutcomeRecord = {
      type: "outcome",
      turnId,
      stopReason,
      ...(supplierDetail !== undefined ? { supplierDetail } : {}),
      ...(securityInterruption !== undefined ? { securityInterruption } : {}),
    };
    try {
      await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    } catch (err) {
      throw {
        kind: "write_failed",
        conversation_id: id,
        cause: errMsg(err),
      } satisfies SessionStoreError;
    }
  }

  /**
   * ADR-0136: publish one complete native state. ORDER IS THE CONTRACT —
   * validate the snapshot, write the immutable body, and ONLY THEN append the
   * `native_state` record. A record is the sole selectability signal, so a
   * failure anywhere before that append leaves the prior state selected and an
   * orphan body behind, which is harmless and is not progress. Never append
   * first.
   *
   * The record carries a content address, not the state, so republishing an
   * unchanged snapshot reuses one body (content-addressed dedup) and appends
   * one more line.
   *
   * `boundary` and the snapshot's own `boundary` must agree: the record is
   * read without dereferencing the body, so two different values would let a
   * reader act on a boundary the state never had.
   *
   * MUST be called under the hub serialize queue (same posture as
   * appendEvents/appendTitle/appendOutcome — the store stays lock-free).
   * Throws: not_found | write_failed (legacy-only / body write / record
   *   append) | parse_failed | schema_invalid (the failed field is the
   *   snapshot's own — "messages", "boundary", … — or "anchorEventId") |
   *   io_error
   */
  async appendNativeState(opts: {
    readonly id: string;
    readonly anchorEventId: string;
    readonly boundary: NativeStateBoundary;
    readonly snapshot: NativeStateSnapshot;
  }): Promise<{
    readonly record: SessionNativeStateRecord;
    readonly bodySha: string;
    readonly messageCount: number;
  }> {
    const { id, anchorEventId, boundary, snapshot } = opts;
    const field = nativeStateInputField(anchorEventId, boundary, snapshot);
    if (field !== null) throw invalidFor(id, field);
    const path = this.jsonlPath(id);
    const log = await this.readJsonlLog(id, path, {
      legacyIsWriteFailed: true,
    });
    if (!log.events.some((e) => e.id === anchorEventId)) {
      throw invalidFor(id, "anchorEventId");
    }
    // Body first: the record must never reference state that is not complete.
    let bodySha: string;
    try {
      bodySha = await writeNativeStateBody(
        this.conversationDir(id),
        JSON.stringify(snapshot)
      );
    } catch (err) {
      throw writeFailedFor(id, err);
    }
    const record: SessionNativeStateRecord = {
      type: "native_state",
      anchorEventId,
      bodySha,
      boundary,
      messageCount: snapshot.messages.length,
      createdAt: new Date().toISOString(),
    };
    await this.appendTailRecord(id, path, record);
    return { record, bodySha, messageCount: record.messageCount };
  }

  /**
   * ADR-0136: persist the durable file-write intent for EVERY target of one
   * tool call, BEFORE the targets are mutated. Anchored at the CURRENT
   * persisted head — the assistant tool_use event is committed before any
   * call in that response is dispatched, so that head is a real branch
   * anchor. No persisted head yet is a typed failure, never a silent null
   * anchor.
   *
   * `captured:false` records the existing `codeRestore.enabled` suppression so
   * recovery reports the effect UNVERIFIED rather than inferring completion; a
   * suppressed intent therefore carries no preimage reference.
   *
   * MUST be called under the hub serialize queue (store stays lock-free).
   * Throws: not_found | write_failed (legacy-only / IO) | parse_failed |
   *   schema_invalid (field "toolUseId" or "targets") | io_error
   */
  async appendFileIntent(opts: {
    readonly id: string;
    readonly toolUseId: string;
    readonly targets: ReadonlyArray<FileIntentTarget>;
    readonly captured: boolean;
  }): Promise<{ readonly record: SessionFileIntentRecord }> {
    const { id, toolUseId, targets, captured } = opts;
    const field = fileIntentInputField(toolUseId, targets, captured);
    if (field !== null) throw invalidFor(id, field);
    const path = this.jsonlPath(id);
    const log = await this.readJsonlLog(id, path, {
      legacyIsWriteFailed: true,
    });
    if (log.head === null) throw invalidFor(id, "anchorEventId");
    const record: SessionFileIntentRecord = {
      type: "file_intent",
      toolUseId,
      anchorEventId: log.head,
      targets,
      captured,
      createdAt: new Date().toISOString(),
    };
    await this.appendTailRecord(id, path, record);
    return { record };
  }

  /**
   * ADR-0136: append ONE operation fact — a settled tool result with its
   * per-file associations, a graph node transition, or owned-worker progress.
   * Append-only: a fact is never rewritten, and a published state is never
   * mutated because of it.
   *
   * ORDER IS THE CONTRACT: the append POSITION is the fact's association with
   * the published state it follows, so this appends in arrival order and never
   * reorders. `anchorEventId` (the persisted head) and `baseBodySha` (the last
   * `native_state` body in the same log) are resolved HERE, not taken from the
   * caller: the store is the only writer of the log, so resolving from it means
   * a fact's base can never disagree with the transcript it was appended to.
   * A per-sink memory of the same value would be a second authority that could
   * drift after a crash.
   *
   * DEDUP: a repeated append of a `factId` already in the log is a no-op, so a
   * retried or replayed append cannot double-count one settled operation
   * (SC27 — a second open must add no duplicate receipt).
   *
   * A session with no persisted head has no anchor to append after, so it is a
   * typed failure rather than a synthetic anchor.
   *
   * MUST be called under the hub serialize queue (store stays lock-free).
   * Throws: not_found | write_failed (legacy-only / IO) | parse_failed |
   *   schema_invalid (field "factId", "fact", or "anchorEventId") | io_error
   */
  async appendOperationFact(input: AppendOperationFactInput): Promise<void> {
    const { id, factId, fact, turnId } = input;
    const field = operationFactInputField(factId, fact);
    if (field !== null) throw invalidFor(id, field);
    const path = this.jsonlPath(id);
    const log = await this.readJsonlLog(id, path, {
      legacyIsWriteFailed: true,
    });
    if (log.head === null) throw invalidFor(id, "anchorEventId");
    if (log.records.some((rec) => isSameFactId(rec, factId))) return;
    const record: SessionOperationFactRecord = {
      type: "operation_fact",
      factId,
      anchorEventId: log.head,
      baseBodySha: lastPublishedBodySha(log),
      ...(turnId === undefined ? {} : { turnId }),
      fact,
      createdAt: new Date().toISOString(),
    };
    await this.appendTailRecord(id, path, record);
  }

  /**
   * ADR-0136: read side for session entry — the selected published state as
   * derived from the selected head chain, every on-chain file intent with its
   * chain position (so the caller can tell "after the selected state" from
   * "before it"), and whether the file is new format at all. No body is
   * dereferenced here: validation and failure classification belong to
   * `readPublishedNativeStateBody`, which reports missing / corrupt /
   * schema-invalid as three distinct typed outcomes.
   *
   * Read-only; same error surface as readHead.
   * Throws: not_found | parse_failed | schema_invalid | io_error
   */
  async loadPublishedNativeState(opts: {
    readonly id: string;
  }): Promise<PublishedNativeStateSelection & { readonly newFormat: boolean }> {
    const { id } = opts;
    const log = await this.readJsonlLog(id, this.jsonlPath(id), {
      legacyIsWriteFailed: false,
    });
    return {
      ...resolvePublishedNativeState(log),
      newFormat: isNewFormatSession(log.header),
    };
  }

  /**
   * Read + validate one published state's body. The three failure kinds are
   * deliberately distinct so an entry reader can fail closed and tell them
   * apart: a missing body (`not_found`), damaged bytes (`parse_failed`), and a
   * body that is not a valid state (`schema_invalid`) must never be collapsed
   * into "nothing published", which would silently fall back to transcript
   * reconstruction or an older state.
   *
   * `bodySha` is gated to sha256's alphabet before any filesystem access — a
   * persisted record is history, not a licence to read outside the folder.
   * Throws: not_found | parse_failed | schema_invalid | io_error
   */
  async readPublishedNativeStateBody(opts: {
    readonly id: string;
    readonly bodySha: string;
  }): Promise<NativeStateSnapshot> {
    const { id, bodySha } = opts;
    if (!isNativeStateSha(bodySha)) throw invalidFor(id, "bodySha");
    let bytes: Buffer;
    try {
      bytes = await readNativeStateBody(this.conversationDir(id), bodySha);
    } catch (err) {
      throw this.attachBodyError(id, err);
    }
    try {
      return parseNativeStateBody(bytes);
    } catch (err) {
      throw this.attachBodyError(id, err);
    }
  }

  /**
   * ADR-0126: read-only projection of the ACTIVE head chain's turn outcomes —
   * the message-event ids of that chain (root → head, index-aligned with
   * `load()`'s messages) plus the outcome recorded for each of them. Outcomes
   * of rewound-away / compacted-away branches are excluded, a later record
   * replaces an earlier one for the same anchor, and a turn with no record is
   * simply absent (the hub projects that as unknown). A legacy `.json`-only
   * session has no outcome records: its ids are the synthetic e0..e{N-1} the
   * migration would write.
   * Throws: not_found | parse_failed | schema_invalid | io_error
   */
  async projectTurnOutcomes(id: string): Promise<{
    readonly messageEventIds: ReadonlyArray<string>;
    readonly outcomes: ReadonlyMap<string, SessionOutcomeRecord>;
  }> {
    const raw = await this.tryReadFile(this.jsonlPath(id), id);
    if (raw === null) {
      // Legacy `.json`-only: no outcome can exist, and load() derived the
      // messages in exactly the order the migration would number them.
      const file = await this.load(id);
      return {
        messageEventIds: file.messages.map((_, i) => messageEventId(i)),
        outcomes: new Map<string, SessionOutcomeRecord>(),
      };
    }
    try {
      return resolveTurnOutcomes(parseSessionJsonl(raw));
    } catch (err) {
      throw this.attachId(id, err);
    }
  }

  /**
   * ADR-0113: read-only pre-check before title generation fires — does the
   * JSONL log already carry a title event (the cross-process form of "an
   * existing title event → skip; a second completed does not write a second
   * one"; in-process the hub's fired-set covers it). A legacy-only session
   * (no JSONL) → not_found (same form as readHead; title generation fires
   * only after completed persist, by which time migrate-on-save has written
   * the JSONL).
   * Throws: not_found | parse_failed | schema_invalid | io_error
   */
  async hasTitleEvent(id: string): Promise<boolean> {
    const log = await this.readJsonlLog(id, this.jsonlPath(id), {
      legacyIsWriteFailed: false,
    });
    return latestTitleText(log) !== null;
  }

  /**
   * Read the persisted rewind head (event id, null = empty transcript).
   * JSONL-only primitive (the rewind layer consumes it; legacy sessions
   * have no persisted
   * head until migrated by a save).
   * Throws: not_found | parse_failed | schema_invalid | io_error
   */
  async readHead(id: string): Promise<string | null> {
    const log = await this.readJsonlLog(id, this.jsonlPath(id), {
      legacyIsWriteFailed: false,
    });
    return log.head;
  }

  /**
   * Persist a new rewind head by APPENDING a head record (append-only; the
   * old chain is never truncated). `head` must be null or an existing event
   * id in the log. The rewind semantics are built on this primitive.
   * Throws: not_found | schema_invalid (unknown head id) | write_failed | io_error
   */
  async writeHead(opts: {
    readonly id: string;
    readonly head: string | null;
  }): Promise<void> {
    const { id, head } = opts;
    const path = this.jsonlPath(id);
    const log = await this.readJsonlLog(id, path, {
      legacyIsWriteFailed: true,
    });
    if (head !== null && !log.events.some((e) => e.id === head)) {
      throw {
        kind: "schema_invalid",
        conversation_id: id,
        field: "head",
      } satisfies SessionStoreError;
    }
    try {
      await appendFile(
        path,
        `${JSON.stringify({ type: "head", id: head })}\n`,
        "utf8"
      );
    } catch (err) {
      throw {
        kind: "write_failed",
        conversation_id: id,
        cause: errMsg(err),
      } satisfies SessionStoreError;
    }
  }

  /**
   * Rewind = MOVE the persisted head
   * pointer to an earlier turn-boundary anchor. The skipped chain STAYS in
   * the same JSONL — the write is a header-refresh (recomputed
   * turnCount/title, pruned + event-id-re-anchored checkpoints) plus one
   * trailing head record; no event record is ever dropped. The legacy
   * `.json` mirror is NOT refreshed (mirror write removed); the
   * returned projection is recomputed from the JSONL head chain.
   *
   * `keepTurns` is clamped to [0, availableTurns]; a target at/above the
   * available turns is a no-op (nothing written) and returns exactly what
   * load() sees. The anchor always lands on a turn END, so a mid-turn tool
   * pair can never be split (same boundary rule as the retired rewindFile
   * truncation).
   *
   * JSONL-only: a legacy `.json`-only session fails with write_failed (the
   * migration signal — the hub retries via load+save). MUST be called under
   * the hub serialize queue (same posture as appendEvents/writeHead).
   * Throws: not_found | write_failed | parse_failed | schema_invalid | io_error
   */
  async rewindToAnchor(opts: {
    readonly id: string;
    readonly keepTurns: number;
  }): Promise<{ readonly file: SessionFileV1 }> {
    const { id, keepTurns } = opts;
    const path = this.jsonlPath(id);
    const log = await this.readJsonlLog(id, path, {
      legacyIsWriteFailed: true,
    });
    let chain: ReadonlyArray<SessionEventRecord>;
    try {
      chain = headChainEvents(log);
    } catch (err) {
      throw this.attachId(id, err);
    }
    const { headIndex } = resolveRewindAnchor(
      chain.map((e) => e.message),
      keepTurns
    );
    const newHead = headIndex < 0 ? null : chain[headIndex]!.id;
    return this.persistHeadMove(id, path, log, newHead);
  }

  /**
   * Move the persisted head to an event id (or null). The target may
   * be off the current chain — skipped-branch undo. Unknown ids are
   * schema_invalid. Same append-only write as rewindToAnchor.
   */
  async rewindToHead(opts: {
    readonly id: string;
    readonly head: string | null;
  }): Promise<{ readonly file: SessionFileV1 }> {
    const { id, head } = opts;
    const path = this.jsonlPath(id);
    const log = await this.readJsonlLog(id, path, {
      legacyIsWriteFailed: true,
    });
    if (head !== null && !log.events.some((e) => e.id === head)) {
      throw {
        kind: "schema_invalid",
        conversation_id: id,
        field: "head",
      } satisfies SessionStoreError;
    }
    return this.persistHeadMove(id, path, log, head);
  }

  /** Picker rows from the current head chain (skipped branches omitted). */
  async listRewindTargets(
    id: string
  ): Promise<ReadonlyArray<LedgerRewindTarget>> {
    const path = this.jsonlPath(id);
    const raw = await this.tryReadFile(path, id);
    if (raw !== null) {
      try {
        return buildRewindTargetsFromLog(parseSessionJsonl(raw));
      } catch (err) {
        throw this.attachId(id, err);
      }
    }
    const file = await this.load(id);
    return buildRewindTargetsFromLog(
      parseSessionJsonl(sessionFileToJsonl(file))
    );
  }

  /**
   * Every event a rewind to `newHead` would abandon: the current head chain,
   * minus everything still kept under `newHead`, in current-chain order — no
   * content filter. The rewind orchestrator reads the unfiltered segment to
   * find the `spawn_subagent` tool_uses inside it (worker transcripts join the
   * restore through those ids); file refs come from `rewindablePreimages`.
   * Read-only and same error surface as `rewindToHead` (unknown `newHead` →
   * schema_invalid).
   */
  async abandonedEvents(
    id: string,
    newHead: string | null
  ): Promise<ReadonlyArray<SessionEventRecord>> {
    const raw = await this.tryReadFile(this.jsonlPath(id), id);
    if (raw === null) return [];
    let current: ReadonlyArray<SessionEventRecord>;
    let kept: ReadonlyArray<SessionEventRecord>;
    try {
      const log = parseSessionJsonl(raw);
      current = headChainEvents(log);
      kept = chainFromHead(log, newHead);
    } catch (err) {
      throw this.attachId(id, err);
    }
    const keptIds = new Set(kept.map((e) => e.id));
    return current.filter((e) => !keptIds.has(e.id));
  }

  /**
   * The preimage-bearing events a rewind to `newHead` would abandon: the
   * current head chain, minus everything still kept under `newHead`, in
   * current-chain order. Read-only — a legacy `.json`-only session has no
   * captured refs (JSONL is a prerequisite), so it returns empty rather than
   * forcing the migrate-on-write the head move already does. Unknown `newHead`
   * surfaces as schema_invalid, same as rewindToHead.
   */
  async rewindablePreimages(
    id: string,
    newHead: string | null
  ): Promise<ReadonlyArray<SessionEventRecord>> {
    const abandoned = await this.abandonedEvents(id, newHead);
    return abandoned.filter((e) => e.codePreimage !== undefined);
  }

  private async persistHeadMove(
    id: string,
    path: string,
    log: ParsedSessionLog,
    newHead: string | null
  ): Promise<{ readonly file: SessionFileV1 }> {
    if (newHead === log.head) {
      return { file: await this.load(id) };
    }
    let kept: ReadonlyArray<SessionEventRecord>;
    try {
      kept = chainFromHead(log, newHead);
    } catch (err) {
      throw this.attachId(id, err);
    }
    const keptMessages = kept.map((e) => e.message);
    const keptIds = kept.map((e) => e.id);
    const turnCount = splitTurns(keptMessages).length;
    const { type: _type, ...meta } = log.header;
    const survivors = (log.header.checkpoints ?? []).filter(
      (c) => c.turnIndex < turnCount
    );
    const file = sanitizeSessionFile({
      ...meta,
      messages: keptMessages,
      turnCount,
      // ADR-0113 overwrite gate: with a title event present the header cache
      // = event text, and rewind's extractTitle recomputation must not
      // overwrite it; no title event → today's behavior unchanged.
      title: resolveTitleText(log, extractTitle(keptMessages)),
      updatedAt: new Date().toISOString(),
      checkpoints: withCheckpointAnchors(survivors, keptIds),
    });
    const { messages: _messages, ...fileMeta } = file;
    const jsonl = serializeSessionLog(fileMeta, [
      ...log.records,
      { type: "head", id: newHead },
    ]);
    const projected = {
      ...file,
      messages: closeoutOrphanToolUses(file.messages),
    };
    const jsonlTmp = `${path}.tmp`;
    try {
      await writeFile(jsonlTmp, jsonl, "utf8");
      await rename(jsonlTmp, path);
    } catch (err) {
      throw {
        kind: "write_failed",
        conversation_id: id,
        cause: errMsg(err),
      } satisfies SessionStoreError;
    }
    return { file: projected };
  }

  /**
   * List all session files sorted by updatedAt descending — the presentation
   * projection (TUI / web picker).
   * Corrupt / unreadable files are silently skipped (sidebar must not break).
   * Sessions with no assistant text are skipped too: bootstrap
   * creates an empty session file before the user ever sends a message, and an
   * interrupted sendMessage can leave one with no assistant reply — neither has
   * anything to show in the sidebar. Blank titles are skipped as well, except an
   * invalid workspace binding, which stays listed so it can be rebound.
   * See `ListProjection` for why the two projections differ.
   * Single-session load()/get() is unaffected.
   * Throws: io_error (only for directory-level failures)
   */
  async list(): Promise<SessionListEntry[]> {
    return this.scanList("presentation");
  }

  /**
   * Occupancy enumeration for ADR-0070 exclusive worktrees: the same scan with
   * the presentation blank-title filter lifted, so `enter()` sees a claim
   * whenever a session's persisted workspaceRoot matches. Read-only; never
   * mutates. See `ListProjection`.
   *
   * Residual (pre-existing, out of scope here): the no-assistant-text filter and
   * the skip-corrupt policy still apply, so a just-bootstrapped claim with no
   * assistant reply yet, or an unreadable record, stays invisible here too.
   */
  async listWorkspaceClaims(): Promise<SessionListEntry[]> {
    return this.scanList("occupancy");
  }

  private async scanList(
    projection: ListProjection
  ): Promise<SessionListEntry[]> {
    const names = await this.readDir();
    // Session-folder consolidation: the project dir holds one folder
    // per conversationId. Each folder contains the JSONL authority and the
    // legacy mirror (same on-disk shape contract as before; only the layout
    // changed). Sub-folder names are conversationId-shaped (sanitized) —
    // we feed them straight into tryListEntry() because the load path
    // already accepts the sanitized form.
    const ids = new Set<string>();
    for (const name of names) {
      if (name.endsWith(SESSION_JSONL_EXT) || name.endsWith(".json")) {
        // Direct file under projectDir — legacy flat layout, ignore.
        continue;
      }
      ids.add(name);
    }
    const entries: SessionListEntry[] = [];
    for (const id of ids) {
      const entry = await this.tryListEntry(id, projection);
      if (entry) entries.push(entry);
    }
    entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return entries;
  }

  /**
   * Delete a session file (both on-disk shapes).
   * Throws: not_found | io_error
   */
  async delete(id: string): Promise<void> {
    // Session-folder consolidation: delete the entire conversation
    // folder under <projectDir>/<id>/. The folder may contain both the
    // JSONL authority and the legacy mirror (callers from before the mirror
    // removal could still leave one behind); rmdir recursive removes
    // them atomically.
    const dir = this.conversationDir(id);
    // Probe presence BEFORE rm — force:true would otherwise silently
    // swallow the not_found signal we owe the caller.
    let existed = false;
    try {
      await stat(dir);
      existed = true;
    } catch (err) {
      if (!isEnoent(err)) {
        throw {
          kind: "io_error",
          conversation_id: id,
          cause: errMsg(err),
        } satisfies SessionStoreError;
      }
    }
    if (!existed) {
      throw {
        kind: "not_found",
        conversation_id: id,
      } satisfies SessionStoreError;
    }
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      throw {
        kind: "io_error",
        conversation_id: id,
        cause: errMsg(err),
      } satisfies SessionStoreError;
    }
  }

  // -- private helpers -------------------------------------------------------

  private filePath(id: string): string {
    return join(this.conversationDir(id), `${id}.json`);
  }

  private jsonlPath(id: string): string {
    return join(this.conversationDir(id), `${id}${SESSION_JSONL_EXT}`);
  }

  /** Append one off-chain record line. Shared by the two ADR-0136 writers —
   *  neither touches the message chain or the head pointer. */
  private async appendTailRecord(
    id: string,
    path: string,
    record: SessionTailRecord
  ): Promise<void> {
    try {
      await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    } catch (err) {
      throw writeFailedFor(id, err);
    }
  }

  /** Map a body-pool failure onto the store's error vocabulary WITHOUT
   *  collapsing the states an entry reader must tell apart: an absent body, a
   *  body whose bytes are damaged, and a body that is not a valid state stay
   *  three distinct kinds. A real IO fault stays `io_error` so it can never be
   *  read as "nothing was published".
   *
   *  The kind set is the body pool's own, spelled out. A `bodySha` the caller
   *  rejected before any filesystem access is `schema_invalid` at the call
   *  site, so no `invalid_sha` branch can be reached here. */
  private attachBodyError(id: string, err: unknown): SessionStoreError {
    if (err instanceof Error) {
      return { kind: "io_error", conversation_id: id, cause: errMsg(err) };
    }
    const e = err as {
      kind?: string;
      reason?: unknown;
      field?: unknown;
    };
    if (e.kind === "native_state_body_missing") {
      return { kind: "not_found", conversation_id: id };
    }
    if (e.kind === "native_state_body_corrupt") {
      return {
        kind: "parse_failed",
        conversation_id: id,
        reason: typeof e.reason === "string" ? e.reason : "unknown",
      };
    }
    if (e.kind === "native_state_body_schema_invalid") {
      return {
        kind: "schema_invalid",
        conversation_id: id,
        field: typeof e.field === "string" ? e.field : "snapshot",
      };
    }
    // EXIT: a throw that is neither an `Error` nor one of the pool's typed
    // kinds is not this store's vocabulary to interpret. Re-throwing it keeps
    // an unrelated failure from being filed as a schema violation of the
    // snapshot; the three cases above are the complete set.
    throw err;
  }

  /** readFile that tolerates absence: null on ENOENT, io_error otherwise. */
  private async tryReadFile(path: string, id: string): Promise<string | null> {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if (isEnoent(err)) return null;
      throw {
        kind: "io_error",
        conversation_id: id,
        cause: errMsg(err),
      } satisfies SessionStoreError;
    }
  }

  /**
   * Read + parse the JSONL log for the append/head primitives. JSONL-only:
   * missing log → not_found when no session file exists at all; when only the
   * legacy `.json` mirror exists, write paths ask for write_failed (migration
   * hint: save once to rewrite as JSONL), read paths ask for not_found
   * (a legacy session has no persisted head).
   */
  private async readJsonlLog(
    id: string,
    path: string,
    opts: { readonly legacyIsWriteFailed: boolean }
  ): Promise<ParsedSessionLog> {
    const raw = await this.tryReadFile(path, id);
    if (raw === null) {
      const legacy = await this.tryReadFile(this.filePath(id), id);
      if (legacy !== null && opts.legacyIsWriteFailed) {
        throw {
          kind: "write_failed",
          conversation_id: id,
          cause:
            "session log is legacy JSON; save once to rewrite as JSONL before appending",
        } satisfies SessionStoreError;
      }
      throw {
        kind: "not_found",
        conversation_id: id,
      } satisfies SessionStoreError;
    }
    try {
      return parseSessionJsonl(raw);
    } catch (err) {
      throw this.attachId(id, err);
    }
  }

  /** Reattach conversation_id to a pure-codec error (jsonl.ts throws without
   *  store identity, same convention as sanitizeSessionFile). */
  private attachId(id: string, err: unknown): SessionStoreError {
    const e = err as { kind?: string; reason?: unknown; field?: unknown };
    if (e.kind === "parse_failed") {
      return {
        kind: "parse_failed",
        conversation_id: id,
        reason: typeof e.reason === "string" ? e.reason : "unknown",
      };
    }
    return {
      kind: "schema_invalid",
      conversation_id: id,
      field: typeof e.field === "string" ? e.field : "root",
    };
  }

  private async readRaw(id: string): Promise<string> {
    try {
      return await readFile(this.filePath(id), "utf8");
    } catch (err) {
      if (isEnoent(err)) {
        throw {
          kind: "not_found",
          conversation_id: id,
        } satisfies SessionStoreError;
      }
      throw {
        kind: "io_error",
        conversation_id: id,
        cause: errMsg(err),
      } satisfies SessionStoreError;
    }
  }

  private parseJson(opts: {
    readonly id: string;
    readonly raw: string;
  }): unknown {
    const { id, raw } = opts;
    try {
      return JSON.parse(raw);
    } catch {
      // Excerpt of the raw content aids debugging without leaking full file.
      throw {
        kind: "parse_failed",
        conversation_id: id,
        reason: raw.slice(0, 120),
      } satisfies SessionStoreError;
    }
  }

  private async readDir(): Promise<string[]> {
    try {
      return await readdir(this.projectDir);
    } catch (err) {
      if (isEnoent(err)) return []; // no sessions yet
      throw {
        kind: "io_error",
        conversation_id: "",
        cause: errMsg(err),
      } satisfies SessionStoreError;
    }
  }

  private async tryListEntry(
    id: string,
    projection: ListProjection
  ): Promise<SessionListEntry | null> {
    try {
      const file = await this.load(id);
      return this.buildListEntry(
        file,
        await this.classifyWorkspaceRoot(file.workspaceRoot),
        projection
      );
    } catch (err) {
      if (!isInvalidWorkspaceRootError(err)) return null;
      return this.tryListInvalidWorkspaceRoot(id, projection);
    }
  }

  /**
   * Keep a session visible when only its workspaceRoot is malformed.
   *
   * The normal load path must continue rejecting malformed schema. For list,
   * however, hiding a session makes it impossible to bind/recreate it. This
   * read-only recovery removes the invalid field from an in-memory projection
   * solely so the rest of the session can be summarized; it never writes a
   * repaired file or backfills cwd.
   */
  private async tryListInvalidWorkspaceRoot(
    id: string,
    projection: ListProjection
  ): Promise<SessionListEntry | null> {
    try {
      const jsonlRaw = await this.tryReadFile(this.jsonlPath(id), id);
      if (jsonlRaw !== null) {
        const log = parseSessionJsonl(jsonlRaw);
        const header = { ...log.header } as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(header, "workspaceRoot")) {
          return null;
        }
        const invalidRoot = header["workspaceRoot"];
        delete header["workspaceRoot"];
        const file = projectSessionLog({
          ...log,
          header: header as unknown as typeof log.header,
        });
        return this.buildListEntry(file, "invalid", projection, invalidRoot);
      }

      const raw = await this.tryReadFile(this.filePath(id), id);
      if (raw === null) return null;
      const parsed = this.parseJson({ id, raw });
      if (parsed === null || typeof parsed !== "object") return null;
      const legacy = parsed as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(legacy, "workspaceRoot")) {
        return null;
      }
      const invalidRoot = legacy["workspaceRoot"];
      delete legacy["workspaceRoot"];
      const file = sanitizeSessionFile(legacy);
      return this.buildListEntry(file, "invalid", projection, invalidRoot);
    } catch {
      // The recovery is only for a workspaceRoot schema failure. Any other
      // malformed or unreadable content retains list()'s skip-corrupt policy.
      return null;
    }
  }

  private async classifyWorkspaceRoot(
    workspaceRoot: string | undefined
  ): Promise<SessionBindingStatus> {
    if (workspaceRoot === undefined) return "unbound";
    if (
      !isAbsolute(workspaceRoot) ||
      workspaceRoot.length === 0 ||
      workspaceRoot.length > MAX_WORKSPACE_ROOT_CHARS
    ) {
      return "invalid";
    }
    try {
      return (await stat(workspaceRoot)).isDirectory() ? "bound" : "invalid";
    } catch {
      return "invalid";
    }
  }

  private async buildListEntry(
    file: SessionFileV1,
    bindingStatus: SessionBindingStatus,
    projection: ListProjection,
    rawWorkspaceRoot?: unknown
  ): Promise<SessionListEntry | null> {
    const lastFinalText = lastAssistantText(file.messages);
    if (!lastFinalText.trim()) return null;
    // Presentation hides blank titles; occupancy does not. Invalid bindings
    // always stay listed for rebind recovery. See `ListProjection`.
    if (
      projection === "presentation" &&
      !file.title.trim() &&
      bindingStatus !== "invalid"
    )
      return null;
    const workspaceRoot =
      typeof rawWorkspaceRoot === "string"
        ? rawWorkspaceRoot
        : file.workspaceRoot;
    return {
      conversation_id: file.conversation_id,
      updatedAt: file.updatedAt,
      lastFinalText,
      title: file.title,
      bindingStatus,
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    };
  }
}

// -- module-level helpers ----------------------------------------------------

/**
 * ADR-0113 overwrite gate (save choke point): when the on-disk log already
 * has a title event, the header `title` cache is always written as the
 * latest event text — the extractTitle recomputations passed in by every
 * caller (hub conditionalSave / compact, CLI, …) are intercepted here and
 * cannot reach disk. No title event (log null / legacy file) → pass through
 * verbatim, byte-identical to the previous behavior.
 */
function gateTitleToEvent(
  file: SessionFileV1,
  log: ParsedSessionLog | null
): SessionFileV1 {
  const title = resolveTitleText(log, file.title);
  return title === file.title ? file : { ...file, title };
}

/** Save plan: the JSONL text to persist. The mirror `.json` file write was
 *  removed, so the save plan now only carries the JSONL bytes. */
interface SavePlan {
  readonly jsonl: string;
}

/**
 * Append-only aware save planning. Aligns `file.messages` with
 * the persisted head chain by longest common prefix (LCP) and picks the
 * cheapest write that keeps every existing record:
 *   identical      → header-refresh only;
 *   extension      → append the tail events, parented at the current head;
 *   strict prefix  → append only a head record (head moves backward);
 *   fork           → append the divergent suffix parented at the LCP end.
 * `log === null` (fresh / legacy-only / corrupt) → full rewrite. Pure.
 */
function planSessionSave(
  file: SessionFileV1,
  log: ParsedSessionLog | null
): SavePlan {
  if (log === null) return fullRewritePlan(file);
  let chain: ReadonlyArray<SessionEventRecord>;
  try {
    chain = headChainEvents(log);
  } catch {
    return fullRewritePlan(file); // cycle / dangling head → self-heal
  }
  const messages = file.messages;
  const limit = Math.min(messages.length, chain.length);
  let prefixLen = 0;
  while (
    prefixLen < limit &&
    jsonDeepEqual(messages[prefixLen], chain[prefixLen]!.message)
  ) {
    prefixLen++;
  }
  const records: SessionTailRecord[] = [...log.records];
  let finalIds: string[];
  if (prefixLen === chain.length && messages.length === chain.length) {
    // Identical projection: header-refresh only, no new records.
    finalIds = chain.map((e) => e.id);
  } else if (prefixLen === chain.length) {
    // Extension: the head chain is a prefix of the projection.
    const appended = buildEventRecords(
      messages.slice(prefixLen),
      log.maxEventIndex + 1,
      log.head
    );
    records.push(...appended.events, appended.head);
    finalIds = [...chain.map((e) => e.id), ...appended.events.map((e) => e.id)];
  } else if (prefixLen === messages.length) {
    // Strict prefix (reset-shaped): move the head backward, append nothing.
    const newHead = prefixLen === 0 ? null : chain[prefixLen - 1]!.id;
    records.push({ type: "head", id: newHead });
    finalIds = chain.slice(0, prefixLen).map((e) => e.id);
  } else {
    // Fork: the projection diverges from the chain at prefixLen.
    const parent = prefixLen === 0 ? null : chain[prefixLen - 1]!.id;
    const appended = buildEventRecords(
      messages.slice(prefixLen),
      log.maxEventIndex + 1,
      parent
    );
    records.push(...appended.events, appended.head);
    finalIds = [
      ...chain.slice(0, prefixLen).map((e) => e.id),
      ...appended.events.map((e) => e.id),
    ];
  }
  const finalFile = withDerivedAnchors(file, finalIds);
  const { messages: _messages, ...meta } = finalFile;
  return { jsonl: serializeSessionLog(meta, records) };
}

/** Full-rewrite plan (fresh session / legacy migration / corrupt-log
 *  self-heal): header + one event per message + head. */
function fullRewritePlan(file: SessionFileV1): SavePlan {
  const ids = file.messages.map((_, i) => messageEventId(i));
  const finalFile = withDerivedAnchors(file, ids);
  return { jsonl: sessionFileToJsonl(finalFile) };
}

/** Derive checkpoint `anchorEventId`s against a chain's event
 *  ids. Files without a checkpoints key pass through untouched (the key is
 *  not materialized). */
function withDerivedAnchors(
  file: SessionFileV1,
  eventIds: ReadonlyArray<string>
): SessionFileV1 {
  if (file.checkpoints === undefined) return file;
  return {
    ...file,
    checkpoints: withCheckpointAnchors(file.checkpoints, eventIds),
  };
}

/** Build chained event records + the trailing head record for an appended
 *  tail, numbering from `startIndex` and parenting the first at `parent`. */
function buildEventRecords(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  startIndex: number,
  parent: string | null
): {
  readonly events: SessionEventRecord[];
  readonly head: SessionHeadRecord;
} {
  let next = startIndex;
  let cur = parent;
  const events: SessionEventRecord[] = [];
  for (const message of messages) {
    const id = messageEventId(next++);
    events.push({ type: "message", id, parent: cur, message });
    cur = id;
  }
  return { events, head: { type: "head", id: cur } };
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function invalidFor(id: string, field: string): SessionStoreError {
  return { kind: "schema_invalid", conversation_id: id, field };
}

/** Whether an existing record already carries this `factId` (the dedup key). */
function isSameFactId(record: SessionTailRecord, factId: string): boolean {
  return record.type === "operation_fact" && record.factId === factId;
}

/** The `bodySha` of the last state published in this log, or null when the
 *  session has published none. File order IS the publication order, so no
 *  timestamp comparison is involved. */
function lastPublishedBodySha(log: ParsedSessionLog): string | null {
  for (let i = log.records.length - 1; i >= 0; i--) {
    const record = log.records[i];
    if (record !== undefined && record.type === "native_state") {
      return record.bodySha;
    }
  }
  return null;
}

function writeFailedFor(id: string, err: unknown): SessionStoreError {
  return { kind: "write_failed", conversation_id: id, cause: errMsg(err) };
}

function isInvalidWorkspaceRootError(err: unknown): boolean {
  const e = err as { kind?: unknown; field?: unknown };
  return e.kind === "schema_invalid" && e.field === "workspaceRoot";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extract joined text from the most recent assistant message with
 * non-whitespace text ("" if none).
 */
function lastAssistantText(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .filter(
        (b): b is Extract<AnthropicContentBlock, { type: "text" }> =>
          b.type === "text"
      )
      .map((b) => b.text)
      .join(" ");
    if (text.trim()) return text;
  }
  return "";
}
