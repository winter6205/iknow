/**
 * ACI Layer 1: write_file — create or replace a complete file.
 *
 * The target is resolved through the shared workspace containment helper before
 * any filesystem mutation. Whole-file content is written verbatim — the
 * patch-level poka-yoke linter is only applied by edit_file, not here, so
 * legitimately-balanced content containing `{`, `]`, or unclosed quotes inside
 * comments/strings is accepted.
 */

import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { ToolExecutionError } from "../../errors.js";
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import {
  asToolExecutionError,
  FENCE_WRITE_GUIDANCE,
  isWithinRoot,
  resolveWithinRoot,
} from "./helpers.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import { resolveSessionFenceTmp } from "../../sandbox/fence-tmp.js";
import type { LastReadLedgerHost } from "../last-read-ledger.js";
import {
  capturePreimageBeforeWrite,
  type PreimageCallIds,
  type PreimageCapture,
  type PreimageOpts,
} from "../preimage-port.js";

/**
 * ADR-0084 — typed rejection from the last-read gate (a criterion the model
 * can read, not just wording).
 *
 * Same shape as `ReadonlyViolationError` (bash-readonly.ts): extends
 * `ToolExecutionError`; the executor's `sanitizeFailure` reads only
 * `.message`, so the model-facing receipt is byte-unchanged.
 *
 * `kind` / `path` are a **test / host seam**, not in the executor's read
 * surface: discriminating "this is a write-gate refusal" from other write
 * failures relies on `instanceof LastReadRequiredError` (tests) or the
 * message text. Extra fields never change what the model sees.
 *
 * The message embeds the **canonical absolute path**, unlike the success
 * receipt's `displayPath` (root-relative) — a deliberate exception: after a
 * refusal the model feeds this path back into `read_file` to unlock, and
 * under worktree rebind / multi-root subagents a relative path could point
 * at the wrong tree; the success receipt is just a short human-facing form
 * without that risk.
 */
export class LastReadRequiredError extends ToolExecutionError {
  readonly kind = "last_read_required" as const;
  readonly path: string;
  constructor(path: string) {
    super(
      `[write_file] refusing to overwrite a non-empty file that was not read in this conversation: ${path} — call read_file on it first (or delete the file if the overwrite is intended).`
    );
    this.path = path;
  }
}

export interface WriteFileOpts {
  /** Explicit host pad (tests / supervised worker pad). */
  readonly tmpDir?: string;
  /** Session project dir; with `ctx.conversationId` → main-session pad. */
  readonly projectDir?: string;
  /**
   * ADR-0084 last-read ledger host. Present → an existing non-empty target
   * must already be on this conversation's ledger, else typed refuse with no
   * bytes written. Absent → legacy caller (demo / direct factory tests) keeps
   * the pre-ledger behavior; the gate is a registry-level wiring decision.
   */
  readonly lastReadLedger?: LastReadLedgerHost;
  /**
   * Pre-write capture seam (ADR-0036). Present → fired with the current and
   * incoming bytes just before the write; a throw aborts the write. Absent →
   * legacy caller / direct factory test keeps the plain write.
   */
  readonly preimageCapture?: PreimageCapture;
  /** Project identity root the captured `relPath` is meaningful under;
   *  defaults to the live task root the write resolved against. */
  readonly rootIdentity?: string;
}

const TOOL_NAME = "write_file";
const ALLOWED_KEYS = new Set(["path", "content", "create_directories"]);

interface WriteFileInput {
  readonly path: string;
  readonly content: string;
  readonly createDirectories: boolean;
}

function parseInput(input: unknown): WriteFileInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolExecutionError(
      "[write_file] input must be an object with path and content"
    );
  }

  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ToolExecutionError(`[write_file] unknown field: ${key}`);
    }
  }
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    throw new ToolExecutionError(
      "[write_file] path must be a non-empty string"
    );
  }
  if (typeof raw.content !== "string") {
    throw new ToolExecutionError("[write_file] content must be a string");
  }
  if (
    raw.create_directories !== undefined &&
    typeof raw.create_directories !== "boolean"
  ) {
    throw new ToolExecutionError(
      "[write_file] create_directories must be a boolean"
    );
  }

  return {
    path: raw.path,
    content: raw.content,
    createDirectories: raw.create_directories ?? true,
  };
}

function displayPath(root: string, target: string): string {
  const path = relative(resolve(root), target);
  return path === "" ? "." : path;
}

