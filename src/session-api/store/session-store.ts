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
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import path from "node:path";
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
import { MAX_WORKSPACE_ROOT_CHARS } from "../../config/workspace-root.js";
import {
  MAX_ROOT_DETAIL_CHARS,
  sanitizeConversationSegment,
  SessionRootError,
} from "../../harness/session-roots.js";

export type SessionBindingStatus = "unbound" | "invalid" | "bound";

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
  /** Whether the persisted workspace binding is executable as-is. */
  readonly bindingStatus: SessionBindingStatus;
  /** Per-session workspace-root bind (ABS optional; absent = unbound,
   *  legacy files sanitize through). Wire field name stays
   *  `workspaceRoot` (snake-less camel) to match the file shape verbatim. */
  readonly workspaceRoot?: string;
}

/**
 * Project namespace under the shared pool root.
 *
 * T1 (plans/session-folder-consolidation.md / ADR-0071 Decision 1/2) — the
 * grouping key is `projectIdentityRoot`, not `cwd`. cwd moves with worktree
 * rebinds; the identity root is stable across rebinds (per
 * `docs/CONTEXT.md`), which is the grouping semantic the spec requires.
 *
 * Layout: `<baseDir>/projects/<basename(root)>-<sha1(root)[:12]>`.
 * basename keeps it human-browsable; the sha1 suffix disambiguates same-named
 * projects at different paths. Pure: no IO, no `process.cwd()` fallback.
 *
 * SC4: empty / blank / relative / non-normalizable inputs fail closed with a
 * typed `SessionRootError` (same kind vocabulary as `resolveSessionRoots`).
 * The default-cwd fallback of the pre-T1 contract was removed: a caller
 * without an explicit root must decide where the namespace belongs.
 */
export function resolveProjectSessionDir(
  baseDir: string,
  projectIdentityRoot: string
): string {
  requireValidRoot(projectIdentityRoot, "projectIdentityRoot");
  const digest = createHash("sha1")
    .update(projectIdentityRoot)
    .digest("hex")
    .slice(0, 12);
  return join(
    baseDir,
    "projects",
    `${basename(projectIdentityRoot)}-${digest}`
  );
}

/**
 * Resolve the per-conversation folder under an already-resolved project
 * directory (the output of `resolveProjectSessionDir`). The leaf is the
 * `conversationId` verbatim, so a UUID-shaped id passes through unchanged
 * (sanitize is the identity on `[A-Za-z0-9_-]`).
 *
 * SC2 (folder name = `conversationId` UUID verbatim) + SC4 (pure function,
 * no IO, no `process.cwd()` fallback). Path-hostile inputs (containing `/`
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
 * T3 (plans/session-folder-consolidation.md / ADR-0071 Decision 4):
 * per-conversation trace 锚点 = `<projectDir>/<conversationId>/trace.jsonl`。
 * 同一 baseDir + 同一 projectIdentityRoot + 同一 conversationId 必然派生出
 * 同一绝对文件路径 —— 不同 cwd 启动同一仓的同一会话,文件路径稳定
 * (跨 cwd 一致性 = plans/session-folder-consolidation.md SC6 的核心不变式)。
 *
 * 派生而不是字符串拼接:复用 `resolveConversationDir` 的 sanitize 与长度边界,
 * 避免在调用方各自重写 path-join 导致 `..` / `/` 逃逸的回退风险。
 */
export const TRACE_FILE_NAME = "trace.jsonl";

export function resolveConversationTraceFilePath(opts: {
  readonly projectDir: string;
  readonly conversationId: string;
}): string {
  return join(resolveConversationDir(opts), TRACE_FILE_NAME);
}

/**
 * T5 (plans/session-folder-consolidation.md / ADR-0071 Decision 1 +
 * ADR-0035 同日 Amendment):子代理记录嵌进父会话文件夹,落在
 * `<projectDir>/<conversationId>/subagents/` 下。
 *
 * 单文件聚合形态(`<traceOut>/subagent.jsonl`,conversationId="subagent",
 * 全机所有子代理聚合成一个文件)按 SC8 退役;改 per-agent 形态后,各子代理
 * 的 lifecycle / content trace + `.meta.json` 都按 taskId 散列到该目录下。
 *
 * 派生而不是字符串拼接:复用 `resolveConversationDir` 的 sanitize 与长度边界,
 * 保证同 `(projectDir, conversationId)` 派生到同一目录。
 */
