/**
 * grep tool — search-surface contract.
 *
 * Behavior:
 *   - Output modes: `paths` (default, workspace-relative only) / `content`
 *     (`path:line:text`) / `count` (`path:count` + repo-wide `total:`). The
 *     input alias `files_with_matches` normalizes to `paths` before the
 *     engine — it is not a fourth mode.
 *   - Pagination: `offset` + `head_limit` (default 50, hard cap 2000) slice
 *     the **already sorted** list; sorting (path, then line number) happens
 *     before slicing. An offset past the last entry with hits → exact
 *     receipt `No entries at this offset`; no matches → empty string.
 *   - Narrowing: `path` (directory) / `glob` (file-name pattern) / `type`
 *     (language). Unknown `type` and a bad regex are **two distinct** typed
 *     errors.
 *   - Line window: `also` + `within_lines` (default 5) is a **filter** — the
 *     second literal is only sought inside the window.
 *   - Engine (ADR-0089): when rg is available, matches come only from rg
 *     (no second JS filtering). When it cannot start (missing / ENOENT /
 *     not executable) → Node walk + JS `RegExp` on compilable patterns; the
 *     call still succeeds. The hit set need not match rg — Node does not
 *     imitate rg's default-engine reject set. There is **no** fallback to a
 *     PATH `rg`.
 *
 * Complexity: flag parsing / argv / line parsing / window / group build /
 * sort / pagination / projection each live in their own module; this file
 * only assembles and dispatches engines.
 */

import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { assertNoGrepSubstitution } from "./role-substitution.js";
import { isTaskWorktreePath } from "../../isolation/worktree-gate.js";
import { resolveInstallRoot, type LiveTaskRoot } from "../../session-roots.js";
import { resolveWithinRoot } from "./helpers.js";
import { compilePattern } from "../search/pattern.js";
import {
  GREP_OUTPUT_VALUES,
  parseQuerySpec,
  rejectRetiredLimitField,
} from "../search/options.js";
import { engineSpecFor, renderResult } from "../search/pipeline.js";
import { readWorkspaceLines } from "../search/file-lines.js";
import { assertScopeWithinLimit } from "../search/scope-guard.js";
import { nodeScan, toWorkspaceRelative } from "../search/node-scan.js";
import {
  engineBinaryPath,
  RIPGREP_VERSION,
} from "../search/engine-manifest.js";
import {
  runRgEngine,
  type EngineResult,
  type SpawnFn,
} from "../search/rg-engine.js";
import type { QuerySpec } from "../search/types.js";

export type { SpawnFn } from "../search/rg-engine.js";

/** Dependency injection: override points (defaults = production values). */
export interface GrepToolDeps {
  /** Replace engine spawn (typically: simulate a missing install-root binary to drive the Node degrade path). */
  readonly spawn?: SpawnFn;
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
   * Override the pinned binary path. Absent → `<resolveInstallRoot()>/vendor/ripgrep/...`.
   * Tests may point at a nonexistent path to drive the "install-root binary
   * missing" branch.
   */
  readonly engineBinaryPath?: string;
  /**
   * Scope-gate file-count override. Absent → `GREP_SCOPE_FILE_LIMIT`
   * (production value). Tests inject a small value to simulate an
   * oversize tree; both engines read it, so the same `path` gets the same
   * verdict on the rg and Node paths.
   */
  readonly scopeFileLimit?: number;
}

interface HandlerInput {
  readonly pattern?: unknown;
  readonly path?: unknown;
}

interface CompiledInput {
  readonly spec: QuerySpec;
  readonly searchRoot: string;
  readonly workspaceRoot: string;
}

/**
 * Snapshot the live root at handler invocation time. Accepts either a
 * literal path (legacy / forward-compat shape — tests and other one-shot
 * callers pass `string`) or a `LiveTaskRoot` cell (T6: registry threads
 * the cell so that `worktree rebind` in the same run reaches this
 * handler). The returned `string` is the snapshot value — D2 forbids
 * reading the cell more than once per handler call.
 */
function readRoot(root: string | LiveTaskRoot): string {
  return typeof root === "string" ? root : root.read();
}

