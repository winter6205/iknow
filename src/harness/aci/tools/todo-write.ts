/**
 * #440 T2/T3 + #903 T2 + ADR-0085 / specs/agent-control-surface.md Slice C:
 * todo_write tool — session-scope ledger with mode routing, governance limits,
 * and atomic write.
 *
 * Shape (ADR-0085): every item carries a stable **id**, and the main path is
 * three operations —
 *   - read   : list the current table as id / subject / status
 *   - add    : one call appends one `item` or many `items` (never overwrites);
 *              the receipt names the new ids
 *   - update : by id — change subject and/or status, or delete (delete is an
 *              update operation, not a fourth status)
 * `check` is folded into `update` (status=completed). `replace` is demoted to
 * a whole-table escape hatch (ADR-0046 snapshot discipline unchanged).
 *
 * D1: single-tool + mode enum shape.
 * D2: file at `<会话文件夹根>/<conversationId>/todos.md` (T2)。
 *    工厂的 `todoDir` 字段语义升级:由「surface 目录」改为「会话项目目录」
 *    (`resolveProjectSessionDir(baseDir, projectIdentityRoot)`),per-conv
 *    文件路径在调用期由 `resolveConversationTodoPath` 派生。
 * D4: file limit 64 KB; per-item limit 500 codepoints; tmp + rename
 *    atomic write (negative-phrasing rejection is NOT applied — todo items
 *    like "别忘了跑测试" are legitimate tasks; only memory_save rejects
 *    negative phrasing).
 * D5: short receipt; no pending count; no envelope meta.
 * D7: write / non-concurrency-safe / block / default timeout tier; the
 *    code-level permission rule in policy.ts:codeBuiltInRules allows the
 *    read-only sub-mode (`mode === "read"`) to bypass ask.
 *
 * #903: `mode = "replace"` 扩展 — 整张列表换成新现行,旧 `todos.md` 改名为
 * 同目录快照 `todos.<unixMs>.<hex>.md` 保留历史(ADR-0046:快照与现行同会话
 * 目录,T2 升级);空 / 缺席现行不建快照。replace 仍是 write(默认 ask)。
 *
 * Ownership boundary (D6): the worker assembly path does not inject todoDir
 * → todo_write is excluded from the worker tool surface at registry
 * construction time. Concurrency among write calls inside the same main
 * loop is not blocked at the file level — but each call is
 * non-concurrency-safe (`isConcurrencySafe: false`), so the loop engine
 * serializes the per-turn tool calls.
 *
 * Injection seam: `todoDir` is host-injected per conversationId.
 */
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import { sanitizeConversationSegment } from "../../session-roots.js";
import {
  appendSubjects,
  applyUpdate,
  parseLedger,
  pendingItemsFromSubjects,
  serializeLedger,
  TODO_ITEM_STATUSES,
  type TodoItem,
  type TodoItemStatus,
  type TodoUpdatePatch,
} from "./todo-ledger.js";

/** Allowed top-level keys — mirrors inputSchema. */
const ALLOWED_KEYS = new Set([
  "mode",
  "item",
  "items",
  "id",
  "subject",
  "status",
  "delete",
]);

