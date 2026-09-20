/**
 * read_file tool — stateless precise file reading.
 *
 * Contract (ADR-0084, **amends** ADR-0004's "default 200 lines"):
 *   - input: path (required), offset? (default 0, 0-based), limit? (**optional**)
 *   - **omitting `limit` = read from offset toward EOF**: the whole-file page
 *     hard-stops at 16000 code points; when EOF is not reached the tail
 *     carries a continuation hint (with the next offset). The "default 200
 *     lines" behavior no longer exists.
 *   - giving `limit` = still a line window, hard-capped at 2000 lines
 *     (existing clamp); the same page budgets also constrain the line
 *     window, and when a budget hits first the tail carries a continuation
 *     hint (line-window semantics unchanged).
 *   - resolve+realpath restricted inside root (symlink escape rejected)
 *   - must be a file (directory errors); >1MB rejected with guidance to
 *     grep + offset/limit precise reads
 *   - NUL byte (0x00) detection: binary files rejected
 *   - output: plain string `${lineNo.padStart(6)}\t${line}`, 1-based line
 *     numbers (first line after offset = offset+1)
 *   - errors always throw ToolExecutionError (executor converts to
 *     execution_failed)
 *   - the factory closure holds only root; the handler has no cross-call state
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { ToolExecutionError } from "../../errors.js";
import { isTaskWorktreePath } from "../../isolation/worktree-gate.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import type { LastReadLedgerHost } from "../last-read-ledger.js";
import { resolveSessionFenceTmp } from "../../sandbox/fence-tmp.js";
import { resolveWithinRoot } from "./helpers.js";

/** Hard cap for an explicit `limit` (line window); without `limit` the read goes through `MAX_READ_CODE_POINTS`. */
const MAX_LIMIT = 2000;
const MAX_FILE_BYTES = 1_048_576; // 1 MiB
/**
 * Page body hard stop (code points, excluding the continuation-hint line).
 * Shared by both body paths (whole-file read without `limit`, explicit
 * `limit` line window). The executor's 20000-char total gate (ADR-0006) is
 * untouched — this constant is the tool layer's precision gate so that the
 * "retry with a smaller offset" recovery path exists before truncation.
 */
const MAX_READ_CODE_POINTS = 16_000;
/**
 * Page hard stop in UTF-16 units. The executor's 20000 gate counts
 * `String.length` (UTF-16 units), while an astral code point takes two
 * units — budgeting only in code points would produce ~32000-unit pages
 * that get double-truncated by the executor (forbidden by ADR-0006).
 * 19000 leaves headroom for the continuation hint / truncation marker;
 * both budgets constrain together, first hit wins.
 */
const MAX_READ_UTF16_UNITS = 19_000;

/**
 * Snapshot the live root at handler invocation time. Accepts either a
 * literal path (legacy / forward-compat shape — tests and other one-shot
 * callers pass `string`) or a `LiveTaskRoot` cell (the registry threads
 * the cell so that a `worktree rebind` in the same run reaches this
 * handler). The returned `string` is the snapshot value — reading the cell
 * more than once per handler call is forbidden, so callers must reuse the
 * snapshot for both resolve and any other root-relative work.
 */
function readRoot(root: string | LiveTaskRoot): string {
  return typeof root === "string" ? root : root.read();
}

export interface CreateReadFileToolOptions {
  /** ADR-0019: per-root state anchor. When provided, `<workspaceRoot>/.iknow`
   *  is added to the read-allowed roots so the agent can read its own per-root
   *  state at parity with the home profile. The protected-path check in
   *  fs-policy (still gating `<workspaceRoot>/.iknow/...` writes from the
   *  bash fence) keeps the write side locked down; read_file's seam only
   *  widens the read scope. Defaults to `root` (cwd) — the
   *  legacy shape — to preserve the existing read-file-profile contract
   *  when workspaceRoot is not threaded. */
  readonly workspaceRoot?: string;
  /** ADR-0037: identity-root read passthrough. After a
   *  worktree rebind the live `taskRoot` is the new task worktree (which
   *  does NOT contain the project's `AGENTS.md` / `permissions.toml` /
   *  project rules). The stable `projectIdentityRoot` is threaded here so
   *  read_file can still reach those identity files at read-only depth —
   *  this is the **read** half of the identity-root passthrough
   *  (write/edit/bash intentionally do NOT receive this; their fence is
   *  the live root). Absent or equal to the live root → no extra entry
   *  (the root itself already covers it). */
  readonly projectIdentityRoot?: string;
  /**
   * Dynamic authorization for the identity-root passthrough. Production sets
   * this when isolation is ON; the handler then requires the live root to be a
   * task worktree, so a same-run rebind can open the read path without
   * widening the OFF/main-root surface.
   */
  readonly allowProjectIdentityRoot?: boolean;
  /**
   * ADR-0084 last-read ledger host. Present → a successful read records the
   * resolved canonical path on this conversation's ledger, so a later
   * non-empty `write_file` on it passes the freshness gate. Absent → no
   * recording (legacy / direct-factory callers); the gate itself lives in
   * write_file, so a missing host only ever means "extra reads", never a
   * wrongly-allowed overwrite.
   */
  readonly lastReadLedger?: LastReadLedgerHost;
  /**
   * ADR-0092 session tmp identity (same semantics as WriteFileOpts.tmpDir):
   * an explicit host pad (tests / worker pad). Present → the pad becomes
   * read_file's own containment read root instead of relying on `~/.iknow`
   * extraReadRoots happening to admit it; absent → no extra read root.
   */
  readonly tmpDir?: string;
  /** Session project dir; with `ctx.conversationId` → `<sessionFolder>/fence-tmp` pad. */
  readonly projectDir?: string;
}

