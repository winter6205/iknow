/**
 * Stateless filesystem-backed session store (022 spec §Session Store).
 *
 * Why stateless: concurrency serialization is the hub's responsibility
 * (spec A15). This class is a thin typed-IO wrapper over data/sessions/*.
 * Every failure path throws a typed SessionStoreError — never a bare Error.
 *
 * #618 T1 (spec session-jsonl-resume / ADR-0027): single on-disk shape.
 *   - Authority: `<id>.jsonl` — single-file append-only JSONL (session header
 *     record, id/parent message events, trailing head record; codec in
 *     jsonl.ts). save() writes ONLY this; load() prefers it.
 *   - Read fallback: `<id>.json` — legacy SessionFileV1 JSON, ONLY read by
 *     load() during the migration window (#619 T2: legacy-only `.json` →
 *     load → save → JSONL authority on the next save). save() does NOT
 *     write the legacy mirror (#629: expand-phase compat ended, tests
 *     migrated off direct `.json` reads).
 *   - Detection is by EXTENSION: load prefers `<id>.jsonl`, falls back to
 *     `<id>.json` (legacy path unchanged).
 *   - appendEvents/readHead/writeHead are JSONL-only primitives (T3's commit
 *     hooks and T5's rewind build on them). They MUST be called under the
 *     hub serialize queue — the store stays stateless, no in-store locking
 *     (same posture as save(); spec Testing Decisions concurrent 类).
 *   - #622 T5: save() is append-only AWARE — it aligns the caller's
 *     projection with the persisted head chain (longest common prefix) and
 *     only appends the divergent tail, so a rewound-away branch survives
 *     every subsequent save. rewindToAnchor() moves the persisted head to
 *     an earlier turn boundary WITHOUT truncating the log.
 */
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../harness/index.js";
import type { SessionStoreError } from "./errors.js";
import { closeoutOrphanToolUses } from "./closeout-projection.js";
import {
  resolveRewindAnchor,
  splitTurns,
  withCheckpointAnchors,
} from "./checkpoint.js";
import type {
  ParsedSessionLog,
  SessionEventRecord,
  SessionHeadRecord,
} from "./jsonl.js";
import {
  chainFromHead,
  headChainEvents,
  jsonDeepEqual,
  messageEventId,
  parseSessionJsonl,
  projectSessionLog,
  serializeSessionLog,
  SESSION_JSONL_EXT,
  sessionFileToJsonl,
} from "./jsonl.js";
import {
  buildRewindTargetsFromLog,
  type LedgerRewindTarget,
} from "./rewind-targets.js";
import type { SessionFileV1 } from "./schema.js";
import { extractTitle, sanitizeSessionFile } from "./schema.js";

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
  /** UI title excerpt (#467 renamed from `summary`). */
  readonly title: string;
  /** Per-session workspace-root bind (ABS optional; absent = unbound,
   *  legacy files sanitize through). Wire field name stays
   *  `workspaceRoot` (snake-less camel) to match the file shape verbatim. */
  readonly workspaceRoot?: string;
}

/**
 * Project namespace under the shared pool root (spec #120 SC 1).
 *
 * Layout: `<baseDir>/sessions/<basename(cwd)>-<sha1(cwd)[:12]>`.
 * basename keeps it human-browsable; the sha1 suffix disambiguates same-named
 * projects at different paths. Pure: no IO.
 */
export function resolveProjectSessionDir(baseDir: string, cwd: string): string {
  const digest = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
  return join(baseDir, "sessions", `${basename(cwd)}-${digest}`);
}

export class SessionStore {
  private readonly dir: string;

  constructor(baseDir: string, cwd: string = process.cwd()) {
    this.dir = resolveProjectSessionDir(baseDir, cwd);
  }

