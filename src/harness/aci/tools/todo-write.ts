/**
 * #440 T2: todo_write tool — session-scope ledger with mode routing.
 *
 * Spec: docs/handoff/2026-08-17-wayfinder-440-decisions.md D1/D5 (tool shape
 * + short receipt, no envelope meta) + D2 (file: `<session 目录>/todos.md`,
 * factory `todoDir` seam). T2 implements mode routing (list / add / check)
 * + checkbox format; T3 layers file/item governance + atomic write on top.
 *
 * Contract (D1/D5):
 *   - input `{ mode: "list" | "add" | "check", item?: string }`,
 *     additionalProperties: false
 *   - checkbox format: add appends `- [ ] <item>\n`; check flips first exact
 *     match `- [ ] <item>` to `- [x] <item>`. Leading `[x]` line is not a
 *     match (already checked).
 *   - list returns the full file content as a plain string; missing file is
 *     a legal state (returns `""`, never throws on absence).
 *   - output: list → full content (string); add / check → short receipt
 *     `"Updated todos.md"` (no pending count, no envelope meta — D5).
 *   - typed errors (`ToolExecutionError` — D7 default ask守门 uses
 *     error.name for catch):
 *     - unknown `mode` → "[todo_write] mode must be 'list' | 'add' | 'check'"
 *     - `add` / `check` without non-empty string `item` → "[todo_write] item
 *       must be a non-empty string for mode <mode>"
 *     - `check` with no matching `- [ ] <item>` line → "[todo_write] no open
 *       item matches: <item>"
 *
 * aci metadata (D7): write / non-concurrency-safe / block / default timeout.
 *
 * Injection seam: `todoDir` is host-injected per conversationId. T2 does NOT
 * append to ACI_TOOLSET_NAMES; the factory is independent (T4 wires the
 * registry). T2 tests exercise the factory directly (no registry integration).
 */
import { readFile } from "node:fs/promises";
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

export interface TodoWriteToolDeps {
  readonly todoDir: string;
}

/**
 * Factory: createTodoWriteTool(deps) — session-scope todo ledger
 * (D1 single-tool + mode enum shape).
 *
 * mode = "list": returns full `todos.md` content (or `""` if file missing).
 * mode = "add": appends `- [ ] <item>\n` line; returns short receipt.
 * mode = "check": flips first exact-match `- [ ] <item>` to `- [x] <item>`;
 *                 no match → typed error.
 */
export function createTodoWriteTool(deps: TodoWriteToolDeps): AciToolDef {
  const filePath = join(deps.todoDir, "todos.md");

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
        case "add":
          // Atomic write + limits live in T3; this branch uses naive append for
          // TDD purposes. The harness integration path is exercised by T7.
          await appendTodoLine(filePath, formatOpenLine(params.item));
          return "Updated todos.md";
        case "check": {
          // Same as above — T3 swaps naive write for atomic write with limits.
          const current = await readTodos(filePath);
          const flipped = flipFirstOpenLine(current, params.item);
          if (flipped === null) {
            throw new ToolExecutionError(
              `[todo_write] no open item matches: ${params.item}`
            );
          }
          await writeTodos(filePath, flipped);
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
// file IO (T2 naive; T3 swaps to atomic + limits)
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

async function appendTodoLine(filePath: string, line: string): Promise<void> {
  // T2 naive append; T3 swaps to mkdir + tmp + rename + limits.
  const { appendFile } = await import("node:fs/promises");
  await appendFile(filePath, line, "utf8");
}

async function writeTodos(filePath: string, content: string): Promise<void> {
  // T2 naive write; T3 swaps to tmp + rename + limits.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, content, "utf8");
}

// ---------------------------------------------------------------------------
// checkbox format (pure)
// ---------------------------------------------------------------------------

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
