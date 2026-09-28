/**
 * `glob` — ACI tool: find files by glob pattern under a workspace root.
 *
 * Contract surface (ADR-0004):
 *   - input  : { pattern: string, path?: string, limit?: integer }
 *   - output : alphabetised, root-relative paths, one per line.
 *   - empty pattern is a hard error (NOT a "match all" fallback).
 *   - try the pinned vendor engine (`<installRoot>/vendor/ripgrep/...`,
 *     same resolution as grep) first; when it cannot start (ENOENT /
 *     EACCES / EPERM) fall back to a Node walker with a small,
 *     intentionally-bounded glob matcher. A PATH `rg` is never exec'd.
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
import { relative, resolve, sep } from "node:path";

import { ToolExecutionError } from "../../errors.js";
import { resolveInstallRoot, type LiveTaskRoot } from "../../session-roots.js";
import type { FsModeContext } from "../../sandbox/fs-mode.js";
import {
  decideAndResolveReadReach,
  matchProtectedPath,
} from "../read-policy.js";
import {
  engineBinaryPath,
  isEngineUnstartable,
} from "../search/engine-manifest.js";
import { spawnWithStopSignal } from "./helpers.js";
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
 * child + descendants, and execs only the install-root pinned binary (never
 * a PATH `rg`). Tests: inject a stub that either returns canned output
 * (parse-logic coverage without an `rg` binary) or rejects with an
 * unstartable errno (ENOENT / EACCES / EPERM) to force the Node fallback
 * path.
 */
export interface GlobToolDeps {
  readonly spawnRg?: (
    args: readonly string[],
    cwd: string
  ) => Promise<{ stdout: string; stderr: string }>;
  /**
   * Override the pinned binary path. Absent → `<resolveInstallRoot()>/vendor/ripgrep/...`
   * (same resolution as grep). Tests may point at a nonexistent path to drive
   * the "install-root binary missing" fallback branch.
   */
  readonly engineBinaryPath?: string;
  /**
   * Stable project identity root. When present, absolute paths (and relative
   * paths missing from the live task root) may be searched read-only there.
   */
  readonly projectIdentityRoot?: string;
  /**
   * Registry seam for the isolation switch. Direct tool callers default to
   * deriving the main checkout from a task-worktree-shaped root; production
   * OFF assembly sets this false to preserve the historical read boundary.
   */
  readonly allowProjectIdentityRoot?: boolean;
  /**
   * ADR-0128: fs isolation-mode holder (bash's pass-through shape). The
   * handler reads `get()` once per call — same batch-snapshot discipline as
   * the root snapshot. Absent → `global` (V1 baseline). Feeds the canonical
   * read policy; both modes answer the same.
   */
  readonly fsMode?: FsModeContext;
}

/**
 * Snapshot the live root at handler invocation time. Accepts either a
 * literal path (legacy / forward-compat shape — tests and other one-shot
 * callers pass `string`) or a `LiveTaskRoot` cell (the registry threads
 * the cell so that `worktree rebind` in the same run reaches this
 * handler). The returned `string` is the snapshot value — reading the cell
 * more than once per handler call is forbidden.
 */
function readRoot(root: string | LiveTaskRoot): string {
  return typeof root === "string" ? root : root.read();
}

/**
 * Factory: create the `glob` tool bound to a workspace root.
 *
 * `root` may be a `LiveTaskRoot` cell; the handler reads the snapshot at
 * call time, so `worktree rebind` in the same run lands the next call in
 * the rebound tree. `string` callers (legacy tests, one-shot consumers)
 * keep byte-identical behavior. `deps` is an optional test seam
 * (production callers omit it).
 */