/** `~/.iknow/` — the agent's own profile directory (readUserProfile in the
 *  assembly layer already reads `user.md` from here every turn). */
function iknowProfileRoot(): string {
  return join(homedir(), ".iknow");
}

/**
 * Compute the per-call extraReadRoots anchored to the same wave snapshot as
 * `rootAtCall`. Both inputs are passed by the caller so the conditional
 * check uses the LIVE root — not a factory-time closure.
 *
 * Read-only reachability surface:
 *   - `~/.iknow/` (home profile — always)
 *   - `<workspaceRoot>/.iknow` (per-root persona state) when threaded and
 *     distinct from the live root
 *   - `<projectIdentityRoot>` (ADR-0037 identity-root passthrough) when
 *     threaded and distinct from the live root
 *
 * Containment remains the read_file contract: escape is rejected by
 * `resolveWithinRoot` regardless of which extra root admitted the path.
 */
function computeExtraReadRoots(
  rootAtCall: string,
  workspaceRoot: string | undefined,
  projectIdentityRoot: string | undefined
): readonly string[] {
  const extras: string[] = [iknowProfileRoot()];
  if (workspaceRoot && workspaceRoot !== rootAtCall) {
    extras.push(join(workspaceRoot, ".iknow"));
  }
  if (projectIdentityRoot && projectIdentityRoot !== rootAtCall) {
    extras.push(projectIdentityRoot);
  }
  return Object.freeze(extras);
}

export function createReadFileTool(
  root: string | LiveTaskRoot,
  opts?: CreateReadFileToolOptions
): AciToolDef {
  // read_file is a read-only tool. Beyond the primary sandbox root (cwd) it
  // may also read the agent's own profile at `~/.iknow/` — the user asked for
  // this to be allowed by default. Write tools stay cwd-scoped.
  //
  // `root` may be a `LiveTaskRoot` cell. The handler snapshots the cell at
  // call time and rebuilds `extraReadRoots` against that snapshot, so root
  // + extras share a single wave vintage — no "root is new, extras are old"
  // mid-stream mix. Legacy `string` callers keep byte-identical behavior.
  //
  // ADR-0019: when workspaceRoot is threaded, `<workspaceRoot>/.iknow` is
  // added as a second read root so the agent's per-root persona state
  // reaches the same surface as the global home profile. The contract is
  // reachability-only: extraReadRoots grants traversal through
  // `resolveWithinRoot`. Write enforcement (the bash channel's `.iknow`
  // state files becoming `execution_failed`) is the permission chain +
  // bwrap hard-wall (ADR-0092 global mode binds the host root, system
  // prefixes read-only; cwd writes are gated by the validator +
  // `--ro-bind cwd` EROFS). Read and protection are independent and
  // intentionally so.
  //
  // ADR-0037: projectIdentityRoot threads the read-only identity-root
  // passthrough so rebind doesn't strand AGENTS.md / permissions.toml /
  // project rules.
  return Object.freeze({
    name: "read_file",
    description:
      "Read a UTF-8 text file from a 0-based offset through end of file by default; the whole-file page stops at 16000 code points and the tail carries the next offset when the file continues. A line too long for the page is cut with an inline truncation marker — the rest of that line is not reachable via offset paging, since offset counts lines. Pass `limit` to read a line window instead (hard cap 2000 lines). Pair with grep to locate a region in large files and with glob to discover candidate paths first. Returns each line as a 1-based line number right-padded to 6 chars, a tab, then the line text; stateless — each call reads from the offset you give. Files >1MB are out of scope (locate with grep and read precisely with offset/limit); binary files (NUL byte) are out of scope.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          description:
            "Read at most this many lines from offset (hard cap 2000). Omit it to read through end of file, with the whole-file page capped at 16000 code points and the next offset reported when more remains.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    },
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      const params = parseInput(input);
      // Same wave snapshot — root and extras share the snapshot.
      const rootAtCall = readRoot(root);
      const projectIdentityRoot = resolveProjectIdentityRoot(rootAtCall, opts);
      const extraReadRoots = computeExtraReadRoots(
        rootAtCall,
        opts?.workspaceRoot,
        projectIdentityRoot
      );
      // ADR-0092: same identity as the write tools' sessionTmpRoot — the
      // session tmp pad is a first-class containment root for reads too.
      const sessionTmpRoot = resolveSessionFenceTmp({
        tmpDir: opts?.tmpDir,
        projectDir: opts?.projectDir,
        conversationId: ctx?.conversationId,
      });
      const resolved = await resolveReadTarget(rootAtCall, params.path, {
        extraReadRoots,
        projectIdentityRoot,
        sessionTmpRoot,
      });
      let info;
      try {
        info = await stat(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ToolExecutionError(
            `[read_file] file not found: ${resolved}`
          );
        }
        throw error;
      }
      if (info.isDirectory()) {
        throw new ToolExecutionError(
          `[read_file] not a file (is a directory): ${resolved}`
        );
      }
      if (info.size > MAX_FILE_BYTES) {
        throw new ToolExecutionError(
          "[read_file] file exceeds 1MB limit, locate with grep then read precisely with offset/limit"
        );
      }
      const buffer = await readFile(resolved);
      if (buffer.includes(0x00)) {
        throw new ToolExecutionError(
          `[read_file] binary file rejected: ${resolved}`
        );
      }
      const text = buffer.toString("utf8");
      return completeRead(text, params, { opts, ctx, resolved });
    },
  });
}