/**
 * Path convention of the success receipt (session scratch path space).
 *
 * Delivery writes (target under taskRoot) keep the existing taskRoot-relative
 * short form, byte-for-byte. When writing into the session tmp pad (outside
 * taskRoot), displayPath would produce a `../` chain that the model copies
 * back into read_file/edit_file pointing at the wrong path → use the
 * canonical absolute host path (= the `resolveWithinRoot` return value
 * itself, same convention as the absolute path embedded in last-read
 * refusals). Pad comparison uses realpath, matching resolveWithinRoot's
 * internal containment which realpaths sessionTmpRoot first; if realpath
 * fails (abnormal pad state) → fall back to the existing relative form
 * rather than create a new failure surface in the receipt path.
 */
async function receiptDisplayPath(
  root: string,
  pad: string | undefined,
  target: string
): Promise<string> {
  if (!isWithinRoot(resolve(root), target) && pad !== undefined) {
    try {
      if (isWithinRoot(await realpath(resolve(pad)), target)) return target;
    } catch {
      // EXIT: pad not realpath-able (unknown state) → keep the receipt shape.
    }
  }
  return displayPath(root, target);
}

/**
 * Snapshot the live root at handler invocation time. Accepts either a literal
 * path (legacy / forward-compat shape — tests and other one-shot callers pass
 * `string`) or a `LiveTaskRoot` cell (the registry threads the cell so that
 * `worktree rebind` in the same run reaches this handler). The returned
 * `string` is the snapshot value — reading the cell more than once per
 * handler call is forbidden, so callers must reuse the snapshot for both
 * resolve and write.
 */
function readRoot(root: string | LiveTaskRoot): string {
  return typeof root === "string" ? root : root.read();
}

/**
 * Create or wholly overwrite a file below `root`.
 *
 * `create_directories` defaults to true and only controls parent-directory
 * creation; it never changes the whole-file replacement semantics.
 *
 * `root` may be a `LiveTaskRoot` cell; the handler reads the snapshot at
 * call time, so a `worktree rebind` in the same run lands new writes in the
 * rebound tree. `string` callers (legacy tests, one-shot consumers) keep
 * byte-identical behavior.
 */
export function createWriteFileTool(
  root: string | LiveTaskRoot,
  opts?: WriteFileOpts
): AciToolDef {
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<unknown> => {
    const params = parseInput(input);
    // Per-call snapshot: resolve and the write must share one root value.
    const rootAtCall = readRoot(root);
    const sessionTmpRoot = resolveSessionFenceTmp({
      tmpDir: opts?.tmpDir,
      projectDir: opts?.projectDir,
      conversationId: ctx?.conversationId,
    });

    let target: string;
    try {
      target = await resolveWithinRoot(rootAtCall, params.path, {
        sessionTmpRoot,
      });
    } catch (error) {
      throw asToolExecutionError("[write_file] cannot resolve path", error);
    }

    const parent = dirname(target);
    if (params.createDirectories) {
      try {
        await mkdir(parent, { recursive: true });
      } catch (error) {
        throw asToolExecutionError(
          `[write_file] cannot create parent directory ${parent}`,
          error
        );
      }
    } else {
      let parentInfo: Awaited<ReturnType<typeof stat>>;
      try {
        parentInfo = await stat(parent);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          throw new ToolExecutionError(
            `[write_file] parent directory does not exist: ${parent}`
          );
        }
        throw asToolExecutionError(
          `[write_file] cannot inspect parent directory ${parent}`,
          error
        );
      }
      if (!parentInfo.isDirectory()) {
        throw new ToolExecutionError(
          `[write_file] parent path is not a directory: ${parent}`
        );
      }
    }

    // Side channel for diffs: read the old content before writing; missing
    // file → empty string. A read failure never blocks the write (the write
    // is the main path); it only degrades oldContent to empty, keeping the
    // existing rejection semantics (missing parent / symlink escape)
    // untouched — containment has already passed at this point.
    let oldContent = "";
    try {
      oldContent = await readFile(target, "utf8");
    } catch {
      oldContent = "";
    }

    // ADR-0084 last-read gate: target exists with size>0 and is absent from
    // this conversation's ledger → typed refusal, nothing written. New files
    // and empty files are exempt (only non-empty writes consult the table).
    // The criterion uses stat's byte size, not oldContent — a failed
    // oldContent read degrades best-effort to empty, and judging "empty" by
    // it would wrongly pass an unreadable non-empty file.
    await assertLastRead(opts, ctx, target);

    return commitWrite(target, params, {
      rootAtCall,
      oldContent,
      sessionTmpRoot,
      preimageOpts: opts,
      callCtx: ctx,
    });
  };

  return Object.freeze({
    name: TOOL_NAME,
    description:
      "Create a new file, or fully overwrite an existing one after read_file has shown its current contents in this conversation; prefer edit_file for surgical changes to an existing file. Overwriting a non-empty existing file requires a prior successful read_file (or a single-file read-only bash such as `cat path`) in the same conversation — an empty or brand-new file needs no prior read. Writes verbatim UTF-8 (no template processing); parent directories auto-created unless create_directories=false. Writes outside the workspace root are out of scope. " +
      FENCE_WRITE_GUIDANCE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        create_directories: { type: "boolean", default: true },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "write" as const,
      isConcurrencySafe: false,
      interruptBehavior: "block" as const,
      timeoutTier: "default" as const,
    },
  });
}

