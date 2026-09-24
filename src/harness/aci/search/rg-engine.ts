/**
 * Bundled-engine execution layer: argv construction and line parsing.
 *
 * Contract: the production handler **execs only the path pinned under the
 * install root** (provided by `engine-manifest.ts`); it never runs `which rg`
 * and never falls back to an `rg` on PATH. Whether some other rg or version
 * exists on PATH is irrelevant here.
 *
 * The "bundled engine cannot start" decision lives here: spawn throws
 * ENOENT / EACCES (or the install root has no asset for this platform) →
 * return `{ kind: "unavailable" }`, and the handler switches to the full-
 * semantics Node scan. This is the **only** downgrade exit — cannot-start does
 * not mean the call fails.
 *
 * This module does not sort, paginate, or project: it only turns rg stdout
 * into raw artifacts shaped exactly like the Node engine's, so both engines
 * share one pipeline.
 */

import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { relative } from "node:path";

import { ToolExecutionError } from "../../errors.js";
import { spawnWithStopSignal } from "../../sandbox/runner.js";
import { buildRgArgs } from "./argv.js";
import { isEngineUnstartable } from "./engine-manifest.js";
import { parseRgContextStdout } from "./context-groups.js";
import { admittedPaths } from "./file-lines.js";
import { isPathRepresentable } from "./path-representable.js";
import {
  MAX_MATCH_LINE_COLUMNS,
  parseRgNullCounts,
  parseRgNullLines,
  parseRgNullPaths,
} from "./rg-output.js";
import type { ContextGroup, FileCount, LineHit, QuerySpec } from "./types.js";

/** Test seam: production = node:child_process.spawn; injectable to simulate a missing binary / fixed stdout. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof nodeSpawn>[2]
) => ChildProcess;

/** Engine artifacts: the raw shape of each of the three output modes (not yet sorted / paginated). */
export type EngineResult =
  | { readonly kind: "unavailable" }
  | { readonly kind: "lines"; readonly lines: ReadonlyArray<LineHit> }
  | { readonly kind: "paths"; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "counts"; readonly counts: ReadonlyArray<FileCount> }
  | { readonly kind: "context"; readonly groups: ReadonlyArray<ContextGroup> };

export interface RgEngineInput {
  readonly spec: QuerySpec;
  /** Absolute path of the pinned binary; `undefined` = no asset for this platform → downgrade directly. */
  readonly binaryPath: string | undefined;
  readonly searchRoot: string;
  readonly workspaceRoot: string;
  readonly signal: AbortSignal | undefined;
  readonly spawn: SpawnFn | undefined;
}

/**
 * Run rg. Any "cannot start" returns `unavailable` (including no asset for the
 * platform); all other failures throw typed as usual.
 */
export async function runRgEngine(input: RgEngineInput): Promise<EngineResult> {
  if (input.binaryPath === undefined) return { kind: "unavailable" };

  // cwd = **workspace root** (not searchRoot): rg echoes the paths fed into
  // it, and `--glob` anchoring decides segments relative to cwd — both
  // require the search path to be expressed relative to workspace so that it
  // matches the Node engine (which also judges segments on workspace-relative
  // paths and emits relative paths).
  const searchPath = toSearchPath(input.workspaceRoot, input.searchRoot);
  // When the search target itself contains `\n` / `\0`, return an empty
  // result directly and do **not** exec rg: rg's `--glob` exclusion only
  // applies during traversal, while an explicitly named file / dir is still
  // searched (verified 15.1.0), and its records end with `\n` — a path with
  // `\n` splits one record into two, and the second half looks like a **fake
  // hit** (`nl\nname.txt` → `name.txt:1:<body>`), and that fake path, if it
  // really exists, could pass text admission and reach the model. When the
  // search target is unrepresentable, its **entire subtree** is also
  // unrepresentable (every descendant path carries this ancestor name), so an
  // empty result is synonymous with "skip all". Rules and rationale in
  // `path-representable.ts`; the Node engine side is covered by the same test
  // in `pipeline.ts`.
  if (!isPathRepresentable(searchPath)) return parseByMode("", input);
  const args = buildRgArgs(input.spec, searchPath, MAX_MATCH_LINE_COLUMNS);
  const collected = await collect(input, args);
  if (collected === "unavailable") return { kind: "unavailable" };
  return applyAdmission(interpret(collected, input), input);
}