/**
 * ADR-0084 read tail: choose the body mode (read-to-EOF vs explicit line
 * window), then record in the ledger.
 *
 * Order is part of the contract — build the body **first** (failure paths
 * like offset-out-of-range throw here), record **after**. Reversed, a
 * failed read would be recorded as "read", and write_file's non-empty
 * overwrite gate would then be opened by that failed read.
 *
 * Recording key = `resolved` (output of `resolveWithinRoot`), the same
 * source as write_file's `target` (same resolve output), so both sides can
 * hit the same entry.
 */
function completeRead(
  text: string,
  params: ParsedInput,
  deps: {
    readonly opts: CreateReadFileToolOptions | undefined;
    readonly ctx: ToolExecutionContext | undefined;
    readonly resolved: string;
  }
): string {
  const body =
    params.limit === undefined
      ? readToEnd(text, params.offset)
      : sliceLines(text, params.offset, params.limit);
  deps.opts?.lastReadLedger
    ?.ledgerFor(deps.ctx?.conversationId)
    ?.record(deps.resolved);
  return body;
}

function resolveProjectIdentityRoot(
  root: string,
  opts: CreateReadFileToolOptions | undefined
): string | undefined {
  const projectIdentityRoot = opts?.projectIdentityRoot;
  if (projectIdentityRoot === undefined) return undefined;
  if (opts?.allowProjectIdentityRoot === true && !isTaskWorktreePath(root)) {
    return undefined;
  }
  if (opts?.allowProjectIdentityRoot === false) return undefined;
  return projectIdentityRoot;
}

/**
 * Relative paths normally resolve against the live task root. If that root is
 * a freshly-created bare worktree and the requested project identity file is
 * absent there, try the explicitly supplied extra read roots as a
 * convenience. Absolute paths continue to use the shared containment helper
 * directly.
 *
 * `sessionTmpRoot` (ADR-0092) rides into containment through the same
 * `resolveWithinRoot` options as the write tools' `sessionTmpRoot` — one
 * identity path, no separate aliasing. The identity-root fallback arm stays
 * pad-free: the pad is anchored to conversationId, not to projectIdentityRoot.
 */
async function resolveReadTarget(
  root: string,
  target: string,
  roots: {
    readonly extraReadRoots: readonly string[];
    readonly projectIdentityRoot: string | undefined;
    readonly sessionTmpRoot: string | undefined;
  }
): Promise<string> {
  const { extraReadRoots, projectIdentityRoot } = roots;
  const primary = await resolveWithinRoot(root, target, {
    extraReadRoots,
    sessionTmpRoot: roots.sessionTmpRoot,
  });
  if (
    projectIdentityRoot === undefined ||
    extraReadRoots.length === 0 ||
    isAbsolute(target)
  ) {
    return primary;
  }
  try {
    await stat(primary);
    return primary;
  } catch {
    const candidate = await resolveWithinRoot(projectIdentityRoot, target);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      return primary;
    }
  }
}