/**
 * ADR-0084 — the write tail: write the file, assemble the receipt. Extracted
 * only to keep the handler's decision chain as short as it was before the
 * gate was introduced (S5 ratchet); order and receipt wording are unchanged
 * (for the pad-write path convention see receiptDisplayPath).
 */
async function commitWrite(
  target: string,
  params: WriteFileInput,
  ctx: {
    readonly rootAtCall: string;
    readonly oldContent: string;
    readonly sessionTmpRoot: string | undefined;
    readonly preimageOpts: PreimageOpts | undefined;
    readonly callCtx: PreimageCallIds | undefined;
  }
): Promise<unknown> {
  await capturePreimageBeforeWrite(ctx.preimageOpts, ctx.callCtx, {
    rootAtCall: ctx.rootAtCall,
    absPath: target,
    preBytes: ctx.oldContent,
    postBytes: params.content,
  });
  try {
    await writeFile(target, params.content, "utf8");
  } catch (error) {
    throw asToolExecutionError(`[write_file] cannot write ${target}`, error);
  }
  const pathForMessage = await receiptDisplayPath(
    ctx.rootAtCall,
    ctx.sessionTmpRoot,
    target
  );
  return {
    output: `[write_file] wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${pathForMessage}`,
    meta: { oldContent: ctx.oldContent, newContent: params.content },
  };
}

/**
 * ADR-0084 — the last-read gate. `target` is already the canonical absolute
 * path past containment, used directly as the ledger key (same source as
 * read_file / whitelisted bash reads: one `resolveWithinRoot` output).
 *
 * Four EXITs:
 *   - **host absent** (factory without a ledger: demo / direct-factory
 *     tests) → no table lookup, behavior byte-identical to pre-ADR-0084.
 *     Whether the gate is on is a registry-assembly decision, not the
 *     factory's.
 *   - host present but conversationId absent → any existing size>0 target
 *     is refused (fail-closed: non-empty overwrite without an id is
 *     rejected; no implicit process-wide global table).
 *   - target missing / size==0 → exempt, allowed.
 *   - ledger has the path → allowed.
 *
 * stat failures (EACCES / ELOOP etc.) → non-blocking: refuse only when the
 * target is known to exist and be non-empty; unknown states fall back to
 * the existing write-path errors instead of gaining a new refusal surface
 * here.
 */
async function assertLastRead(
  opts: WriteFileOpts | undefined,
  ctx: ToolExecutionContext | undefined,
  target: string
): Promise<void> {
  // EXIT: host absent (factory without a ledger: demo / direct-factory
  // tests) → the gate is entirely off. This is different from "host present
  // but conversationId absent", which fails closed.
  const host = opts?.lastReadLedger;
  if (host === undefined) return;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target);
  } catch {
    // EXIT: stat failure (EACCES / ELOOP etc.) → unknown states create no
    // new refusal surface here; fall back to existing write-path errors.
    return;
  }
  // EXIT: new / non-regular / empty file (size==0) → exempt (only non-empty writes consult the table).
  if (!info.isFile() || info.size === 0) return;
  // EXIT: ledger has the path (already read in this conversation) → allow.
  if (host.ledgerFor(ctx?.conversationId)?.has(target)) return;
  // EXIT: exists, non-empty, absent from the ledger → typed last_read_required.
  // The model only sees `.message` (the executor returns just the message);
  // `kind` serves tests / host via `instanceof`, never a model-side criterion.
  throw new LastReadRequiredError(target);
}
