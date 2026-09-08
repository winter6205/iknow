/**
 * #440 T2/T3: todo_write tool — session-scope ledger with mode routing,
 * governance limits, and atomic write.
 *
 * Spec: docs/handoff/2026-08-17-wayfinder-440-decisions.md D1/D2/D4/D5/D7.
 *   - D1: single-tool + mode enum shape (list / add / check).
 *   - D2: file at `<session 目录>/todos.md`; factory `todoDir` seam.
 *   - D4: file limit 64 KB; per-item limit 500 codepoints; tmp + rename
 *     atomic write (negative-phrasing rejection is NOT applied — todo items
 *     like "别忘了跑测试" are legitimate tasks; only memory_save rejects
 *     negative phrasing).
 *   - D5: short receipt ("Updated todos.md"); no pending count; no envelope
 *     meta.
 *   - D7: write / non-concurrency-safe / block / default timeout tier; the
 *     code-level permission rule in policy.ts:codeBuiltInRules allows
 *     `mode === "list"` to bypass ask (read-only sub-mode).
 *
 * #903: `mode = "replace"` 扩展 — 整张列表换成新现行,旧 `todos.md` 改名为
 * 同目录快照 `todos.<unixMs>.<hex>.md` 保留历史(ADR-0046);空 / 缺席现行
 * 不建快照。replace 仍是 write(默认 ask),与 add / check 同形态。
 *
 * Ownership boundary (D6): the worker assembly path does not inject todoDir
 * → todo_write is excluded from the worker tool surface at registry
 * construction time. Concurrency among add/check calls inside the same main
 * loop is not blocked at the file level — but each call is
 * non-concurrency-safe (`isConcurrencySafe: false`), so the loop engine
 * serializes the per-turn tool calls.
 *
 * Injection seam: `todoDir` is host-injected per conversationId. T2/T3 does
 * NOT append to ACI_TOOLSET_NAMES; T4 wires the SSOT append.
 */
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import { sanitizeConversationSegment } from "../../session-roots.js";

/** Allowed top-level keys — mirrors inputSchema. */
const ALLOWED_KEYS = new Set(["mode", "item", "items"]);

/** Mode enumeration — single source of truth (compile-time + runtime check). */
export const TODO_WRITE_MODES = ["list", "add", "check", "replace"] as const;
export type TodoWriteMode = (typeof TODO_WRITE_MODES)[number];

/**
 * Prefix constants — keep in sync with `formatOpenLine` / `formatClosedLine`.
 *
 * #645 T1: `OPEN_PREFIX` exported (additive) so the agent-status bar
 * (`src/harness/agent-status.ts`) projects open lines with the writer's
 * exact prefix — single source of truth for the ledger line format.
 * add/check/list semantics unchanged.
 */
export const OPEN_PREFIX = "- [ ] ";
const CLOSED_PREFIX = "- [x] ";

/**
 * #645 T1: ledger filename relative to `todoDir` (D2: `<todoDir>/todos.md`).
 * Exported (additive) so the agent-status bar reads the same file the writer
 * owns — no second copy of the filename knowledge.
 */
export const TODOS_FILE = "todos.md";

/**
 * #646 T2 / ADR-0028: skip clause — when the next step alone finishes the
 * user's request (no multi-round progress to watch), do the work directly
 * without a list; the positive trigger stays "multi-step across multiple
 * turns → build a list".
 *
 * Lives ONLY in the tool description (never in the status bar, never in the
 * system prompt). Positively phrased English — passes the D9 NEGATIVE_PHRASES
 * guards verbatim (no "simple task", no negative imperatives). Exported as
 * SSOT so the description assembly and the bar-purity test
 * (agent-status-read-rule.test.ts T2 ③) reference the same symbol instead
 * of copying the text.
 */
export const TODO_WRITE_SKIP_CLAUSE =
  "When the next step alone finishes the user's request, work directly without a list; build a list when the work extends across multiple turns and progress needs tracking across rounds.";

/**
 * Governance limits (D4): file size capped at 64 KB (much smaller than the
 * memory_save 1 MB ceiling); per-item text capped at 500 codepoints
 * (matches the recent-user-tasks excerpt discipline; `[...item].length`
 * counts Unicode code points, not UTF-16 code units, so emoji and CJK are
 * measured correctly).
 */
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_ITEM_CODEPOINTS = 500;

export interface TodoWriteToolDeps {
  readonly todoDir: string;
  /** Test seam: deterministic tmp suffix (defaults to random hex). */
  readonly randomBytes?: (n: number) => Buffer;
}

