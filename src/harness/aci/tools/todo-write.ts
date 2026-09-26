/**
 * todo_write tool — session-scope ledger with mode routing, governance
 * limits, and atomic write. See ADR-0085 / specs/agent-control-surface.md
 * Slice C.
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
 * Single-tool + mode enum shape.
 * The file lives at `<session-project-root>/<conversationId>/todos.md`.
 *   The factory's `todoDir` field was upgraded from "surface directory" to
 *   "session project directory"
 *   (`resolveProjectSessionDir(baseDir, projectIdentityRoot)`); the
 *   per-conv file path is derived at call time by
 *   `resolveConversationTodoPath`.
 * Governance: file limit 64 KB; per-item limit 500 codepoints; tmp + rename
 *   atomic write (negative-phrasing rejection is NOT applied — todo items
 *   like "remember not to forget the tests" are legitimate tasks; only
 *   memory_save rejects negative phrasing).
 * Short receipt; no pending count; no envelope meta.
 * write / non-concurrency-safe / block / default timeout tier; the
 *   code-level permission rule in policy.ts:codeBuiltInRules allows the
 *   read-only sub-mode (`mode === "read"`) to bypass ask.
 *
 * `mode = "replace"` extension — swap the whole list for the new current
 * table, renaming the old `todos.md` to a same-directory snapshot
 * `todos.<unixMs>.<hex>.md` to keep history (ADR-0046: snapshot and current
 * live in the same session directory). Empty / absent current file → no
 * snapshot. replace remains write (default ask).
 *
 * Ownership boundary: the worker assembly path does not inject todoDir
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
import { ToolExecutionError, ToolInputValidationError } from "../../errors.js";
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
 * Ledger filename relative to `todoDir` (`<todoDir>/todos.md`).
 * Exported (additive) so the agent-status bar reads the same file the writer
 * owns — no second copy of the filename knowledge.
 */
export const TODOS_FILE = "todos.md";

/**
 * ADR-0028: skip clause — when the next step alone finishes the
 * user's request (no multi-round progress to watch), do the work directly
 * without a list; the positive trigger stays "multi-step across multiple
 * turns → build a list". The clause also names how an existing list stays
 * current (update each item's status by id), so the model-visible text covers
 * the ADR-0085 main path.
 *
 * Lives ONLY in the tool description (never in the status bar, never in the
 * system prompt). Positively phrased English — passes the negative-phrase
 * guards verbatim (no "simple task", no negative imperatives). Exported as
 * SSOT so the description assembly and the bar-purity test reference the
 * same symbol instead of copying the text.
 */
export const TODO_WRITE_SKIP_CLAUSE =
  "When the next step alone finishes the user's request, work directly without a list; build a list when the work extends across multiple turns and progress needs tracking across rounds, and keep it current by updating each item's status by id as work advances.";

/**
 * Governance limits: file size capped at 64 KB (much smaller than the
 * memory_save 1 MB ceiling); per-item text capped at 500 codepoints
 * (matches the recent-user-tasks excerpt discipline; `[...item].length`
 * counts Unicode code points, not UTF-16 code units, so emoji and CJK are
 * measured correctly).
 */
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_ITEM_CODEPOINTS = 500;

export interface TodoWriteToolDeps {
  /**
   * Session project directory root:
   *   the output of `resolveProjectSessionDir(baseDir, projectIdentityRoot)`,
   *   i.e. `<baseDir>/projects/<basename>-<sha1[:12]>`.
   * The per-conversation file path is derived at call time by
   * `resolveConversationTodoPath` (`ctx.conversationId` present →
   * `<projectDir>/<sanitized id>/todos.md`; absent → legacy
   * `<projectDir>/todos.md`).
   *
   * This used to be called the "surface directory"
   * (`~/.iknow/todos/<surface>/`); it is now the session project directory —
   * the same session injected from chat / serve / TUI shares one root, so the
   * `<surface>` split is eliminated.
   */
  readonly todoDir: string;
  /**
   * ADR-0085: caller capability. The worker and the parent session share
   * **the same ledger**, but **adding is parent-only** — a worker's `add` is
   * a typed rejection from the tool itself (see handler), and the tool stays
   * on the worker surface (the model reads the rejection reason, rather than
   * seeing "tool absent").
   *
   * `conversationId` is the ctx **fallback source**: the worker process's
   * executor does not synthesize `ctx.conversationId` (worker deps have no
   * conversationId), so the parent session's id is passed through the
   * envelope and placed here by the assembly layer; when
   * `ctx.conversationId` is present it wins. With `canAdd: false`, `add` is
   * a typed rejection, while `read` / `update` / `replace` proceed normally
   * (shared ledger = the worker can read and update).
   *
   * Omitted → old behavior, byte-identical (canAdd treated as true, path
   * driven only by ctx).
   */
  readonly actor?: TodoWriteActor;
  /** Test seam: deterministic tmp suffix (defaults to random hex). */
  readonly randomBytes?: (n: number) => Buffer;
}