export const SUBAGENT_TRACE_DIR_NAME = "subagents";

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
  if (trimmed === "" || trimmed.length > MAX_CONVERSATION_ID_BYTES) {
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
   * #950 T2 (plans/session-folder-consolidation.md):read-only projection of
   * the resolved session project directory
   * (`<baseDir>/projects/<basename>-<sha1[:12]>`). Consumers whose per-call
   * leaf lives INSIDE the session folder — the todo ledger `todoDir` seam
   * (`resolveConversationTodoPath`) and, from T3, the trace anchor — take
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
   *
   * D2 (tui-display-consistency):`thinkingMs` 是 assistant 回合落盘的思考
   * 时长(ms)。仅当 (a) 入参 `opts.thinkingMs` 提供 + (b) 事件 role 为
   * assistant 时挂到 event record 上;`thinkingMs <= 0` 或非有限数视为无效,
   * 字段缺席(spec 钉死边界形态)。tool_result / user / system 事件一律不挂
   * `thinkingMs` key(commit 缝是按 batch 传单值,只在 assistant commit 处
   * 携带;tool_result commit 时入参 undefined,即使 message.role 偶然是
   * assistant 也不挂,因为 hub 的 commit 闭包只在 stepWithTrace 主路径
   * 1746 处传 turnResult.thinkingMs)。
   */
  async appendEvents(opts: {
    readonly id: string;
    readonly events: ReadonlyArray<AnthropicNativeMessage>;
    /** D2: assistant commit 携带的思考时长(ms);tool_result / 其它批次 = undefined。 */
    readonly thinkingMs?: number;
  }): Promise<void> {
    const { id, events, thinkingMs } = opts;
    if (events.length === 0) return;
    const path = this.jsonlPath(id);
    const log = await this.readJsonlLog(id, path, {
      legacyIsWriteFailed: true,
    });
    // D2: 仅在 thinkingMs 边界形态合法时才落盘(> 0 且有限数)。
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
      // 每条事件自己的入账时刻(T3 commit pattern 下 user/assistant/tool
      // 各自的时间戳彼此接近但可分辨 — plan Open questions #3)。
      const record: SessionEventRecord = {
        type: "message",
        id: eventId,
        parent,
        message,
        createdAt: new Date().toISOString(),
        // D2: 仅 assistant 事件 + stampableThinkingMs 有效时挂 key。
        // batch 内 assistant 数量 = 1(loop-engine 一次 commit 恰好一
        // 条 assistant 消息),所以 conditional spread 不在 batch 内多
        // 事件场景下分叉 —— 所有事件同 key 表现。
        ...(message.role === "assistant" && stampableThinkingMs !== undefined
          ? { thinkingMs: stampableThinkingMs }
          : {}),
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
    // T1 (session-folder-consolidation): the project dir holds one folder
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
    // T1 (session-folder-consolidation): delete the entire conversation
    // folder under <projectDir>/<id>/. The folder may contain both the
    // JSONL authority and the legacy mirror (older #629-mirror-removed
    // callers could still leave one behind); rmdir recursive removes
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

  private async tryListEntry(id: string): Promise<SessionListEntry | null> {
    try {
      const file = await this.load(id);
      return this.buildListEntry(
        file,
        await this.classifyWorkspaceRoot(file.workspaceRoot)
      );
    } catch (err) {
      if (!isInvalidWorkspaceRootError(err)) return null;
      return this.tryListInvalidWorkspaceRoot(id);
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
    id: string
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
        return this.buildListEntry(file, "invalid", invalidRoot);
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
      return this.buildListEntry(file, "invalid", invalidRoot);
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
    rawWorkspaceRoot?: unknown
  ): Promise<SessionListEntry | null> {
    const lastFinalText = lastAssistantText(file.messages);
    if (!lastFinalText.trim()) return null;
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

function isInvalidWorkspaceRootError(err: unknown): boolean {
  const e = err as { kind?: unknown; field?: unknown };
  return e.kind === "schema_invalid" && e.field === "workspaceRoot";
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