export function createGrepTool(
  root: string | LiveTaskRoot,
  deps?: GrepToolDeps
): AciToolDef {
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<string> => {
    // Per-handler batch snapshot: root is read once at entry and frozen for
    // the whole path (compileInput → rg / Node scan). Later cell flips inside
    // the handler do not leak into this call. No cell → fall back to the
    // factory-captured root (legacy parity).
    rejectRetiredLimitField(input);
    // ADR-0117 role-substitution gate: structure-shaped patterns need
    // same-session fallback evidence (trajectory only). Not a hard-wall —
    // the frozen tables live in role-substitution.ts.
    assertNoGrepSubstitution(input, ctx?.messages, ctx?.toolUseId);
    const rootAtCall = readRoot(root);
    const projectIdentityRoot = resolveProjectIdentityRoot(rootAtCall, deps);
    const resolvedRoot = await realpath(rootAtCall);
    const compiled = await compileInput(
      input,
      resolvedRoot,
      projectIdentityRoot
    );

    const binaryPath =
      deps?.engineBinaryPath ??
      engineBinaryPath(resolveInstallRoot(), process.platform, process.arch);
    // Sampling spec: with `also` present, read content lines (the line
    // window needs line numbers to judge).
    const sampleSpec = engineSpecFor(compiled.spec);
    // Compiling the main pattern happens **only on the Node degrade path**
    // (ADR-0089): with rg, matches come only from rg and rg's own pattern
    // errors are reported by the rg subprocess (rc=2); when rg cannot start,
    // the Node walk + `RegExp` still succeed. The shared entry point does not
    // pre-judge pattern legality for the rg path — constructs rg accepts but
    // JS rejects (PCRE2 named groups `(?P<n>abc)`, inline flag `(?i)abc`)
    // must be able to travel the rg path.
    const explicitFileRel = await explicitFileRelative(compiled);
    const readLines = (path: string) =>
      readWorkspaceLines(compiled.workspaceRoot, path, {
        allowOversize: path === explicitFileRel,
      });

    // Scope gate: both engines **share** this pre-check, so success/failure
    // for the same `path` does not vary by engine. Explicit single-file `path`
    // and affirmative `glob` are exempt (see scope-guard). The thrown
    // ToolExecutionError is sanitized by the executor and returned to the
    // model as this call's `execution_failed` tool_result — not a turn-level
    // timeout.
    await assertScopeWithinLimit({
      workspaceRoot: compiled.workspaceRoot,
      searchRoot: compiled.searchRoot,
      explicitFile: explicitFileRel !== undefined,
      glob: compiled.spec.glob,
      ...(deps?.scopeFileLimit !== undefined
        ? { limit: deps.scopeFileLimit }
        : {}),
    });

    const result = await resolveEngineResult({
      binaryPath,
      compiled,
      sampleSpec,
      spawn: deps?.spawn,
      signal: ctx?.signal,
    });

    return renderResult({ spec: compiled.spec, result, readLines });
  };

  return Object.freeze({
    name: "grep",
    description: GREP_DESCRIPTION,
    inputSchema: GREP_INPUT_SCHEMA,
    handler,
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
    },
  });
}

/** Model-visible text: schema and description live as module constants, keeping the factory short. */
export const GREP_DESCRIPTION = `Search file contents under a workspace directory using a regular expression; use it to discover which files carry a pattern before reading them, and pair it with read_file once you have a pinpointed path. Returns relative paths by default (output=paths) — set output=\"content\" for path:line:text or output=\"count\" for per-file counts plus a total:. Narrow with glob / type, show nearby lines with context, or keep only hits whose second literal also appears within within_lines of the match. Page a sorted result list with offset + head_limit (default 50, hard cap ${String(2000)}); an offset past the last entry returns "No entries at this offset". Runs on a bundled search engine (ripgrep ${RIPGREP_VERSION}) resolved from the install root, and falls back to a built-in Node scan when that engine is unavailable — the Node fallback walks files and matches with JavaScript RegExp and may answer differently from ripgrep.`;

/**
 * Input schema (two layers of the same contract as the parsing in
 * `options.ts`).
 *
 * `additionalProperties: false` is deliberately not set — retired fields
 * `limit` / `grep_limit` must give the model a typed pointer (to
 * `head_limit`), but ajv's generic `additionalProperties` message
 * (`must NOT have additional properties`) would preempt the handler's
 * `rejectRetiredLimitField` and be all the model sees. Extra properties
 * pass the schema; the handler's `rejectRetiredLimitField` (step 1) rejects
 * retired names; genuinely unknown fields are silently ignored by
 * `compileInput → parseQuerySpec` (same shape as
 * `additionalProperties:true`, without weakening required/type gates).
 */
export const GREP_INPUT_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    path: { type: "string" },
    output: {
      type: "string",
      // Output-mode enum + input alias, derived from the options SSOT. ajv
      // validates before the handler (compiled at registry construction), so an
      // alias outside the enum would never reach `readOutput`'s normalization;
      // including it in the schema still leaves exactly three output modes
      // (the alias normalizes to paths).
      enum: [...GREP_OUTPUT_VALUES],
      default: "paths",
    },
    ignoreCase: { type: "boolean", default: false },
    context: { type: "integer", default: 0, minimum: 0, maximum: 50 },
    glob: { type: "string" },
    type: { type: "string" },
    also: { type: "string" },
    within_lines: { type: "integer", default: 5, minimum: 0 },
    offset: { type: "integer", default: 0, minimum: 0 },
    head_limit: { type: "integer", default: 50, minimum: 1, maximum: 2000 },
  },
  required: ["pattern"],
} as const;