/** ADR-0085: caller capability (parent vs worker) and owning session. */
export interface TodoWriteActor {
  /** Owning session id; fallback source when `ctx.conversationId` is absent. */
  readonly conversationId?: string;
  /** Whether `add` is available (parent true; worker false — read+update only on the shared ledger). */
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
  // ADR-0085: parent sessions default to canAdd=true (old behavior); worker assembly sets it explicitly false.
  const canAdd = deps.actor?.canAdd !== false;

  return Object.freeze({
    name: "todo_write",
    description:
      // ADR-0085: one sentence per mode — deletion belongs to the update
      // family (update + delete:true + id), not a fifth mode; replace takes
      // only items (ADR-0046), no singular item alias.
      // Positive guidance only: no "do not" / "never" / "simple task" wording.
      "Maintain a session-scoped todo ledger at <session>/todos.md for tracking progress on multi-step, multi-turn complex tasks. The ledger supports four modes. mode=read lists every current item as `- [status] [id] subject`. mode=add appends one `item` or several `items` at once; the receipt names the new ids. mode=update changes an item's subject and/or status by id, and removes that item by passing id with delete:true. mode=replace swaps the whole table for a new `items` array; the previous ledger is renamed to a same-directory snapshot. Update by id keeps the table stable across rounds. Designed for tasks across multiple turns where progress needs to persist between rounds. " +
      TODO_WRITE_SKIP_CLAUSE,
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: [...TODO_WRITE_MODES] },
        // add: one `item` or many `items` at once (ADR-0085: write a
        // multi-step plan in one call). The two are mutually exclusive; the
        // mode contract branches reject per-mode field exclusion before the
        // handler runs, and parseInput keeps the same checks for direct calls.
        item: {
          type: "string",
          description:
            "Subject text for one new todo item; pair with mode=add.",
        },
        items: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of subject texts; mode=add appends them, mode=replace swaps the whole table for them.",
        },
        // update: target entry id + at least one changed field.
        id: {
          type: "string",
          description:
            "Id of the item to change with mode=update (taken from the mode=read listing).",
        },
        subject: {
          type: "string",
          description: "Replacement subject text for mode=update.",
        },
        status: {
          type: "string",
          enum: [...TODO_ITEM_STATUSES],
          description:
            "New status for mode=update: pending | in_progress | completed.",
        },
        delete: {
          type: "boolean",
          description:
            "Pass true with mode=update and id to remove that item; deletion is an update operation.",
        },
      },
      required: ["mode"],
      additionalProperties: false,
      // Mode-specific contract enforced at the ajv layer before the handler
      // runs; FORBIDDEN_KEYS in parseInput stays as the direct-call fallback.
      allOf: modeContractBranches(),
    },
    aci: {
      category: "write",
      isConcurrencySafe: false,
      interruptBehavior: "block",
      timeoutTier: "default",
    } as const,
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      // filePath is no longer baked at factory time — todoDir itself stays
      // frozen, but `join` moved from assembly time to call time, semantics
      // byte-identical (`join` is a pure function).
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
          // ADR-0085: adding is parent-only. The worker shares the parent's
          // ledger but may not append — the rejection lives in the tool
          // itself, before any write and even before reading the file (no
          // half-write).
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
 * ADR-0085: typed rejection for a worker's `add`. The wording must let the
 * model read both "why" and "what it can still do" — the tool itself is the
 * only place this rule is stated (the permission layer has no actor axis).
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
  // Swap the current todos.md for the new list, keeping the old file as a
  // same-directory snapshot (`todos.<unixMs>.<hex>.md`). Empty / absent
  // current → no snapshot. Failure discipline: the limit check comes first
  // (before rename); a failed rename throws typed-error without destroying
  // the current file; a successful rename followed by a failed atomic write
  // → the snapshot is already written and the current file is either the old
  // content or the complete new content (a half-written atomic file cannot
  // exist, guaranteed by writeTodosAtomic).
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
//
// Every rejection here is a deterministic input-shape check →
// ToolInputValidationError (executor classifies it validation_failed); IO /
// state / capability failures below stay plain ToolExecutionError.
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
 * Per-mode field exclusion: each mode recognizes only its own field set
 * (table-driven, so a new mode adds just one row). The item/items
 * either-or for `add` is reported separately inside parseAddInput.
 */
const FORBIDDEN_KEYS: Readonly<Record<TodoWriteMode, ReadonlyArray<string>>> = {
  read: ["item", "items", "id", "subject", "status", "delete"],
  add: ["id", "subject", "status", "delete"],
  update: ["item", "items"],
  replace: ["item", "id", "subject", "status", "delete"],
};