/** Mode enumeration — single source of truth (compile-time + runtime check). */
export const TODO_WRITE_MODES = ["read", "add", "update", "replace"] as const;
export type TodoWriteMode = (typeof TODO_WRITE_MODES)[number];

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
 * turns → build a list". The clause also names how an existing list stays
 * current (update each item's status by id), so the model-visible text covers
 * the ADR-0085 main path.
 *
 * Lives ONLY in the tool description (never in the status bar, never in the
 * system prompt). Positively phrased English — passes the D9 NEGATIVE_PHRASES
 * guards verbatim (no "simple task", no negative imperatives). Exported as
 * SSOT so the description assembly and the bar-purity test
 * (agent-status-read-rule.test.ts T2 ③) reference the same symbol instead
 * of copying the text.
 */
export const TODO_WRITE_SKIP_CLAUSE =
  "When the next step alone finishes the user's request, work directly without a list; build a list when the work extends across multiple turns and progress needs tracking across rounds, and keep it current by updating each item's status by id as work advances.";

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
  /**
   * 会话项目目录根(T2 / session-folder-consolidation):
   *   `resolveProjectSessionDir(baseDir, projectIdentityRoot)` 的输出,
   *   即 `<baseDir>/projects/<basename>-<sha1[:12]>`。
   * Per-conversation 文件路径在调用期由 `resolveConversationTodoPath`
   * 派生(`ctx.conversationId` 在场 → `<projectDir>/<sanitized id>/todos.md`,
   * 缺席 → `<projectDir>/todos.md` 旧布局)。
   *
   * T2 之前这里叫「surface 目录」(`~/.iknow/todos/<surface>/`),T2 起改成
   * 「会话项目目录」 —— 同一会话从 chat / serve / TUI 三入口注入同一根,
   * `<surface>` 分裂消除,关键判据(SC5/T2 关键判据)。
   */
  readonly todoDir: string;
  /**
   * ADR-0085 / SC9:调用方能力。worker 与父会话共用**同一本账**,但
   * **添加仅父会话** —— worker 的 `add` 是工具自身的 typed 拒绝(见 handler),
   * 工具本身仍在 worker 工具面上(模型读得到拒绝原因,不是「工具不在场」)。
   *
   * `conversationId` 是 ctx 的**回退源**:worker 进程的 executor 不合成
   * `ctx.conversationId`(worker deps 无 conversationId),父会话经
   * envelope 透传的会话 id 由装配层放进这里;显式 `ctx.conversationId`
   * 在场时以 ctx 为准。`canAdd: false` 时 `add` typed 拒绝,`read` /
   * `update` / `replace` 照常(共享账本 = worker 能读能更)。
   *
   * 缺省 → 旧行为逐字节不变(canAdd 视为 true、路径只看 ctx)。
   */
  readonly actor?: TodoWriteActor;
  /** Test seam: deterministic tmp suffix (defaults to random hex). */
  readonly randomBytes?: (n: number) => Buffer;
}

/** ADR-0085 / SC9:调用方能力(父 vs worker)与所属会话。 */
export interface TodoWriteActor {
  /** 所属会话 id;`ctx.conversationId` 缺席时的回退源。 */
  readonly conversationId?: string;
  /** `add` 是否可用(父会话 true;worker false —— 共享账本只读+更新)。 */
  readonly canAdd: boolean;
}

/**
 * Factory: createTodoWriteTool(deps) — session-scope todo ledger (ADR-0085).
 *
 * mode = "read"   : current items as `- [status] [id] subject` lines (`""` if
 *                   the file is missing — legal state, as before). Legacy
 *                   lines without an id get synthesized ids in file order, so
 *                   the model can address them with `update` immediately.
 * mode = "add"    : appends one `item` or several `items` as pending lines;
 *                   receipt names the new ids.
 * mode = "update" : by `id` — set `subject` and/or `status`, or `delete:true`.
 *                   Unknown id → typed error, file untouched.
 * mode = "replace": whole-table escape hatch (old ledger renamed to a
 *                   same-directory snapshot, ADR-0046).
 *
 * Write failure (mkdir / writeFile / rename): typed ToolExecutionError; tmp
 * file is unlinked in `finally` so a crashed mid-write never leaves a
 * half-written `.tmp` next to the real file. The pre-existing `todos.md`
 * (if any) is untouched when an atomic write fails — `rename` is the only
 * step that can promote tmp to the final path. Limits are checked on the
 * fully constructed next content, before any write, so an over-limit add /
 * update never half-writes.
 */
