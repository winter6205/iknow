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
import { join } from "node:path";

import type { AciToolDef } from "../types.js";
import { ToolExecutionError } from "../../errors.js";

/** Allowed top-level keys — mirrors inputSchema. */
const ALLOWED_KEYS = new Set(["mode", "item"]);

/** Mode enumeration — single source of truth (compile-time + runtime check). */
export const TODO_WRITE_MODES = ["list", "add", "check"] as const;
export type TodoWriteMode = (typeof TODO_WRITE_MODES)[number];

/** Prefix constants — keep in sync with `formatOpenLine` / `formatClosedLine`. */
const OPEN_PREFIX = "- [ ] ";
const CLOSED_PREFIX = "- [x] ";

/**
 * Governance limits (D4): file size capped at 64 KB (much smaller than the
 * memory_save 1 MB ceiling); per-item text capped at 500 codepoints (matches
 * the taskFocus discipline; `[...item].length` counts Unicode code points,
 * not UTF-16 code units, so emoji and CJK are measured correctly).
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
  const filePath = join(deps.todoDir, "todos.md");
  const random = deps.randomBytes ?? ((n: number) => randomBytes(n));

  return Object.freeze({
    name: "todo_write",
    description:
      "Maintain a session-scoped todo ledger at <session>/todos.md. Use mode=list to read all current items, mode=add to append an open `- [ ] <item>` line, mode=check to flip the first exact-match `- [ ] <item>` line to `- [x] <item>`. Built for multi-step, multi-turn complex tasks where the agent tracks progress between turns.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: [...TODO_WRITE_MODES] },
        item: { type: "string" },
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
    handler: async (input: unknown) => {
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
  const item =
    typeof raw.item === "string" ? raw.item : requireItemFor(mode, raw.item);
  if ((mode === "add" || mode === "check") && item.length === 0) {
    throw new ToolExecutionError(
      `[todo_write] item must be a non-empty string for mode ${mode}`
    );
  }
  // Per-item limit (D4): 500 codepoints. Measured on `[...item].length` so
  // emoji / CJK characters count by Unicode code points (not UTF-16 units).
  if (
    (mode === "add" || mode === "check") &&
    codepointLength(item) > MAX_ITEM_CODEPOINTS
  ) {
    throw new ToolExecutionError(
      `[todo_write] item exceeds ${MAX_ITEM_CODEPOINTS} codepoints (got ${codepointLength(item)})`
    );
  }
  return { mode, item };
}

function requireMode(value: unknown): TodoWriteMode {
  if (typeof value !== "string") {
    throw new ToolExecutionError(
      `[todo_write] mode must be one of ${TODO_WRITE_MODES.join(" | ")}`
    );
  }
  if (!(TODO_WRITE_MODES as ReadonlyArray<string>).includes(value)) {
    throw new ToolExecutionError(
      `[todo_write] mode must be one of ${TODO_WRITE_MODES.join(" | ")}`
    );
  }
  return value as TodoWriteMode;
}

function requireItemFor(mode: TodoWriteMode, value: unknown): string {
  if (mode === "add" || mode === "check") {
    throw new ToolExecutionError(
      `[todo_write] item must be a non-empty string for mode ${mode}`
    );
  }
  // list: item is optional; default empty.
  if (typeof value !== "string") return "";
  return value;
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