export function createGlobTool(
  root: string | LiveTaskRoot,
  deps?: GlobToolDeps
): AciToolDef {
  return {
    name: "glob",
    description:
      "Discover files by glob pattern under a workspace root before opening them with read_file / edit_file / write_file; supports `*`, `**`, `?` segments (rhymes with the bundled ripgrep's `--glob` semantics). Returns up to `limit` sorted root-relative paths, one per line; default 200, hard cap 5000. Pair with grep to scan content within the matched paths.",
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

      // Per-handler batch snapshot: the root is read once at entry and
      // frozen for the whole path (resolve → realpath → rg/fallback). Later
      // cell flips inside the handler do not leak into this call. With no
      // cell, fall back to the root captured at factory time (legacy parity).
      const rootAtCall = readRoot(root);
      const target = subPath ?? ".";

      // ADR-0128 + SC6: one shared flow owner (read-policy.ts
      // `decideAndResolveReadReach`) judges the requested search root on the
      // raw path (pre-resolution) AND its canonical form before any walk or
      // spawn; protection is positive — a protected path is refused even
      // where containment would reach it. The allow verdict is also what
      // widens the search root past the containment roots: ordinary host
      // directories are discoverable in both modes, and the per-emission
      // filter still drops protected paths under any root, widened or not.

      // 1. Resolve the search root: containment arm inside the roots,
      //    policy-authorized host path outside them. Throws on escape only
      //    where the policy did not authorize the reach.
      const searchRoot = await decideAndResolveReadReach({
        tool: "glob",
        primaryRoot: rootAtCall,
        target,
        deps,
      });

      // 2. Resolve real paths so rg-internal symlinks don't desync us.
      const realRoot = await realpath(rootAtCall);
      const realSearchRoot = await realpath(searchRoot);
      const searchPrefix = relative(realRoot, realSearchRoot); // "" or "src"

      // 3. Try the pinned engine first; fall back to the Node walker when it
      //    cannot start (same resolve + degrade contract as grep, ADR-0089).
      const rawPaths = await collectMatchedPaths({
        spawnRg: deps?.spawnRg,
        binaryPath:
          deps?.engineBinaryPath ??
          engineBinaryPath(
            resolveInstallRoot(),
            process.platform,
            process.arch
          ),
        pattern,
        realSearchRoot,
        signal: ctx?.signal,
      });

      // 4. Prepend the search-root prefix so paths are root-relative, drop
      //    any emitted path that resolves onto the protected-path roster
      //    (per-emission half of ADR-0128 SC2/SC3: a protected file under an
      //    otherwise-allowed root never appears — applied to the merged
      //    result list, so it covers both the rg path and the Node walker),
      //    then sort lexicographically and truncate to `limit`.
      const rootRelative = rawPaths
        .map((p) => joinPosix(searchPrefix, p))
        .filter((p) => p.length > 0)
        .filter((p) => matchProtectedPath(resolve(realRoot, p)) === null);

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
    // ADR-0004: an empty pattern must NOT degenerate to "match all".
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

/**
 * Engine dispatch for step 3 of the handler (kept out of the handler so the
 * branching complexity lives here):
 *   - Test seam path: deps.spawnRg (no signal — used only for parse logic +
 *     unstartable-errno-driven fallback coverage).
 *   - No manifest asset for this platform: straight to the walker; a legal
 *     downgrade, not an error.
 *   - Production path: spawnWithStopSignal so ctx.signal can stop the rg
 *     child + descendants (ADR-0005: the signal must reach any subprocess;
 *     rg spawns workers on some workloads).
 * Any unstartable spawn errno (ENOENT / EACCES / EPERM) degrades to the
 * walker instead of failing the call.
 */
async function collectMatchedPaths(input: {
  readonly spawnRg: GlobToolDeps["spawnRg"];
  readonly binaryPath: string | undefined;
  readonly pattern: string;
  readonly realSearchRoot: string;
  readonly signal: AbortSignal | undefined;
}): Promise<string[]> {
  const { spawnRg, binaryPath, pattern, realSearchRoot, signal } = input;
  try {
    if (spawnRg) return await runRgViaSeam(spawnRg, pattern, realSearchRoot);
    if (binaryPath === undefined)
      return await walkAndMatch(realSearchRoot, pattern);
    return await runRgViaProduction(
      binaryPath,
      pattern,
      realSearchRoot,
      signal
    );
  } catch (error) {
    if (!isEngineUnstartable(error)) throw error;
    return await walkAndMatch(realSearchRoot, pattern);
  }
}

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
 * Production path: the install-root pinned rg via `spawnWithStopSignal` so
 * ctx.signal can cancel the rg child + its descendant processes (ADR-0005).
 * Never execs a PATH `rg` — `binaryPath` is the absolute vendor path resolved
 * by the caller.
 */
async function runRgViaProduction(
  binaryPath: string,
  pattern: string,
  realSearchRoot: string,
  signal: AbortSignal | undefined
): Promise<string[]> {
  const { done } = spawnWithStopSignal(
    binaryPath,
    ["--files", "--glob", pattern],
    {
      cwd: realSearchRoot,
      signal,
    }
  );
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