export function createTodoWriteTool(deps: TodoWriteToolDeps): AciToolDef {
  const random = deps.randomBytes ?? ((n: number) => randomBytes(n));
  // ADR-0085 / SC9:父会话缺省 canAdd=true(旧行为);worker 装配显式 false。
  const canAdd = deps.actor?.canAdd !== false;

  return Object.freeze({
    name: "todo_write",
    description:
      "Maintain a session-scoped todo ledger at <session>/todos.md for tracking progress on multi-step, multi-turn complex tasks. Use mode=read to list every current item as `- [status] [id] subject`, mode=add to append one `item` or several `items` (the receipt names the new ids), mode=update to change one item's `subject` and/or `status` (pending | in_progress | completed) by `id`, or to delete it with `delete:true`, and mode=replace to swap the whole table for a new list (old ledger is renamed to a same-directory snapshot). Update by id keeps the table stable across rounds. Designed for tasks across multiple turns where progress needs to persist between rounds. " +
      TODO_WRITE_SKIP_CLAUSE,
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: [...TODO_WRITE_MODES] },
        // add: 单条 item 或一次多条 items(ADR-0085 / G2:多步计划一次写完)。
        // 二者互斥,per-mode 字段互斥在 parseInput 阶段报错。
        item: { type: "string" },
        items: { type: "array", items: { type: "string" } },
        // update: 目标条目 id + 至少一个改动字段。
        id: { type: "string" },
        subject: { type: "string" },
        status: { type: "string", enum: [...TODO_ITEM_STATUSES] },
        delete: { type: "boolean" },
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
      const filePath = resolveConversationTodoPath({
        projectDir: deps.todoDir,
        conversationId: ctx?.conversationId ?? deps.actor?.conversationId,
      });
      const params = parseInput(input);
      switch (params.mode) {
        case "read":
          return await readLedger(filePath);
        case "add":
          // ADR-0085 / SC9:添加仅父会话。worker 与父共用同一本账但不得追加
          // —— 拒绝在工具自身、在任何写盘之前,且先于文件的读取(不半写)。
          if (!canAdd) throw addIsParentOnlyError();
          return await addItems(filePath, params.subjects, random);
        case "update":
          return await updateItem(filePath, params.patch, random);
        case "replace":
          return await replaceLedger(filePath, params.items, random);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// mode handlers (IO orchestration — parse / limits / atomic write)
// ---------------------------------------------------------------------------

/**
 * ADR-0085 / SC9:worker `add` 的 typed 拒绝。措辞要让模型读出「为什么」+
 * 「还能做什么」—— 唯一写出这条禁令的地方是工具自身(权限层无 actor 维度)。
 */
function addIsParentOnlyError(): ToolExecutionError {
  return new ToolExecutionError(
    "[todo_write] add is parent-only; the worker shares the parent ledger and may read/update it"
  );
}

/** mode=read: parsed items re-serialized so synthesized ids are visible. */
async function readLedger(filePath: string): Promise<string> {
  return serializeLedger(parseLedger(await readTodos(filePath)));
}

async function addItems(
  filePath: string,
  subjects: ReadonlyArray<string>,
  random: (n: number) => Buffer
): Promise<string> {
  const current = parseLedger(await readTodos(filePath));
  const { items: next, added } = appendSubjects(current, subjects);
  const content = serializeLedger(next);
  assertWithinFileLimit(content);
  await writeTodosAtomic(filePath, content, random);
  return formatAddReceipt(added);
}

async function updateItem(
  filePath: string,
  patch: TodoUpdatePatch,
  random: (n: number) => Buffer
): Promise<string> {
  const current = parseLedger(await readTodos(filePath));
  const next = applyUpdate(current, patch);
  if (next === null) {
    throw new ToolExecutionError(`[todo_write] unknown id: ${patch.id}`);
  }
  const content = serializeLedger(next);
  assertWithinFileLimit(content);
  await writeTodosAtomic(filePath, content, random);
  return formatUpdateReceipt(patch);
}

async function replaceLedger(
  filePath: string,
  subjects: ReadonlyArray<string>,
  random: (n: number) => Buffer
): Promise<string> {
  // #903 SC2/SC3:把现行 todos.md 换成新列表,旧文件留同目录快照
  // (`todos.<unixMs>.<hex>.md`)。空 / 缺席现行不建快照。失败纪律:
  // limit 校验在前(rename 之前),rename 失败 typed-error 不毁现行,
  // rename 成功但后续原子写失败 → 快照已写好,现行要么旧内容要么完整
  // 新内容(原子写半截由 writeTodosAtomic 保证不存在)。
  const newContent = serializeLedger(pendingItemsFromSubjects(subjects));
  assertWithinFileLimit(newContent);
  const current = await readTodos(filePath);
  if (current.length > 0) {
    await snapshotCurrentTodos(filePath, random);
  }
  await writeTodosAtomic(filePath, newContent, random);
  return "Updated todos.md";
}

/** Receipt naming the new ids (SC7). */
function formatAddReceipt(added: ReadonlyArray<TodoItem>): string {
  const noun = added.length === 1 ? "item" : "items";
  return `Added ${added.length} ${noun}: ${added.map((i) => i.id).join(", ")}`;
}

/** Receipt reporting what the update changed (SC8). */
function formatUpdateReceipt(patch: TodoUpdatePatch): string {
  if (patch.delete === true) return `Deleted ${patch.id}`;
  const changes: string[] = [];
  if (patch.status !== undefined) changes.push(`status=${patch.status}`);
  if (patch.subject !== undefined) changes.push(`subject=${patch.subject}`);
  return `Updated ${patch.id}: ${changes.join(", ")}`;
}

// ---------------------------------------------------------------------------
// input parsing
// ---------------------------------------------------------------------------

interface ReadParams {
  readonly mode: "read";
}
interface AddParams {
  readonly mode: "add";
  readonly subjects: ReadonlyArray<string>;
}
interface UpdateParams {
  readonly mode: "update";
  readonly patch: TodoUpdatePatch;
}
interface ReplaceParams {
  readonly mode: "replace";
  readonly items: ReadonlyArray<string>;
}
type ParsedInput = ReadParams | AddParams | UpdateParams | ReplaceParams;

/**
 * Per-mode 字段互斥:每个 mode 只认自己那一组字段(表驱动,新增 mode 只加
 * 一行)。`add` 的 item/items 二选一在 parseAddInput 内单独报错。
 */
const FORBIDDEN_KEYS: Readonly<Record<TodoWriteMode, ReadonlyArray<string>>> = {
  read: ["item", "items", "id", "subject", "status", "delete"],
  add: ["id", "subject", "status", "delete"],
  update: ["item", "items"],
  replace: ["item", "id", "subject", "status", "delete"],
};

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
  switch (mode) {
    case "read":
      return { mode };
    case "add":
      return parseAddInput(raw);
    case "update":
      return parseUpdateInput(raw);
    case "replace":
      return parseReplaceInput(raw);
  }
}

function assertModeFieldsExclusive(
  raw: Record<string, unknown>,
  mode: TodoWriteMode
): void {
  for (const key of FORBIDDEN_KEYS[mode]) {
    if (raw[key] !== undefined) {
      throw new ToolExecutionError(
        `[todo_write] mode ${mode} does not accept ${key}`
      );
    }
  }
}

/** add: `item` (single) XOR `items` (many); at least one non-empty subject. */
function parseAddInput(raw: Record<string, unknown>): AddParams {
  const hasItem = raw.item !== undefined;
  const hasItems = raw.items !== undefined;
  if (hasItem && hasItems) {
    throw new ToolExecutionError(
      "[todo_write] mode add accepts item or items, not both"
    );
  }
  if (!hasItems) {
    // 缺省 item → "" 走 validateItemText 触发「非空」提示(错误文案统一)。
    const subject = hasItem ? requireStringValue(raw.item, "item") : "";
    validateItemText(subject);
    return { mode: "add", subjects: [subject] };
  }
  const subjects = requireStringArray(raw.items, "items");
  if (subjects.length === 0) {
    throw new ToolExecutionError(
      "[todo_write] items must contain at least one subject"
    );
  }
  for (const subject of subjects) validateItemText(subject);
  return { mode: "add", subjects };
}

/** update: `id` plus at least one of `subject` / `status` / `delete:true`. */
function parseUpdateInput(raw: Record<string, unknown>): UpdateParams {
  const id = requireStringValue(raw.id, "id");
  const status = parseOptionalStatus(raw.status);
  const subject =
    raw.subject === undefined
      ? undefined
      : requireStringValue(raw.subject, "subject");
  if (subject !== undefined) validateItemText(subject);
  const del = parseDeleteFlag(raw.delete);
  if (del === true && (subject !== undefined || status !== undefined)) {
    throw new ToolExecutionError(
      "[todo_write] mode update takes delete:true on its own"
    );
  }
  if (del !== true && subject === undefined && status === undefined) {
    throw new ToolExecutionError(
      "[todo_write] mode update requires subject, status, or delete:true"
    );
  }
  return { mode: "update", patch: { id, subject, status, delete: del } };
}

/** replace: `items` array of strings (empty array = clear, a legal state). */
function parseReplaceInput(raw: Record<string, unknown>): ReplaceParams {
  const items = requireStringArray(raw.items, "items");
  for (const item of items) validateItemText(item);
  return { mode: "replace", items };
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

function requireStringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ToolExecutionError(`[todo_write] ${label} must be a string`);
  }
  return value;
}

function requireStringArray(
  value: unknown,
  label: string
): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throw new ToolExecutionError(
      `[todo_write] ${label} must be an array of strings`
    );
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new ToolExecutionError(
        `[todo_write] ${label} entries must be strings`
      );
    }
  }
  return value as ReadonlyArray<string>;
}