/**
 * Binary / oversize **admission re-check** (both engines share one admission
 * line).
 *
 * Why re-check paths rg already reported: rg's own binary detection uses a
 * 64 KiB window and **reaches different conclusions for the same file
 * depending on output mode** (verified 15.1.0: a file with NUL at 70 KB is
 * listed by `-l`, skipped by `--count`, WARNING for `content`). That behavior
 * has no replicable consistent meaning, so this tool's rule is "binary
 *
 // (ADR-0004)
 * (whole file contains NUL) is not searched" — same source as `read_file`'s
 * `buffer.includes(0x00)`, with single authority in
 * `file-lines.ts`'s `readTextBuffer`. rg's built-in detection is thus only a
 * best-effort I/O saver: however accurate it is, the final accepted set is
 * decided here, so both engines admit or reject the same file together.
 *
 * The `allowOversize` test mirrors the Node scan shape (search root is an
 * explicitly named file) — without it, `path: "big.ts"` would be searchable
 * via Node but rejected here via rg, reintroducing exactly the divergence the
 * exemption fix removed.
 */
async function applyAdmission(
  result: EngineResult,
  input: RgEngineInput
): Promise<EngineResult> {
  // `unavailable` is not a product of this layer (the caller already dispatched
  // it), but it belongs to the same union type; after explicitly blocking it,
  // the remaining three shapes each need concrete member access.
  if (result.kind === "unavailable") return result;
  const paths = resultPaths(result);
  if (paths.length === 0) return result;
  const unique = new Set(paths);
  const admitted = await admittedPaths(input.workspaceRoot, paths, {
    allowOversize: await isExplicitFile(input),
  });
  // When all paths pass, return as-is (saving one per-entry rebuild): the
  // comparison base is the **deduplicated** count — in the hit-line shape the
  // same file appears many times, so comparing `paths.length` would never take
  // the fast path.
  if (admitted.size === unique.size) return result;
  return keepAdmitted(result, admitted);
}

/** Paths involved in the result (projection of each shape). */
function resultPaths(
  result: Exclude<EngineResult, { kind: "unavailable" }>
): string[] {
  if (result.kind === "lines") return result.lines.map((hit) => hit.path);
  if (result.kind === "paths") return [...result.paths];
  if (result.kind === "counts") return result.counts.map((count) => count.path);
  if (result.kind === "context") {
    return result.groups.flatMap((group) =>
      group.entries.map((entry) => entry.path)
    );
  }
  return [];
}

/** Filter the result by the admitted set (preserving each shape's original order). */
function keepAdmitted(
  result: Exclude<EngineResult, { kind: "unavailable" }>,
  admitted: ReadonlySet<string>
): EngineResult {
  if (result.kind === "lines") {
    return {
      kind: "lines",
      lines: result.lines.filter((hit) => admitted.has(hit.path)),
    };
  }
  if (result.kind === "paths") {
    return {
      kind: "paths",
      paths: result.paths.filter((path) => admitted.has(path)),
    };
  }
  if (result.kind === "counts") {
    return {
      kind: "counts",
      counts: result.counts.filter((count) => admitted.has(count.path)),
    };
  }
  return {
    kind: "context",
    groups: result.groups
      .map((group) => ({
        entries: group.entries.filter((entry) => admitted.has(entry.path)),
      }))
      .filter((group) => group.entries.length > 0),
  };
}

/** Whether the search root points at an existing file (same test as `node-scan` / `grep.ts`). */
async function isExplicitFile(input: RgEngineInput): Promise<boolean> {
  const info = await stat(input.searchRoot).catch(() => null);
  return info !== null && info.isFile();
}

type Collected =
  | "unavailable"
  | {
      readonly code: number | null;
      readonly stdout: string;
      readonly stderr: string;
    };

