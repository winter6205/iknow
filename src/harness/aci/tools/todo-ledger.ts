/**
 * ADR-0085 / specs/agent-control-surface.md Slice C: todo ledger shape.
 *
 * Pure (no IO, no limits): `todo-write.ts` owns the tool (schema / handler /
 * governance limits / atomic IO); this module owns the line grammar so the
 * status-bar projection and the worker path consume ONE parser instead of
 * forking the format.
 *
 * Line grammar — one item per line:
 *   - [ ] [t5] subject   pending
 *   - [~] [t5] subject   in_progress
 *   - [x] [t5] subject   completed
 *
 * Legacy lines without an id (`- [ ] subject`) stay readable: `parseLedger`
 * synthesizes deterministic ids in file order — a synthesized id is the next
 * ascending serial that no earlier line claimed, so ids never collide with an
 * explicit `[t<N>]` marker already in the file. The next mutating write
 * persists the synthesized ids.
 *
 * Lines outside the grammar (blank lines, prose, malformed checkbox lines) are
 * not items: `read` does not show them, and the next mutating write rewrites
 * the file from parsed items, so they do not survive a write. `todo_write` is
 * the only writer of this file.
 *
 * Ids: `t<N>`, unique within the table, assigned at add time as
 * max(existing numeric suffix)+1. The table carries no separate high-water
 * mark, so deleting the highest-numbered item frees that number for the next
 * add; deleting any other item never shifts or re-issues the ids that remain.
 * Ids are stable references within a table, not globally unique across time.
 */

/** Item statuses — SSOT for the tool schema enum and the file format. */
export const TODO_ITEM_STATUSES = [
  "pending",
  "in_progress",
  "completed",
] as const;
export type TodoItemStatus = (typeof TODO_ITEM_STATUSES)[number];

/** One ledger item: stable id + status + subject text (verbatim). */
export interface TodoItem {
  readonly id: string;
  readonly status: TodoItemStatus;
  readonly subject: string;
}

/**
 * Update patch for one item (ADR-0085: update is subject / status / delete).
 * `delete: true` removes the line; it is NOT a fourth status.
 */
export interface TodoUpdatePatch {
  readonly id: string;
  readonly subject?: string;
  readonly status?: TodoItemStatus;
  readonly delete?: boolean;
}

/**
 * Pending line prefix. Exported as the status-bar projection anchor (#645 T1 /
 * ADR-0028): pending lines are `- [ ] [tN] subject`, which still starts with
 * this prefix — the bar's anchor survives the id change.
 */
export const OPEN_PREFIX = "- [ ] ";
const IN_PROGRESS_PREFIX = "- [~] ";
const COMPLETED_PREFIX = "- [x] ";

const PREFIX_BY_STATUS: Readonly<Record<TodoItemStatus, string>> = {
  pending: OPEN_PREFIX,
  in_progress: IN_PROGRESS_PREFIX,
  completed: COMPLETED_PREFIX,
};

const STATUS_BY_MARK: Readonly<Record<string, TodoItemStatus>> = {
  " ": "pending",
  "~": "in_progress",
  x: "completed",
};

/** Item line: checkbox marker + everything after `] `. */
const ITEM_LINE = /^- \[([ ~x])\] (.*)$/;
/** Leading `[t<N>] ` marker — present = the line already carries an id. */
const ID_MARKER = /^\[(t\d+)\] (.*)$/;

interface ParsedLine {
  readonly status: TodoItemStatus;
  /** Present only when the line already carries `[t<N>] `. */
  readonly explicitId?: string;
  readonly subject: string;
}

function parseLine(line: string): ParsedLine | null {
  const match = ITEM_LINE.exec(line);
  if (match === null) return null;
  const status = STATUS_BY_MARK[match[1]!];
  if (status === undefined) return null;
  const rest = match[2]!;
  const idMatch = ID_MARKER.exec(rest);
  if (idMatch === null) return { status, subject: rest };
  return { status, explicitId: idMatch[1]!, subject: idMatch[2]! };
}

/**
 * Parse ledger text into items, in file order. Non-item lines are skipped;
 * legacy lines get synthesized ids (see module header).
 */
export function parseLedger(content: string): ReadonlyArray<TodoItem> {
  const items: TodoItem[] = [];
  const used = new Set<string>();
  let nextSerial = 1;
  for (const line of content.split("\n")) {
    const parsed = parseLine(line);
    if (parsed === null) continue;
    const explicit = parsed.explicitId;
    if (explicit !== undefined && !used.has(explicit)) {
      used.add(explicit);
      nextSerial = Math.max(nextSerial, Number(explicit.slice(1)) + 1);
      items.push({
        id: explicit,
        status: parsed.status,
        subject: parsed.subject,
      });
      continue;
    }
    // Legacy line (no marker), or a duplicate marker from a hand-edited file:
    // claim the next ascending serial so ids stay unique and ordered.
    const id = `t${nextSerial++}`;
    used.add(id);
    items.push({ id, status: parsed.status, subject: parsed.subject });
  }
  return items;
}

/** One ledger line, ending with `\n`. */
export function formatLedgerLine(item: TodoItem): string {
  return `${PREFIX_BY_STATUS[item.status]}[${item.id}] ${item.subject}\n`;
}

/** Serialize items → file text (empty table → empty string, 0 bytes). */
export function serializeLedger(items: ReadonlyArray<TodoItem>): string {
  let out = "";
  for (const item of items) out += formatLedgerLine(item);
  return out;
}

/**
 * Max existing numeric id suffix + 1 (min `t1`). Private: the only id
 * allocator is `appendSubjects`, which needs a **serial counter** (one max
 * scan, then increment per new item) — a single-id wrapper recomputed per
 * item would be O(n·m) and is not a separate contract. `replace`
 * (`pendingItemsFromSubjects`) deliberately restarts at `t1`.
 */
function nextTodoSerial(items: ReadonlyArray<TodoItem>): number {
  let max = 0;
  for (const item of items) {
    const match = /^t(\d+)$/.exec(item.id);
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** New pending items for a whole-table write (replace) — fresh ids t1..tN. */
export function pendingItemsFromSubjects(
  subjects: ReadonlyArray<string>
): ReadonlyArray<TodoItem> {
  return subjects.map((subject, index) => ({
    id: `t${index + 1}`,
    status: "pending" as const,
    subject,
  }));
}

/** Append result: the whole new table + the newly added items (receipt ids). */
export interface AppendResult {
  readonly items: ReadonlyArray<TodoItem>;
  readonly added: ReadonlyArray<TodoItem>;
}

/** Append pending items whose ids continue after the table's max. */
export function appendSubjects(
  items: ReadonlyArray<TodoItem>,
  subjects: ReadonlyArray<string>
): AppendResult {
  let serial = nextTodoSerial(items);
  const added = subjects.map((subject) => ({
    id: `t${serial++}`,
    status: "pending" as const,
    subject,
  }));
  return { items: [...items, ...added], added };
}

/**
 * Apply one update patch. Returns the new table, or null when `patch.id` is not
 * in the table (caller surfaces the typed error — this module stays pure).
 */
export function applyUpdate(
  items: ReadonlyArray<TodoItem>,
  patch: TodoUpdatePatch
): ReadonlyArray<TodoItem> | null {
  const index = items.findIndex((item) => item.id === patch.id);
  if (index === -1) return null;
  if (patch.delete === true) return items.filter((_, i) => i !== index);
  const current = items[index]!;
  const next = [...items];
  next[index] = {
    id: current.id,
    status: patch.status ?? current.status,
    subject: patch.subject ?? current.subject,
  };
  return next;
}