/**
 * Workspace-relative path when the search root is a file (same shape as
 * `node-scan`'s relPath); directory / nonexistent path → `undefined` (the
 * size gate still applies).
 */
async function explicitFileRelative(
  compiled: CompiledInput
): Promise<string | undefined> {
  const info = await stat(compiled.searchRoot).catch(() => null);
  if (info === null || !info.isFile()) return undefined;
  return toWorkspaceRelative(compiled.workspaceRoot, compiled.searchRoot);
}

/**
 * Engine dispatch (ADR-0089).
 *
 * Production only execs the install-root pinned binary; rg present → use rg
 * hits directly (no second JS filtering). Cannot start → Node walk + JS
 * `RegExp` (already compiled by `compilePattern`), call still succeeds. Hit
 * sets may differ between paths (Node does not imitate rg's default-engine
 * reject set). There is **no** PATH `rg` branch — the contract forbids that
 * stopgap path.
 */
async function resolveEngineResult(input: {
  readonly binaryPath: string | undefined;
  readonly compiled: CompiledInput;
  readonly sampleSpec: QuerySpec;
  readonly spawn: SpawnFn | undefined;
  readonly signal: AbortSignal | undefined;
}): Promise<EngineResult> {
  const fromRg = await runRgEngine({
    spec: input.sampleSpec,
    binaryPath: input.binaryPath,
    searchRoot: input.compiled.searchRoot,
    workspaceRoot: input.compiled.workspaceRoot,
    signal: input.signal,
    spawn: input.spawn,
  });
  if (fromRg.kind !== "unavailable") return fromRg;

  // Node degrade path (ADR-0089): the main pattern is compiled only here —
  // the rg path does not pre-judge legality, and constructs rg accepts but JS
  // rejects (PCRE2 named groups / inline flags) must travel the rg path. If
  // the Node side cannot compile → typed rejection (naming the pattern, not
  // conflated with the unknown-type failure domain).
  const regex = compilePattern(
    input.sampleSpec.pattern,
    input.sampleSpec.ignoreCase
  );
  const lines = await nodeScan({
    spec: input.sampleSpec,
    workspaceRoot: input.compiled.workspaceRoot,
    searchRoot: input.compiled.searchRoot,
    regex,
  });
  return { kind: "lines", lines };
}

async function compileInput(
  input: unknown,
  workspaceRoot: string,
  projectIdentityRoot?: string
): Promise<CompiledInput> {
  const spec = parseQuerySpec(input);
  const rawSub = readSubPath(input);
  const searchRoot = await resolveSearchRoot(
    workspaceRoot,
    rawSub,
    projectIdentityRoot
  );
  return { spec, searchRoot, workspaceRoot };
}

function readSubPath(input: unknown): string {
  if (input === null || typeof input !== "object") return ".";
  const path = (input as HandlerInput).path;
  return typeof path === "string" ? path : ".";
}

/**
 * Identity-root read passthrough, gated to mirror `read-file.ts` so the
 * three read-only tools widen by the same trigger.
 *
 * - Explicit `projectIdentityRoot` threaded: returns it iff
 *   `allowProjectIdentityRoot` is `true` AND the live root is already a
 *   task worktree (post-rebind); `allowProjectIdentityRoot === false` is
 *   a hard deny.
 * - No explicit `projectIdentityRoot`: returns `undefined`. There is no
 *   shape-based fallback to a derived main checkout — OFF assembly must get
 *   no extra read root and worker assembly must not widen its tool surface
 *   merely because the root path looks task-worktree-shaped.
 */
function resolveProjectIdentityRoot(
  root: string,
  deps: GrepToolDeps | undefined
): string | undefined {
  const projectIdentityRoot = deps?.projectIdentityRoot;
  if (projectIdentityRoot === undefined) return undefined;
  if (deps?.allowProjectIdentityRoot === true && !isTaskWorktreePath(root)) {
    return undefined;
  }
  if (deps?.allowProjectIdentityRoot === false) return undefined;
  return projectIdentityRoot;
}

/**
 * Keep the normal task-root interpretation first, while making the stable
 * identity root convenient for a relative project file name such as
 * `AGENTS.md` after a rebind.
 */
async function resolveSearchRoot(
  workspaceRoot: string,
  target: string,
  projectIdentityRoot: string | undefined
): Promise<string> {
  const extraRoots =
    projectIdentityRoot === undefined ? undefined : [projectIdentityRoot];
  const primary = await resolveWithinRoot(workspaceRoot, target, extraRoots);
  if (projectIdentityRoot === undefined || isAbsolute(target)) return primary;
  try {
    await stat(primary);
    return primary;
  } catch {
    const identityCandidate = await resolveWithinRoot(
      projectIdentityRoot,
      target
    );
    try {
      await stat(identityCandidate);
      return identityCandidate;
    } catch {
      return primary;
    }
  }
}