/**
 * Factory: createTodoWriteTool(deps) — session-scope todo ledger
 * (D1 single-tool + mode enum shape).
 *
 * mode = "list": returns full `todos.md` content (or `""` if file missing).
 * mode = "add": appends `- [ ] <item>\n` line atomically; returns short receipt.
 * mode = "check": flips first exact-match `- [ ] <item>` to `- [x] <item>`
 *                 atomically; no match → typed error.
 *
 * Write failure (mkdir / writeFile / rename): typed ToolExecutionError; tmp
 * file is unlinked in `finally` so a crashed mid-write never leaves a
 * half-written `.tmp` next to the real file. The pre-existing `todos.md`
 * (if any) is untouched when an atomic write fails — `rename` is the only
 * step that can promote tmp to the final path.
 */
export function createTodoWriteTool(deps: TodoWriteToolDeps): AciToolDef {
  const random = deps.randomBytes ?? ((n: number) => randomBytes(n));

  return Object.freeze({
    name: "todo_write",
    description:
      "Maintain a session-scoped todo ledger at <session>/todos.md for tracking progress on multi-step, multi-turn complex tasks. Use mode=list to read all current items, mode=add to append an open `- [ ] <item>` line, mode=check to flip the first exact-match `- [ ] <item>` line to `- [x] <item>`, mode=replace to swap the current list for a new one (old ledger is renamed to a same-directory snapshot). Designed for tasks across multiple turns where progress needs to persist between rounds. " +
      TODO_WRITE_SKIP_CLAUSE,
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: [...TODO_WRITE_MODES] },
        item: { type: "string" },
        // #903: replace 模式携带 items (array of string)。add / check 仍只
        // 认 item;per-mode 字段互斥在 parseInput / handler 阶段报错。
        items: { type: "array", items: { type: "string" } },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    aci: {
      category: "write",
      isConcurrencySafe: false,
      interruptBehavior: "block",
      timeoutTier: "default",
    } as const,
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      // T11 收敛:filePath 不再工厂期预拼死路径 —— todoDir 本身按 D3 仍冻结,
      // 但 `join` 从装配期挪到调用期,语义逐字节一致(`join` 是纯函数)。
      // Per-conversation isolation: ledger resolves at CALL time from
      // ctx.conversationId (plumbed by the executor since #017) — one
      // conversation, one ledger. Absent ctx → legacy shared-root layout.
      const filePath = resolveConversationTodoDir({
        todoDir: deps.todoDir,
        conversationId: ctx?.conversationId,
      });
      const params = parseInput(input);
      switch (params.mode) {
        case "list":
          return await readTodos(filePath);
        case "add": {
          const current = await readTodos(filePath);
          const next = appendLine(current, formatOpenLine(params.item));
          assertWithinFileLimit(next);
          await writeTodosAtomic(filePath, next, random);
          return "Updated todos.md";
        }
        case "check": {
          const current = await readTodos(filePath);
          const flipped = flipFirstOpenLine(current, params.item);
          if (flipped === null) {
            throw new ToolExecutionError(
              `[todo_write] no open item matches: ${params.item}`
            );
          }
          assertWithinFileLimit(flipped);
          await writeTodosAtomic(filePath, flipped, random);
          return "Updated todos.md";
        }
        case "replace": {
          // #903 SC2/SC3:把现行 todos.md 换成新列表,旧文件留同目录快照
          // (`todos.<unixMs>.<hex>.md`)。空 / 缺席现行不建快照。失败纪律:
          // limit 校验在前(rename 之前),rename 失败 typed-error 不毁
          // 现行,rename 成功但后续原子写失败 → 快照已写好,现行要么旧内
          // 容要么完整新内容(原子写半截由 writeTodosAtomic 保证不
          // 存在)。
          const newContent = formatReplaceContent(params.items);
          assertWithinFileLimit(newContent);
          const current = await readTodos(filePath);
          if (current.length > 0) {
            await snapshotCurrentTodos(filePath, random);
          }
          await writeTodosAtomic(filePath, newContent, random);
          return "Updated todos.md";
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// input parsing
// ---------------------------------------------------------------------------

interface ParsedInput {
  readonly mode: TodoWriteMode;
  readonly item: string;
  readonly items: ReadonlyArray<string>;
}

function parseInput(input: unknown): ParsedInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolExecutionError("[todo_write] input must be an object");
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ToolExecutionError(`[todo_write] unknown field: ${key}`);
    }
  }
  const mode = requireMode(raw.mode);
  assertModeFieldsExclusive(raw, mode);
  if (mode === "replace") {
    const items = requireItemsForReplace(raw.items);
    for (const it of items) validateItemText("item", it);
    return { mode, item: "", items };
  }
  // 非 replace 模式:list 允许 item 缺省(默认空串);add/check 走 validateItemText
  // 触发"非空"提示(错误文案统一)。
  const item = typeof raw.item === "string" ? raw.item : "";
  if (mode === "add" || mode === "check") validateItemText("item", item);
  return { mode, item, items: [] };
}

/**
 * Per-mode 字段互斥:replace 只认 items,add/check 只认 item,list 都不强求。
 */
function assertModeFieldsExclusive(
  raw: Record<string, unknown>,
  mode: TodoWriteMode
): void {
  if (mode === "replace") {
    if (raw.item !== undefined) {
      throw new ToolExecutionError(
        "[todo_write] mode replace does not accept item (use items)"
      );
    }
    return;
  }
  if ((mode === "add" || mode === "check") && raw.items !== undefined) {
    throw new ToolExecutionError(
      `[todo_write] mode ${mode} does not accept items (use item)`
    );
  }
}

/**
 * 单一非空 + 500 codepoint 校验(dup-validate:replace items 与 add/check item
 * 共用)。D4:emoji / CJK 按 Unicode code point 计数(`[...s].length`)。
 */
function validateItemText(label: "item", value: string): void {
  if (value.length === 0 || codepointLength(value) > MAX_ITEM_CODEPOINTS) {
    throw new ToolExecutionError(
      `[todo_write] ${label} must be a non-empty string ≤ ${MAX_ITEM_CODEPOINTS} codepoints`
    );
  }
}

function requireMode(value: unknown): TodoWriteMode {
  if (
    typeof value !== "string" ||
    !(TODO_WRITE_MODES as ReadonlyArray<string>).includes(value)
  ) {
    throw new ToolExecutionError(
      `[todo_write] mode must be one of ${TODO_WRITE_MODES.join(" | ")}`
    );
  }
  return value as TodoWriteMode;
}

function requireItemsForReplace(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throw new ToolExecutionError(
      "[todo_write] items must be an array of strings for mode replace"
    );
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new ToolExecutionError(
        "[todo_write] items entries must be strings for mode replace"
      );
    }
  }
  return value as ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// file IO (T3: atomic + limits)