interface ParsedInput {
  readonly path: string;
  readonly offset: number;
  /**
   * Explicit line window; **omitting `limit` → `undefined`** (unlike the
   * old contract's default of 200). The handler dispatches between "line
   * window" and "read-to-EOF / 16000 cp" based on this.
   */
  readonly limit: number | undefined;
}

function parseInput(input: unknown): ParsedInput {
  if (input === null || typeof input !== "object") {
    throw new ToolExecutionError("[read_file] input must be an object");
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    throw new ToolExecutionError("[read_file] path must be a non-empty string");
  }
  const offset =
    raw.offset === undefined
      ? 0
      : requireNonNegativeInteger(raw.offset, "offset");
  // No limit → undefined (whole-read path); only an explicit limit clamps to 2000 lines.
  const limit =
    raw.limit === undefined
      ? undefined
      : Math.min(requirePositiveInteger(raw.limit, "limit"), MAX_LIMIT);
  return { path: raw.path, offset, limit };
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ToolExecutionError(
      `[read_file] ${name} must be a non-negative integer`
    );
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolExecutionError(
      `[read_file] ${name} must be a positive integer`
    );
  }
  return value;
}

const EMPTY_FILE_MARKER = "[read_file] ok (empty file)";

function splitNumberedLines(text: string): string[] {
  const lines = text.split("\n");
  // Drop trailing empty element produced by a trailing newline so the
  // "last line" displayed matches the file's last newline position.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function assertOffsetInRange(offset: number, lineCount: number): void {
  if (offset >= lineCount) {
    throw new ToolExecutionError(
      `[read_file] offset ${offset} past end of file (${lineCount} lines); use a smaller offset`
    );
  }
}

function renderLine(lineNumber: number, line: string): string {
  return `${String(lineNumber).padStart(6)}\t${line}`;
}

/**
 * Explicit `limit` path — a line window, semantics unchanged since ADR-0004:
 * window = at most `limit` lines from `offset` (hard cap 2000, clamped by
 * parseInput).
 *
 * The window carries **the same page budgets as the whole-read path**
 * (16000 code points / 19000 UTF-16 units): `limit: 2000` on wide-line
 * files could produce ~816000-unit pages, exactly the double truncation
 * ADR-0006 forbids — the tool layer over-delivers and the executor amputates
 * the tail, leaving the model an unexplained half page. When a budget hits
 * first, the window ends early with an **explicit** continuation marker;
 * when the window's own line count tops out first, the body is
 * byte-identical to the old contract, no marker.
 */
function sliceLines(text: string, offset: number, limit: number): string {
  if (text.length === 0) return EMPTY_FILE_MARKER;
  const lines = splitNumberedLines(text);
  assertOffsetInRange(offset, lines.length);
  const windowEnd = Math.min(offset + limit, lines.length);
  const page = collectPage(lines, offset, windowEnd);
  if (page.nextIndex >= windowEnd) return page.body;
  return `${page.body}\n${windowCutHint(page.nextIndex, windowEnd, lines.length)}`;
}

/**
 * Continuation marker for when a page budget (not the `limit` line count)
 * cuts a line window short. Separate from the whole-read path's
 * `continuationHint`: it must state clearly that the unfinished window is
 * caused by the page budget, otherwise the model mistakes the short page
 * for "limit satisfied" and stops paging.
 *
 * The recovery path is **a larger `offset` on the next call** (line-window
 * semantics unchanged, `limit` may be carried as-is) — the offset in the
 * hint must be a value the next call accepts.
 */
function windowCutHint(
  nextOffset: number,
  windowEnd: number,
  totalLines: number
): string {
  return `[read_file] page budget cut this window short at line ${nextOffset + 1} of ${totalLines} (limit window reached line ${windowEnd} of ${totalLines}); call read_file again with offset=${nextOffset} for the rest.`;
}

/**
 * The no-`limit` path — read from `offset` toward EOF, body hard-stopping
 * at `MAX_READ_CODE_POINTS` code points / `MAX_READ_UTF16_UNITS` UTF-16
 * units (first hit wins). If EOF is not reached the body tail carries a
 * continuation hint (with the next offset). **No** fallback to any default
 * line count (the old default 200/2000 is explicitly rejected).
 *
 * When a single line exceeds the budget itself, the body carries an inline
 * truncation marker: offset pages by line, so the rest of that line has no
 * reachable path — not saying so would be silent data loss (ADR-0006).
 */