  /**
   * Load and validate a session file.
   * Detection by extension: `<id>.jsonl` (JSONL authority, projected to the
   * current-head transcript) wins; otherwise legacy `<id>.json`.
   * The JSONL projection backfills synthetic tool_result(s) for orphan
   * tool_use(s) — process closeout, #621 T4 — so consumers never receive an
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
        // T5 (spec D3): migrate messagesCount-only checkpoints to their
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
      // T5 (spec D3): a legacy file's message order is exactly what the
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
   * is NOT written (#629: expand-phase compat ended; tests migrated off
   * direct `.json` reads). Load still falls back to a legacy-only `.json`,
   * so a legacy-only session's first save migrates it to JSONL authority
   * (`fullRewritePlan` is the natural migrator — the `readJsonlLog` not_found
   * branch sets `log = null` and triggers it).
   *
   * #622 T5: the JSONL write is append-only AWARE (planSessionSave). The
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
   * or a corrupt log falls back to a full rewrite (self-heal; the pre-T5
   * shape).
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
      await mkdir(this.dir, { recursive: true });
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
      const plan = planSessionSave(file, log);
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
   * (#618 T1; T3's host-injected commit hooks call this mid-turn). Each event
   * gets a fresh `e<maxIndex+1>` id chained from the persisted head, followed
   * by a new head record — so a backward head (rewind) forks a new branch and
   * the old chain stays in the file.
   *
   * Cheap = append-only (one read of the log + one append syscall); safe to
   * call repeatedly. MUST be called under the hub serialize queue (the store
   * is stateless; no in-store locking — spec Testing Decisions concurrent 类).
   *
   * JSONL-only: a legacy `.json`-only session must be save()d once first
   * (T2 migration-on-save). Empty `events` is a no-op.
   * Throws: not_found | write_failed | parse_failed | schema_invalid | io_error
   */
  async appendEvents(opts: {
    readonly id: string;
    readonly events: ReadonlyArray<AnthropicNativeMessage>;
  }): Promise<void> {
    const { id, events } = opts;
    if (events.length === 0) return;
    const path = this.jsonlPath(id);
    const log = await this.readJsonlLog(id, path, {
      legacyIsWriteFailed: true,
    });
    let next = log.maxEventIndex + 1;
    let parent = log.head;
    const lines: string[] = [];
    for (const message of events) {
      const eventId = messageEventId(next++);
      // 每条事件自己的入账时刻(T3 commit pattern 下 user/assistant/tool
      // 各自的时间戳彼此接近但可分辨 — plan Open questions #3)。
      const record: SessionEventRecord = {
        type: "message",
        id: eventId,
        parent,
        message,
        createdAt: new Date().toISOString(),
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
   * Read the persisted rewind head (event id, null = empty transcript).
   * JSONL-only primitive (T5 consumes it; legacy sessions have no persisted
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
   * id in the log. T5 owns the rewind semantics built on this primitive.
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
   * T5 (#622 / spec session-jsonl-resume): rewind = MOVE the persisted head
   * pointer to an earlier turn-boundary anchor. The skipped chain STAYS in
   * the same JSONL — the write is a header-refresh (recomputed
   * turnCount/title, pruned + event-id-re-anchored checkpoints) plus one
   * trailing head record; no event record is ever dropped. The legacy
   * `.json` mirror is NOT refreshed (#629: mirror write removed); the
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
   * #624: move the persisted head to an event id (or null). The target may
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
      title: extractTitle(keptMessages),
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
   * List all session files sorted by updatedAt descending.
   * Corrupt / unreadable files are silently skipped (sidebar must not break).
   * Sessions with no assistant text are skipped too (issue #96): bootstrap
   * creates an empty session file before the user ever sends a message, and an
   * interrupted sendMessage can leave one with no assistant reply — neither has
   * anything to show in the sidebar. Single-session load()/get() is unaffected.
   * Throws: io_error (only for directory-level failures)
   */
  async list(): Promise<SessionListEntry[]> {
    const names = await this.readDir();
    // Both on-disk shapes live in the same dir (#120 Q6: all entries read the
    // same store); dedupe ids present in both (load prefers the JSONL).
    const ids = new Set<string>();
    for (const name of names) {
      if (name.endsWith(SESSION_JSONL_EXT)) {
        ids.add(name.slice(0, -SESSION_JSONL_EXT.length));
      } else if (name.endsWith(".json")) {
        ids.add(name.slice(0, -".json".length));
      }
    }
    const entries: SessionListEntry[] = [];
    for (const id of ids) {
      const entry = await this.tryListEntry(id);
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
    let removed = false;
    for (const path of [this.jsonlPath(id), this.filePath(id)]) {
      try {
        await unlink(path);
        removed = true;
      } catch (err) {
        if (!isEnoent(err)) {
          throw {
            kind: "io_error",
            conversation_id: id,
            cause: errMsg(err),
          } satisfies SessionStoreError;
        }
      }
    }
    if (!removed) {
      throw {
        kind: "not_found",
        conversation_id: id,
      } satisfies SessionStoreError;
    }
  }

  // -- private helpers -------------------------------------------------------

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private jsonlPath(id: string): string {
    return join(this.dir, `${id}${SESSION_JSONL_EXT}`);
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
   * hint: save once to rewrite as JSONL, T2), read paths ask for not_found
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
      return await readdir(this.dir);
    } catch (err) {
      if (isEnoent(err)) return []; // no sessions yet
      throw {
        kind: "io_error",
        conversation_id: "",
        cause: errMsg(err),
      } satisfies SessionStoreError;
    }
  }

  private async tryListEntry(id: string): Promise<SessionListEntry | null> {
    try {
      const file = await this.load(id);
      const lastFinalText = lastAssistantText(file.messages);
      // issue #96: skip sessions with no assistant text — bootstrap writes an
      // empty file before the user sends anything, and an interrupted
      // sendMessage can leave one with no reply. Nothing to show in the
      // sidebar; single-session load()/get() is unaffected.
      if (!lastFinalText.trim()) return null;
      return {
        conversation_id: id,
        updatedAt: file.updatedAt,
        lastFinalText,
        title: file.title,
        // Spread only the additive optional field; sanitize never emits
        // `workspaceRoot: undefined` (spread-discipline), so absence on the
        // entry is the same absence on the file — the Postel contract.
        ...(file.workspaceRoot !== undefined
          ? { workspaceRoot: file.workspaceRoot }
          : {}),
      };
    } catch {
      return null; // skip corrupt / unreadable files
    }
  }
}

// -- module-level helpers ----------------------------------------------------

/** T5 save plan: the JSONL text to persist. The mirror `.json` file was
 *  removed in #629, so the save plan now only carries the JSONL bytes. */
interface SavePlan {
  readonly jsonl: string;
}

/**
 * T5 (#622): append-only aware save planning. Aligns `file.messages` with
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
  const records: Array<SessionEventRecord | SessionHeadRecord> = [
    ...log.records,
  ];
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
 *  self-heal): the pre-T5 shape — header + one event per message + head. */
function fullRewritePlan(file: SessionFileV1): SavePlan {
  const ids = file.messages.map((_, i) => messageEventId(i));
  const finalFile = withDerivedAnchors(file, ids);
  return { jsonl: sessionFileToJsonl(finalFile) };
}

/** T5 (spec D3): derive checkpoint `anchorEventId`s against a chain's event
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Extract joined text from the most recent assistant message ("" if none). */
function lastAssistantText(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    return msg.content
      .filter(
        (b): b is Extract<AnthropicContentBlock, { type: "text" }> =>
          b.type === "text"
      )
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}