// ---------------------------------------------------------------------------

async function readTodos(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new ToolExecutionError(
      `[todo_write] read failed: ${(error as Error).message}`
    );
  }
}

/**
 * Atomic write: tmp file then rename. On any failure the tmp is unlinked so
 * a crashed mid-write never pollutes the directory. The pre-existing
 * `todos.md` (if any) is untouched when an atomic write fails — `rename` is
 * the only step that can promote tmp to the final path.
 */
async function writeTodosAtomic(
  filePath: string,
  content: string,
  random: (n: number) => Buffer
): Promise<void> {
  try {
    await mkdir(join(filePath, ".."), { recursive: true });
  } catch (error) {
    throw new ToolExecutionError(
      `[todo_write] mkdir failed: ${(error as Error).message}`
    );
  }
  const slug = random(6).toString("hex"); // 12 hex chars
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${slug}.tmp`;
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    // Best-effort tmp cleanup; the directory remains consistent (no half-written
    // file can be observed at the final path).
    try {
      await unlink(tmpPath);
    } catch {
      // tmp may already be gone (rename succeeded then a later step failed);
      // ignore — the contract is just "no polluted tmp leftover".
    }
    throw new ToolExecutionError(
      `[todo_write] atomic write failed: ${(error as Error).message}`
    );
  }
}

/**
 * #903 SC3:快照旧现行 `todos.md` → 同目录 `todos.<unixMs>.<hex>.md`。
 * 纯 rename(原子)—— 文件内容不变,只是改路径;rename 失败抛 typed-error
 * 且不修改现行(因为 rename 在跨设备 / 权限缺失时不会半改)。
 */
async function snapshotCurrentTodos(
  filePath: string,
  random: (n: number) => Buffer
): Promise<void> {
  const unixMs = Date.now();
  const hex = random(6).toString("hex"); // 12 hex chars
  const snapshotPath = join(dirname(filePath), `todos.${unixMs}.${hex}.md`);
  try {
    await rename(filePath, snapshotPath);
  } catch (error) {
    throw new ToolExecutionError(
      `[todo_write] snapshot rename failed: ${(error as Error).message}`
    );
  }
}

// ---------------------------------------------------------------------------
// limits + line formatting (pure)
// ---------------------------------------------------------------------------

function assertWithinFileLimit(content: string): void {
  // Byte length measured via Buffer.byteLength(..., "utf8") — mirrors the
  // size on disk rather than counting code units or code points.
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_BYTES) {
    throw new ToolExecutionError(
      `[todo_write] file would exceed ${MAX_FILE_BYTES} bytes (got ${bytes})`
    );
  }
}

export function codepointLength(s: string): number {
  return [...s].length;
}

/** Append `line` to `existing`. Tolerant of missing trailing newline. */
export function appendLine(existing: string, line: string): string {
  if (existing.length === 0) return line;
  return existing.endsWith("\n") ? existing + line : existing + "\n" + line;
}

/** Build an open `- [ ] <item>` line ending with newline. */
export function formatOpenLine(item: string): string {
  return `${OPEN_PREFIX}${item}\n`;
}

/**
 * #903: build the replacement `todos.md` body from a list of items. Empty
 * `items` → empty string (合法的"清空"操作,spec 决议)。非空:每条走
 * `formatOpenLine`,直接拼接(已经含尾换行)。
 */
export function formatReplaceContent(items: ReadonlyArray<string>): string {
  if (items.length === 0) return "";
  let out = "";
  for (const it of items) out += formatOpenLine(it);
  return out;
}

/**
 * Find the first open line whose `- [ ] ` tail equals `item` (exact match on
 * the item suffix). Returns the updated full content if matched; returns null
 * if no match (caller surfaces typed error).
 */
export function flipFirstOpenLine(
  content: string,
  item: string
): string | null {
  const lines = content.split("\n");
  const targetSuffix = `${OPEN_PREFIX}${item}`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === targetSuffix) {
      lines[i] = `${CLOSED_PREFIX}${item}`;
      return lines.join("\n");
    }
  }
  return null;
}

/**
 * #440 T1-fix: resolve the v1 process-stable per-surface todoDir.
 *
 * v1 limitation: returns a SHARED directory for all conversations within
 * a single surface (chat / serve / tui). D2 originally scoped per
 * conversationId — per-session resolution is a follow-up ticket because:
 *   - chat REPL: `conversationId = resumeId ?? randomUUID()` is created
 *     INSIDE `runChatSession` (chat-session.ts:963), AFTER buildHarnessEngine
 *     returns (cli.ts:239). Plumbing it requires either reordering cli.ts or
 *     computing the id twice. Deferred to #440-followup.
 *   - serve (hub): `cachedDeps` is shared across all conversations in the hub
 *     process (hub.ts ensureDeps caches the engine once). Per-conversationId
 *     todoDir requires engine rebuild per session — too expensive. Deferred.
 *   - TUI: `soleInflightId` is dynamic per message (deps.ts:153). Same
 *     architectural issue as serve. Deferred.
 *
 * Until per-conversationId isolation lands, all sessions within the same
 * surface share `<userHome>/.iknow/todos/<surface>/todos.md`. Stable across
 * turns within a session; per-surface (chat ≠ serve ≠ TUI on the same box);
 * per-user (multi-user → different userHome). Tests inject `userHome` to
 * redirect into a tmpdir (mirrors build-engine's userHome seam).
 *
 * Pure (no IO) — exported so chat/serve/tui callers can compute the same
 * path before calling `buildHarnessEngine({ todoDir })`.
 */
export function resolveSessionTodoDir(opts: {
  readonly userHome?: string;
  readonly surface: "chat" | "serve" | "tui";
}): string {
  const userHome = opts.userHome ?? homedir();
  return join(userHome, ".iknow", "todos", opts.surface);
}

/**
 * SSOT: where a conversation's `todos.md` lives, relative to the host-injected
 * per-surface `todoDir` root (D3 stays frozen).
 *
 *  - `conversationId` present and non-empty → `<todoDir>/<sanitized id>/todos.md`
 *    (per-conversation ledger; the original #440 D2 intent, un-deferred).
 *  - absent / empty → `<todoDir>/todos.md` (pre-isolation layout; hosts that
 *    never inject conversationId keep byte-identical behavior).
 *
 * Pure (no IO). Both the writer (todo_write handler, via
 * `ctx.conversationId`) and the projection (agent-status bar, via loop-engine
 * `deps.conversationId`) resolve through this one function — the two can
 * never disagree about the ledger location.
 */
export function resolveConversationTodoDir(opts: {
  readonly todoDir: string;
  readonly conversationId?: string;
}): string {
  if (opts.conversationId === undefined || opts.conversationId.length === 0) {
    return join(opts.todoDir, TODOS_FILE);
  }
  const segment = sanitizeConversationSegment(opts.conversationId);
  return join(opts.todoDir, segment, TODOS_FILE);
}
