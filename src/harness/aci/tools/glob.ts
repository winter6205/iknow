/**
 * `glob` — ACI tool: find files by glob pattern under a workspace root.
 *
 * Contract surface (T7 of #141, ADR-0004):
 *   - input  : { pattern: string, path?: string, limit?: integer }
 *   - output : alphabetised, root-relative paths, one per line.
 *   - empty pattern is a hard error (NOT a "match all" fallback).
 *   - try `rg --files --glob <pattern>` first; on ENOENT fall back to a
 *     Node walker with a small, intentionally-bounded glob matcher.
 *   - limit defaults to 200, capped at 5000.
 *   - read-only / cancel / concurrency-safe.
 *
 * Supported tokens in the fallback glob matcher (rhymes with what `rg` accepts
 * for `--glob`): `*` (any run of non-`/` chars), `**` (any number of segments,
 * possibly zero), `?` (single non-`/` char). Anything more exotic
 * (character classes, extglobs, brace expansion) is out of scope; rg handles
 * those when available, and the ADR-0004 contract is "true glob, not
 * substring" which `*` / `**` / `?` covers.
 */

import { readdir, realpath } from "node:fs/promises";
import { relative, sep } from "node:path";

import { ToolExecutionError } from "../../errors.js";
import { resolveWithinRoot, spawnWithStopSignal } from "./helpers.js";
import type { AciToolDef } from "../types.js";

/** Default result budget; matches the model-facing "pages" expectation. */
const DEFAULT_LIMIT = 200;
/** Hard cap; over-cap `limit` is clamped silently. */
const MAX_LIMIT = 5000;

/** Directories the Node fallback skips to avoid walking dependency trees. */
const IGNORED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git"]);

/** Sentinel result string when nothing matches (stable, parseable). */
const EMPTY_RESULT = "";

/**
 * Subset of the `rg --files --glob <pattern>` invocation the tool needs.
 * Production: goes through `spawnWithStopSignal` so abort can stop the rg
 * child + descendants. Tests: inject a stub that either returns canned
 * output (parse-logic coverage without an `rg` binary) or rejects with
 * ENOENT to force the Node fallback path.
 */
