/**
 * read_file 工具（T5）— 纯无状态文件精读（#141 工具层重写）。
 *
 * 契约（ADR-0004 L14 + T1-5/T1-7 裁定）：
 *   - 输入: path (必填), offset? (默认 0, 0 基), limit? (默认 200, 上限 2000)
 *   - resolve+realpath 限定于 root 之内（symlink 越界拒绝）
 *   - 必须为文件（目录报错）；>1MB 拒绝并引导 grep+offset/limit 精读
 *   - NUL 字节 (0x00) 检测：拒绝二进制文件
 *   - 输出: 纯字符串 `${lineNo.padStart(6)}\t${line}`，行号 1 起（offset 后第一行 = offset+1）
 *   - 错误一律 throw ToolExecutionError（executor 转 execution_failed）
 *   - 工厂闭包仅持有 root，handler 无跨调用状态
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { ToolExecutionError } from "../../errors.js";
import { isTaskWorktreePath } from "../../isolation/worktree-gate.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import type { AciToolDef } from "../types.js";
import { resolveWithinRoot } from "./helpers.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const MAX_FILE_BYTES = 1_048_576; // 1 MiB

/**
 * Snapshot the live root at handler invocation time. Accepts either a
 * literal path (legacy / forward-compat shape — tests and other one-shot
 * callers pass `string`) or a `LiveTaskRoot` cell (T6: registry threads
 * the cell so that `worktree rebind` in the same run reaches this
 * handler). The returned `string` is the snapshot value — D2 forbids
 * reading the cell more than once per handler call, so callers must
 * reuse the snapshot for both resolve and any other root-relative work.
 */
function readRoot(root: string | LiveTaskRoot): string {
  return typeof root === "string" ? root : root.read();
}

export interface CreateReadFileToolOptions {
  /** ADR-0019 (T4): per-root state anchor. When provided, `<workspaceRoot>/.iknow`
   *  is added to the read-allowed roots so the agent can read its own per-root
   *  state at parity with the home profile. The protected-path check in
   *  fs-policy (still gating `<workspaceRoot>/.iknow/...` writes from the
   *  bash fence) keeps the write side locked down; read_file's seam only
   *  widens the read scope. Defaults to `root` (cwd) — the
   *  legacy shape — to preserve the existing read-file-profile.test.ts
   *  contract when workspaceRoot is not threaded. */
  readonly workspaceRoot?: string;
  /** ADR-0037 §1 (T6 D10 wired): identity-root read passthrough. After a
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
}

/** `~/.iknow/` — the agent's own profile directory (readUserProfile in the
 *  assembly layer already reads `user.md` from here every turn). */
function iknowProfileRoot(): string {
  return join(homedir(), ".iknow");
}

/**
 * Compute the per-call extraReadRoots anchored to the same wave snapshot as
 * `rootAtCall`. Both inputs are passed by the caller so the conditional
 * check uses the LIVE root (D9) — not a factory-time closure.
 *
 * Read-only reachability surface:
 *   - `~/.iknow/` (home profile — always)
 *   - `<workspaceRoot>/.iknow` (per-root persona state) when threaded and
 *     distinct from the live root
 *   - `<projectIdentityRoot>` (ADR-0037 §1 identity-root passthrough) when
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
  // T6 (plans/worktree-live-task-root.md §6 T6): `root` may be a
  // `LiveTaskRoot` cell. The handler snapshots the cell at call time and
  // rebuilds `extraReadRoots` against that snapshot, so root + extras share
  // a single wave vintage (D9) — no "root is new, extras are old"
  // mid-stream mix. Legacy `string` callers keep byte-identical behavior.
  //
  // ADR-0019 (T4): when workspaceRoot is threaded, `<workspaceRoot>/.iknow`
  // is added as a second read root so the agent's per-root persona state
  // reaches the same surface as the global home profile. The contract is
  // reachability-only: extraReadRoots grants traversal through
  // `resolveWithinRoot`, while protected-path enforcement (the fs-policy
  // `isSensitive` set) is the separate fence that turns `.iknow` state
  // files into `execution_failed` when touched from the bash channel. Read
  // and protection are independent and intentionally so — see plan T4.
  //
  // ADR-0037 §1 (T6 D10 wired): projectIdentityRoot threads the read-only
  // identity-root passthrough so rebind doesn't strand AGENTS.md /
  // permissions.toml / project rules.
  return Object.freeze({
    name: "read_file",
    description:
      "Read a slice of a UTF-8 text file starting at a 0-based offset (default window 200, hard cap 2000); pair with grep to locate the region in large files and with glob to discover candidate paths first. Returns each line as a 1-based line number right-padded to 6 chars, a tab, then the line text; stateless — each call must supply offset to continue. Files >1MB are out of scope (locate with grep and read precisely with offset/limit); binary files (NUL byte) are out of scope.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: {
          type: "integer",
          minimum: 1,
          default: DEFAULT_LIMIT,
          maximum: MAX_LIMIT,
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
    handler: async (input: unknown) => {
      const params = parseInput(input);
      // T6 D9: same wave snapshot — root and extras share the snapshot.
      const rootAtCall = readRoot(root);
      const projectIdentityRoot = resolveProjectIdentityRoot(rootAtCall, opts);
      const extraReadRoots = computeExtraReadRoots(
        rootAtCall,
        opts?.workspaceRoot,
        projectIdentityRoot
      );
      const resolved = await resolveReadTarget(
        rootAtCall,
        params.path,
        extraReadRoots,
        projectIdentityRoot
      );
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
      return sliceLines(text, params.offset, params.limit);
    },
  });
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
 */
async function resolveReadTarget(
  root: string,
  target: string,
  extraReadRoots: readonly string[],
  projectIdentityRoot: string | undefined
): Promise<string> {
  const primary = await resolveWithinRoot(root, target, extraReadRoots);
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
  readonly limit: number;
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
  const limit =
    raw.limit === undefined
      ? DEFAULT_LIMIT
      : requirePositiveInteger(raw.limit, "limit");
  return {
    path: raw.path,
    offset,
    limit: Math.min(limit, MAX_LIMIT),
  };
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

function sliceLines(text: string, offset: number, limit: number): string {
  if (text.length === 0) return "[read_file] ok (empty file)";
  const lines = text.split("\n");
  // Drop trailing empty element produced by a trailing newline so the
  // "last line" displayed matches the file's last newline position.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (offset >= lines.length) {
    throw new ToolExecutionError(
      `[read_file] offset ${offset} past end of file (${lines.length} lines); use a smaller offset`
    );
  }
  const window = lines.slice(offset, offset + limit);
  return window
    .map((line, idx) => `${String(offset + idx + 1).padStart(6)}\t${line}`)
    .join("\n");
}