function parseOptionalStatus(value: unknown): TodoItemStatus | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !(TODO_ITEM_STATUSES as ReadonlyArray<string>).includes(value)
  ) {
    throw new ToolExecutionError(
      `[todo_write] status must be one of ${TODO_ITEM_STATUSES.join(" | ")}`
    );
  }
  return value as TodoItemStatus;
}

/** `delete` 只接受 boolean;false 视为「不删除」,仍需别的改动字段。 */
function parseDeleteFlag(value: unknown): true | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return true;
  throw new ToolExecutionError("[todo_write] delete must be a boolean");
}

/**
 * 单一非空 + 500 codepoint 校验(dup-validate:add 单条 / add 数组 / update
 * subject / replace items 共用)。D4:emoji / CJK 按 Unicode code point 计数
 * (`[...s].length`)。
 */
function validateItemText(value: string): void {
  if (value.length === 0 || codepointLength(value) > MAX_ITEM_CODEPOINTS) {
    throw new ToolExecutionError(
      `[todo_write] item must be a non-empty string ≤ ${MAX_ITEM_CODEPOINTS} codepoints`
    );
  }
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
// limits (pure)
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

/**
 * SSOT: where a conversation's `todos.md` lives, relative to the host-injected
 * session-folder project root (`TodoWriteToolDeps.todoDir`, derived upstream
 * by `resolveProjectSessionDir(baseDir, projectIdentityRoot)` — see
 * session-store.ts).
 *
 *  - `conversationId` present and non-empty → `<projectDir>/<sanitized id>/todos.md`
 *    (per-conversation ledger; the original #440 D2 intent, finally un-deferred
 *    in #950 T2 / session-folder-consolidation).
 *  - absent / empty → `<projectDir>/todos.md` (pre-isolation layout; hosts that
 *    never inject conversationId keep byte-identical behavior).
 *
 * Pure (no IO). Both the writer (todo_write handler, via
 * `ctx.conversationId`) and the projection (agent-status bar, via loop-engine
 * `deps.conversationId`) resolve through this one function — the two can
 * never disagree about the ledger location.
 */
export function resolveConversationTodoPath(opts: {
  readonly projectDir: string;
  readonly conversationId?: string;
}): string {
  if (opts.conversationId === undefined || opts.conversationId.length === 0) {
    return join(opts.projectDir, TODOS_FILE);
  }
  const segment = sanitizeConversationSegment(opts.conversationId);
  return join(opts.projectDir, segment, TODOS_FILE);
}