export interface GlobToolDeps {
  readonly spawnRg?: (
    args: readonly string[],
    cwd: string
  ) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Factory: create the `glob` tool bound to a workspace root.
 *
 * `root` is the workspace root; `deps` is an optional test seam (production
 * callers omit it).
 */
export function createGlobTool(root: string, deps?: GlobToolDeps): AciToolDef {
  return {
    name: "glob",
    description:
      "Find files under a workspace root by glob pattern. Returns up to `limit` sorted relative paths, one per line. Empty pattern is rejected.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only",
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
      timeoutTier: "fast",
    },
    handler: async (input: unknown, ctx) => {
      const pattern = readPattern(input);
      const subPath = readSubPath(input);
      const limit = clampLimit(readLimit(input));

      // 1. Resolve + contain the search root. Throws on escape.
      const searchRoot = await resolveWithinRoot(root, subPath ?? ".");

      // 2. Resolve real paths so rg-internal symlinks don't desync us.
      const realRoot = await realpath(root);
      const realSearchRoot = await realpath(searchRoot);
      const searchPrefix = relative(realRoot, realSearchRoot); // "" or "src"

      // 3. Try rg first; fall back to Node walker on ENOENT.
      //    - Test seam path: deps.spawnRg (no signal — used only for parse
      //      logic + ENOENT-driven fallback coverage).
      //    - Production path: spawnWithStopSignal so ctx.signal can stop
      //      the rg child + descendants (ADR-0005 L14 — signal must reach
      //      any subprocess; rg spawns workers on some workloads).
      let rawPaths: string[];
      try {
        rawPaths = deps?.spawnRg
          ? await runRgViaSeam(deps.spawnRg, pattern, realSearchRoot)
          : await runRgViaProduction(pattern, realSearchRoot, ctx?.signal);
      } catch (error) {
        if (!isMissingRgError(error)) throw error;
        rawPaths = await walkAndMatch(realSearchRoot, pattern);
      }

      // 4. Prepend the search-root prefix so paths are root-relative, then
      //    sort lexicographically and truncate to `limit`.
      const rootRelative = rawPaths
        .map((p) => joinPosix(searchPrefix, p))
        .filter((p) => p.length > 0);

      rootRelative.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      const trimmed = rootRelative.slice(0, limit);

      return trimmed.length === 0 ? EMPTY_RESULT : trimmed.join("\n");
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Input helpers                                                                */
/* -------------------------------------------------------------------------- */

function readPattern(input: unknown): string {
  if (input === null || typeof input !== "object") {
    throw new ToolExecutionError("glob: input must be an object");
  }
  const pattern = (input as { pattern?: unknown }).pattern;
  if (typeof pattern !== "string") {
    throw new ToolExecutionError("glob: pattern must be a string");
  }
  if (pattern.length === 0) {
    // ADR-0004 L30: empty pattern must NOT degenerate to "match all".
    throw new ToolExecutionError(
      "glob: pattern must be a non-empty glob (e.g. '*.ts' or 'src/**/*.md')"
    );
  }
  return pattern;
}

function readSubPath(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const path = (input as { path?: unknown }).path;
  if (path === undefined) return undefined;
  if (typeof path !== "string") {
    throw new ToolExecutionError("glob: path must be a string");
  }
  return path;
}

function readLimit(input: unknown): number {
  if (input === null || typeof input !== "object") return DEFAULT_LIMIT;
  const limit = (input as { limit?: unknown }).limit;
  if (limit === undefined) return DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new ToolExecutionError("glob: limit must be a positive integer");
  }
  return limit;
}

function clampLimit(value: number): number {
  if (value > MAX_LIMIT) return MAX_LIMIT;
  return value;
}

/* -------------------------------------------------------------------------- */
/* rg path                                                                      */
/* -------------------------------------------------------------------------- */

/** Test-seam path: no signal threading; used for parse-logic + ENOENT coverage. */
async function runRgViaSeam(
  spawnRg: (
    args: readonly string[],
    cwd: string
  ) => Promise<{ stdout: string; stderr: string }>,
  pattern: string,
  realSearchRoot: string
): Promise<string[]> {
  const { stdout } = await spawnRg(
    ["--files", "--glob", pattern],
    realSearchRoot
  );
  return parseRgStdout(stdout);
}

/**
 * Production path: real `rg` via `spawnWithStopSignal` so ctx.signal can
 * cancel the rg child + its descendant processes (ADR-0005 L14).
 */
async function runRgViaProduction(
  pattern: string,
  realSearchRoot: string,
  signal: AbortSignal | undefined
): Promise<string[]> {
  const { done } = spawnWithStopSignal("rg", ["--files", "--glob", pattern], {
    cwd: realSearchRoot,
    signal,
  });
  const result = await done;
  if (result.code === 0 || result.code === 1) {
    return parseRgStdout(result.stdout);
  }
  if (signal?.aborted || result.signal !== null) {
    throw new ToolExecutionError(
      `glob: aborted before completion${result.signal ? ` (signal=${result.signal})` : ""}`
    );
  }
  throw new ToolExecutionError(
    `glob: rg exited with code ${String(result.code)}: ${result.stderr}`
  );
}

function parseRgStdout(stdout: string): string[] {
  if (stdout.length === 0) return [];
  return stdout.split("\n").filter((line) => line.length > 0);
}

function isMissingRgError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT";
}

/* -------------------------------------------------------------------------- */
/* Node fallback                                                                */
/* -------------------------------------------------------------------------- */

async function walkAndMatch(
  searchRoot: string,
  pattern: string
): Promise<string[]> {
  const matcher = compileGlob(pattern);
  const hits: string[] = [];

  const walk = async (current: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = `${current}${sep}${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      // Normalise to `/` so the matcher pattern (which uses `/`) aligns.
      const relFromSearchRoot = relative(searchRoot, full).split(sep).join("/");
      if (relFromSearchRoot.startsWith("..")) continue;
      if (matcher(relFromSearchRoot.split("/"))) {
        hits.push(relFromSearchRoot);
      }
    }
  };

  await walk(searchRoot);
  return hits;
}

/**
 * Compile a glob pattern into a predicate over a path split on `/`.
 * The matcher accepts `**` as a "zero or more segments" wildcard.
 */
function compileGlob(pattern: string): (segments: string[]) => boolean {
  const parts = pattern.split("/");
  // Strip trailing empty segment caused by patterns like "src/".
  const cleaned = parts[parts.length - 1] === "" ? parts.slice(0, -1) : parts;
  const matcher = matchSegments(cleaned, 0);
  return (segments) => matcher(segments, 0);
}

function matchSegments(
  pattern: string[],
  p: number
): (segs: string[], s: number) => boolean {
  return (segs, s) => {
    let pi = p;
    let si = s;
    while (pi < pattern.length) {
      const tok = pattern[pi];
      if (tok === "**") {
        // Collapse adjacent ** into one.
        while (pattern[pi] === "**") pi += 1;
        if (pi === pattern.length) {
          // Trailing ** matches the rest.
          return true;
        }
        const rest = matchSegments(pattern, pi);
        for (let tryAt = si; tryAt <= segs.length; tryAt += 1) {
          if (rest(segs, tryAt)) return true;
        }
        return false;
      }
      if (si >= segs.length) return false;
      if (!matchSegmentToken(tok, segs[si])) return false;
      pi += 1;
      si += 1;
    }
    return si === segs.length;
  };
}

function matchSegmentToken(token: string, segment: string): boolean {
  // Single-segment token. Supports `*` (any chars) and `?` (single char).
  let ti = 0;
  let si = 0;
  while (ti < token.length) {
    const ch = token[ti];
    if (ch === "*") {
      while (token[ti] === "*") ti += 1;
      if (ti === token.length) return true;
      for (let start = si; start <= segment.length; start += 1) {
        if (matchSegmentToken(token.slice(ti), segment.slice(start))) {
          return true;
        }
      }
      return false;
    }
    if (ch === "?") {
      if (si >= segment.length) return false;
      ti += 1;
      si += 1;
      continue;
    }
    if (si >= segment.length || segment[si] !== ch) return false;
    ti += 1;
    si += 1;
  }
  return si === segment.length;
}

/* -------------------------------------------------------------------------- */
/* Path helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** Posix-style join: `joinPosix("src", "a/b")` → `"src/a/b"`. */
function joinPosix(prefix: string, suffix: string): string {
  if (prefix === "") return suffix;
  if (suffix === "") return prefix;
  return `${prefix}/${suffix}`;
}