function readToEnd(text: string, offset: number): string {
  if (text.length === 0) return EMPTY_FILE_MARKER;
  const lines = splitNumberedLines(text);
  assertOffsetInRange(offset, lines.length);
  const page = collectPage(lines, offset, lines.length);
  if (page.nextIndex >= lines.length) return page.body;
  return `${page.body}\n${continuationHint(page.nextIndex, lines.length)}`;
}

interface Page {
  readonly body: string;
  readonly nextIndex: number;
}

/**
 * Accumulate line by line until the page budget (or the `endIndex` window
 * bound — first hit wins). Returns **whole-line** body and the index of the
 * next unread line — non-final cuts drop whole lines only, so the model
 * never receives half a line and assumes it's complete.
 *
 * When a single line exceeds the budget itself (1MB one-line file / long
 * astral lines), at least one truncated line + explicit marker is emitted
 * and the index advances by one, guaranteeing the continuation hint's
 * offset strictly grows (otherwise the model would spin on the same offset).
 */
function collectPage(
  lines: ReadonlyArray<string>,
  offset: number,
  endIndex: number
): Page {
  const rendered: string[] = [];
  let codePoints = 0;
  let units = 0;
  let index = offset;
  for (; index < endIndex; index += 1) {
    const line = renderLine(index + 1, lines[index]!);
    const cost = pageCost(line, rendered.length > 0);
    if (
      codePoints + cost.codePoints > MAX_READ_CODE_POINTS ||
      units + cost.units > MAX_READ_UTF16_UNITS
    ) {
      break;
    }
    rendered.push(line);
    codePoints += cost.codePoints;
    units += cost.units;
  }
  if (rendered.length > 0) {
    return { body: rendered.join("\n"), nextIndex: index };
  }
  return {
    body: truncateLine(lines[offset]!, offset),
    nextIndex: offset + 1,
  };
}

/** A line's page-budget cost (including the newline separator before it). */
function pageCost(
  line: string,
  hasPrecedingLine: boolean
): { readonly codePoints: number; readonly units: number } {
  const separator = hasPrecedingLine ? 1 : 0;
  return {
    codePoints: countCodePoints(line) + separator,
    units: line.length + separator,
  };
}

/**
 * Fallback rendering when one line exceeds the budget: line number + line
 * text cut to the remaining budget + **explicit truncation marker**. The
 * marker says two things: this line was truncated; the remainder is outside
 * offset-paging's reachable surface (offset counts lines, there is no
 * intra-line parameter) — so the model switches to a narrower read (e.g.
 * bash `cut` / `sed -n` intra-line slicing) instead of uselessly continuing.
 */
function truncateLine(line: string, offset: number): string {
  const prefix = `${String(offset + 1).padStart(6)}\t`;
  const marker = truncationMarker(prefix);
  return prefix + sliceWithinBudget(line, prefix + marker) + marker;
}

/** Truncation marker text (part of the body, counted in the page budget). */
function truncationMarker(prefix: string): string {
  const lineNumber = Number.parseInt(prefix, 10);
  return ` …[read_file] line ${lineNumber} truncated at the page budget; the rest of this line is not reachable via offset paging (offset counts lines).`;
}

/**
 * On top of the budget already taken by prefix+marker, take the longest
 * prefix of the line text that satisfies **both** the code-point and
 * UTF-16-unit caps — accumulate per code point, first hit wins (an astral
 * code point takes two units, so the two measures cannot convert into
 * each other).
 */
function sliceWithinBudget(line: string, reserved: string): string {
  const maxCodePoints = MAX_READ_CODE_POINTS - countCodePoints(reserved);
  const maxUnits = MAX_READ_UTF16_UNITS - reserved.length;
  const kept: string[] = [];
  let codePoints = 0;
  let units = 0;
  for (const ch of line) {
    const chUnits = ch.length;
    if (codePoints + 1 > maxCodePoints || units + chUnits > maxUnits) {
      break;
    }
    kept.push(ch);
    codePoints += 1;
    units += chUnits;
  }
  return kept.join("");
}

/** Continuation hint line (outside the body; its length is covered by the page budget's headroom). */
function continuationHint(nextOffset: number, totalLines: number): string {
  return `[read_file] continued at line ${nextOffset + 1} of ${totalLines}; call read_file again with offset=${nextOffset} for the rest.`;
}

/** Code-point count (a surrogate pair counts as one) — same measure as the executor's truncation gate. */
function countCodePoints(text: string): number {
  return Array.from(text).length;
}