/** Spawn and collect stdout/stderr fully; ENOENT / EACCES → `unavailable`. */
async function collect(
  input: RgEngineInput,
  args: ReadonlyArray<string>
): Promise<Collected> {
  const binary = input.binaryPath!;
  try {
    if (input.spawn === undefined) {
      const { done } = spawnWithStopSignal(binary, args, {
        cwd: input.workspaceRoot,
        signal: input.signal,
      });
      const result = await done;
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    return await collectViaSeam(input.spawn, binary, args, input);
  } catch (error) {
    // The pinned engine cannot start (missing / not executable / restricted)
    // — the only downgrade exit.
    if (isEngineUnstartable(error)) return "unavailable";
    throw error;
  }
}

/**
 * Test-seam branch: deliberately different kill semantics from the
 * production path (enough only for ENOENT simulation and fixed-stdout parse
 * coverage). Cases needing full abort/kill coverage go through the production
 * path.
 */
function collectViaSeam(
  spawn: SpawnFn,
  binary: string,
  args: ReadonlyArray<string>,
  input: RgEngineInput
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(binary, args, {
    cwd: input.workspaceRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolveDone, rejectDone) => {
    child.once("error", rejectDone);
    child.once("close", (code) => resolveDone({ code, stdout, stderr }));
  });
}

/**
 * Search root → rg's path argument (relative to workspace root, posix
 * separators).
 *
 * An identity root outside workspace (the read-only surface after ADR-0037
 * rebinding) → this yields a `..`-shaped path, and rg searches it as
 * "workspace-relative with `..`". The Node scan matches: it does **not**
 * remove `..`-prefixed entries (see `node-scan.ts`), so both engines' read
 * surfaces agree. Escapes are blocked at the entry by `resolveSearchRoot`'s
 * containment check.
 */
function toSearchPath(workspaceRoot: string, searchRoot: string): string {
  const rel = relative(workspaceRoot, searchRoot).split("\\").join("/");
  return rel.length === 0 ? "." : rel;
}

/**
 * rc interpretation: 0/1 normal (1 = no match); 2 = usage / regex error,
 * **or** simply some file was unreadable (`--no-messages` has already squashed
 * the latter into an empty stderr); anything else = engine failure.
 *
 * When rc=2 and stderr is empty, stdout is still legitimate hits — throwing
 * here would let one unreadable neighbor file fail the whole query, while the
 * Node engine just skips that file, so the two engines would answer
 * differently for the same directory. Hence this kind of 2 is treated as
 * "partial success": parse whatever lines arrived.
 */
function interpret(
  collected: Exclude<Collected, "unavailable">,
  input: RgEngineInput
): EngineResult {
  const { code, stdout, stderr } = collected;
  if (code === 0 || code === 1) return parseByMode(stdout, input);
  if (code === 2 && stderr.trim().length === 0)
    return parseByMode(stdout, input);
  if (code === 2) {
    throw new ToolExecutionError(
      `grep: search engine rejected the query: ${firstLine(stderr)}`
    );
  }
  if (input.signal?.aborted) {
    throw new ToolExecutionError("grep: aborted before completion");
  }
  throw new ToolExecutionError(
    `grep: search engine exited with code ${String(code)}: ${firstLine(stderr)}`
  );
}

/** Parse stdout by output mode; content + context goes through group parsing. */
function parseByMode(stdout: string, input: RgEngineInput): EngineResult {
  const spec = input.spec;
  if (spec.output === "paths") {
    return { kind: "paths", paths: parseRgNullPaths(stdout) };
  }
  if (spec.output === "count") {
    return { kind: "counts", counts: parseRgNullCounts(stdout) };
  }
  if (spec.context > 0) {
    return { kind: "context", groups: parseRgContextStdout(stdout) };
  }
  // `parseRgNullLines` already applies the single code-point gate at
  // MAX_MATCH_LINE_COLUMNS internally; no second pass here — repeated
  // finalization only blurs "who is the authority".
  return { kind: "lines", lines: parseRgNullLines(stdout) };
}

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return (idx === -1 ? text : text.slice(0, idx)).trim();
}