/** Update fields that carry a change; `id` alone is a no-op the schema rejects. */
const UPDATE_CHANGE_FIELDS = ["subject", "status", "delete"] as const;

/**
 * Mode-specific contract branches, derived from the same FORBIDDEN_KEYS table
 * the parseInput fallback reads (single source of truth). Each branch is an
 * `if / then` pair guarded by the mode discriminator, so only the branches of
 * the mode the caller actually declared can fail: a cross-mode field is
 * reported once, on that field, instead of one `mode` mismatch per branch.
 * Within a mode the field-exclusion branch is listed first, so the surfaced
 * rejection names the offending field ahead of any missing-field complaint.
 */
function modeContractBranches(): ReadonlyArray<Record<string, unknown>> {
  const declaredAs = (
    mode: TodoWriteMode,
    alsoRequired: ReadonlyArray<string> = []
  ): Record<string, unknown> => ({
    properties: { mode: { const: mode } },
    required: ["mode", ...alsoRequired],
  });
  const excludes = (
    mode: TodoWriteMode,
    forbidden: ReadonlyArray<string>
  ): Record<string, unknown> => ({
    if: declaredAs(mode),
    then: {
      properties: Object.fromEntries(forbidden.map((key) => [key, false])),
    },
  });
  return [
    excludes("read", FORBIDDEN_KEYS.read),
    excludes("add", FORBIDDEN_KEYS.add),
    {
      // add takes `item` (single) or `items` (many): each arm accepts exactly
      // one of the two, so coexisting fields match none.
      if: declaredAs("add"),
      then: {
        anyOf: [
          { required: ["item"], properties: { items: false } },
          { required: ["items"], properties: { item: false } },
        ],
      },
    },
    excludes("update", FORBIDDEN_KEYS.update),
    { if: declaredAs("update"), then: { required: ["id"] } },
    {
      // An id alone is a no-op: a change field is required only once the id is
      // there, so a missing id stays the single reported problem.
      if: declaredAs("update", ["id"]),
      then: {
        anyOf: UPDATE_CHANGE_FIELDS.map((field) => ({ required: [field] })),
      },
    },
    excludes("replace", FORBIDDEN_KEYS.replace),
    { if: declaredAs("replace"), then: { required: ["items"] } },
  ];
}

function parseInput(input: unknown): ParsedInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolInputValidationError("[todo_write] input must be an object");
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ToolInputValidationError(`[todo_write] unknown field: ${key}`);
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
      throw new ToolInputValidationError(
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
    throw new ToolInputValidationError(
      "[todo_write] mode add accepts item or items, not both"
    );
  }
  if (!hasItems) {
    // Missing item → "" flows through validateItemText to trigger the
    // "non-empty" message (uniform error wording).
    const subject = hasItem ? requireStringValue(raw.item, "item") : "";
    validateItemText(subject);
    return { mode: "add", subjects: [subject] };
  }
  const subjects = requireStringArray(raw.items, "items");
  if (subjects.length === 0) {
    throw new ToolInputValidationError(
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
    throw new ToolInputValidationError(
      "[todo_write] mode update takes delete:true on its own"
    );
  }
  if (del !== true && subject === undefined && status === undefined) {
    throw new ToolInputValidationError(
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
    throw new ToolInputValidationError(
      `[todo_write] mode must be one of ${TODO_WRITE_MODES.join(" | ")}`
    );
  }
  return value as TodoWriteMode;
}

function requireStringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ToolInputValidationError(
      `[todo_write] ${label} must be a string`
    );
  }
  return value;
}

function requireStringArray(
  value: unknown,
  label: string
): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throw new ToolInputValidationError(
      `[todo_write] ${label} must be an array of strings`
    );
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new ToolInputValidationError(
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
    throw new ToolInputValidationError(
      `[todo_write] status must be one of ${TODO_ITEM_STATUSES.join(" | ")}`
    );
  }
  return value as TodoItemStatus;
}

/** `delete` accepts boolean only; false means "not deleting", so another change field is still required. */
function parseDeleteFlag(value: unknown): true | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return true;
  throw new ToolInputValidationError("[todo_write] delete must be a boolean");
}

/**
 * Single non-empty + 500-codepoint validation (shared by add single / add
 * array / update subject / replace items). Emoji / CJK are counted as
 * Unicode code points (`[...s].length`).
 */
function validateItemText(value: string): void {
  if (value.length === 0 || codepointLength(value) > MAX_ITEM_CODEPOINTS) {
    throw new ToolInputValidationError(
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
 * Snapshot the old current `todos.md` → same-directory
 * `todos.<unixMs>.<hex>.md`. Pure rename (atomic) — file content unchanged,
 * only the path moves; a failed rename throws typed-error and leaves the
 * current file untouched (rename never half-applies across devices / on
 * permission errors).
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
