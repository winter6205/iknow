#!/usr/bin/env node
/**
 * Legacy trace migration: split the pre-upgrade single file `./trace.jsonl`
 * into per-conversation `./trace/<convId>.jsonl` files by each line's
 * `conversation_id` (the per-session-file layout the new writer expects).
 *
 * Behavior contract:
 *   - Read the old single file (one JSON object per line).
 *   - Group lines by their `conversation_id` into `<outputDir>/<convId>.jsonl`.
 *   - Keep lines verbatim — write each raw line through, never re-serialize
 *     or alter content.
 *   - Skip malformed lines (JSON parse failure / non-object / missing
 *     conversation_id) and count them in the report.
 *   - Print a migration report (sessions, total lines, skipped lines).
 *
 * Runnable: `npx tsx scripts/trace-migrate.ts`. Defaults migrate
 * `./trace.jsonl` to `./trace/`; `--input` / `--output` override (see CLI main).
 *
 * Independently testable: the pure `migrateTraceFile(inputPath, outputDir)`
 * has no side dependencies; CLI main only parses argv and prints the report.
 * Malformed-line criteria align with parseOneLine in reader.ts (invalid JSON /
 * scalar / array / null all skipped).
 */
import { readFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Migration result report. */
export interface TraceMigrateReport {
  /** Number of distinct conversation_ids migrated (malformed lines excluded). */
  readonly sessions: number;
  /** Total input lines (malformed lines included). */
  readonly totalLines: number;
  /** Skipped malformed lines (JSON parse failure / non-object / missing conversation_id). */
  readonly skippedLines: number;
  /** Migrated session ids, in order of first appearance. */
  readonly conversationIds: ReadonlyArray<string>;
  /** Whether the old single file was deleted after migration (clean migration only, see migrateTraceFile). */
  readonly removedInput: boolean;
}

/** conversation_id field name (snake_case key mandated by the trace writer, ADR-0003). */
const CONVERSATION_ID_KEY = "conversation_id";

/**
 * Parse one JSON line; failure or non-plain-object → undefined. Same criteria
 * as parseOneLine in reader.ts: arrays count as malformed because a session
 * record is always an object.
 */
function parseOneLine(line: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Migrate a single trace.jsonl into files split by conversation_id.
 *
 * Lines are preserved: each appended output line is byte-identical to the
 * input line (a newline is added when the input lacks one), never
 * re-serialized. Malformed lines are skipped and counted. The output
 * directory is created when missing.
 *
 * Input removal: only a clean migration (skippedLines === 0) unlinks the old
 * single file, so the CLI's fail-fast check (a present ./trace.jsonl prompts
 * for migration) stops firing afterwards — otherwise the repo would stay
 * blocked even after migrating. When malformed lines exist the input is kept
 * for manual inspection/retry before deleting.
 *
 * A missing inputPath counts as empty input (0 lines, 0 sessions) without
 * throwing — matching the reader's silent ENOENT handling, so running the
 * migration in a repo with no legacy file stays safe.
 */
export function migrateTraceFile(
  inputPath: string,
  outputDir: string
): TraceMigrateReport {
  let content: string;
  try {
    content = readFileSync(inputPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      return {
        sessions: 0,
        totalLines: 0,
        skippedLines: 0,
        conversationIds: [],
        removedInput: false,
      };
    }
    throw err;
  }

  mkdirSync(outputDir, { recursive: true });

  const lines = content.split("\n");
  let totalLines = 0;
  let skippedLines = 0;
  const conversationIds: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    // Blank lines (including the trailing "" produced by a final newline) do not count toward totalLines.
    if (line.length === 0) continue;
    totalLines += 1;

    const row = parseOneLine(line);
    const convId = row?.[CONVERSATION_ID_KEY];
    if (typeof convId !== "string" || convId.length === 0) {
      skippedLines += 1;
      continue;
    }

    if (!seen.has(convId)) {
      seen.add(convId);
      conversationIds.push(convId);
    }
    // Preserve the raw line: write back exactly the original text + newline, no re-serialization.
    appendFileSync(join(outputDir, `${convId}.jsonl`), line + "\n", "utf8");
  }

  // Remove the legacy file only after a clean migration so the CLI fail-fast stops blocking.
  // With malformed lines keep the input (data may be partially migrated; deleting is unrecoverable) and return removedInput: false.
  // An empty file also counts as clean (nothing to lose): removing it clears the stale fail-fast trigger too.
  let removedInput = false;
  if (skippedLines === 0) {
    try {
      rmSync(inputPath, { force: true });
      removedInput = true;
    } catch (err) {
      // A failed unlink never fails the migration: the file stays, fail-fast keeps prompting, a later run deletes it.
      // Silence is safe — keeping the input here matches the malformed-line contract of preserving the file.
      void err;
    }
  }

  return {
    sessions: conversationIds.length,
    totalLines,
    skippedLines,
    conversationIds,
    removedInput,
  };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

// -- CLI main -----------------------------------------------------------------

/** Default input: the legacy single file at the repo root. */
const DEFAULT_INPUT = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "trace.jsonl"
);
/** Default output: the per-session directory at the repo root. */
const DEFAULT_OUTPUT = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "trace"
);

/** Arg parsing as a pure function so tests can call it without triggering the CLI. */
function parseArgs(argv: ReadonlyArray<string>): {
  input: string;
  output: string;
} {
  let input = DEFAULT_INPUT;
  let output = DEFAULT_OUTPUT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input" || a === "--output") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`missing value for ${a}`);
      }
      if (a === "--input") input = resolve(value);
      else output = resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { input, output };
}

function printReport(report: TraceMigrateReport, outputDir: string): void {
  console.log("trace-migrate");
  console.log(`  输出目录: ${outputDir}`);
  console.log(`  处理会话数: ${report.sessions}`);
  console.log(`  总行数: ${report.totalLines}`);
  console.log(`  跳过坏行: ${report.skippedLines}`);
  if (report.removedInput) {
    console.log("  已删除旧单文件（干净迁移完成）。");
  }
  if (report.sessions === 0) {
    console.log("  无旧 trace 可迁移（输入为空或不存在）。");
  }
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));
  const report = migrateTraceFile(input, output);
  printReport(report, output);
  process.exit(report.skippedLines > 0 ? 1 : 0);
}

/**
 * Run CLI main only on direct execution (`npx tsx scripts/trace-migrate.ts`);
 * importing this module from tests must not trigger it.
 */
const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]));

if (isDirectRun) {
  main();
}
