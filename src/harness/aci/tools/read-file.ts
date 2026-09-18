/**
 * read_file 工具（T5）— 纯无状态文件精读（#141 工具层重写）。
 *
 * 契约（ADR-0084 / D1c，**Amends** ADR-0004 L14 的「默认 200 行」）：
 *   - 输入: path (必填), offset? (默认 0, 0 基), limit? (**可选**)
 *   - **不写 `limit` = 从 offset 尽量读到 EOF**：正文整读页硬停 16000 code
 *     point，未到 EOF 时正文尾部附续读提示（含下次 offset）。不再有
 *     「默认 200 行」这回事（spec SC13）。
 *   - 写 `limit` = 仍切行窗，硬顶 2000 行（沿用既有 clamp）；同一对页预算
 *     也约束行窗，预算先触时正文尾部附续读提示（行窗语义不变）。
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
import type { ToolExecutionContext } from "../../tools/types.js";
import type { LastReadLedgerHost } from "../last-read-ledger.js";
import { resolveSessionFenceTmp } from "../../sandbox/fence-tmp.js";
import { resolveWithinRoot } from "./helpers.js";

/** 显式 `limit` 的硬顶（行窗）；不写 `limit` 时改走 `MAX_READ_CODE_POINTS`。 */
const MAX_LIMIT = 2000;
const MAX_FILE_BYTES = 1_048_576; // 1 MiB
/**
 * 页正文硬停（code point，不含续读提示行）。两条正文路径（不写 `limit` 的
 * 整读、显式 `limit` 的行窗）共用。executor 的 20000 字符总闸（ADR-0006）
 * 不动 —— 本常量是工具层的精度闸，让「换更小 offset 续读」这条恢复路径在
 * 截断前就成立。
 */
const MAX_READ_CODE_POINTS = 16_000;
/**
 * 页的 UTF-16 单元硬停。executor 的 20000 闸按 `String.length`（UTF-16
 * 单元）计量，而 astral 字符一个 code point 占两个单元 —— 只按 code point
 * 计量会产出 ~32000 单元的页，被 executor 二次截断（ADR-0006 Decision 4 禁止
 * 的双重截断）。19000 给续读提示 / 截断标记留 headroom，两个预算同时约束、
 * 先触者停。
 */
const MAX_READ_UTF16_UNITS = 19_000;

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
   * ADR-0092 会话 tmp 身份（与 WriteFileOpts.tmpDir 同语义）：显式宿主垫底
   * （测试 / T3 worker pad）。在场 → 该垫底成为 read_file 的独立 containment
   * 读根，不再依赖 `~/.iknow` extraReadRoots 碰巧放行；缺席 → 无额外读根。
   */
  readonly tmpDir?: string;
  /** 会话 project dir；与 `ctx.conversationId` 同现 → `<sessionFolder>/fence-tmp` 垫底。 */
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
  // `resolveWithinRoot`. Write enforcement (the bash channel's `.iknow`
  // state files becoming `execution_failed`) is the permission chain +
  // bwrap hard-wall (ADR-0092 global mode binds the host root, system
  // prefixes read-only; cwd writes are gated by the validator +
  // `--ro-bind cwd` EROFS). Read and protection are independent and
  // intentionally so — see plan T4.
  //
  // ADR-0037 §1 (T6 D10 wired): projectIdentityRoot threads the read-only
  // identity-root passthrough so rebind doesn't strand AGENTS.md /
  // permissions.toml / project rules.
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
      // T6 D9: same wave snapshot — root and extras share the snapshot.
      const rootAtCall = readRoot(root);
      const projectIdentityRoot = resolveProjectIdentityRoot(rootAtCall, opts);
      const extraReadRoots = computeExtraReadRoots(
        rootAtCall,
        opts?.workspaceRoot,
        projectIdentityRoot
      );
      // ADR-0092: same identity as the write tools' tmpWriteRoot — the
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
 * ADR-0084 / D1c 的读尾段：选正文口径（整读到 EOF vs 显式行窗）、入账。
 *
 * 顺序是契约的一部分 —— **先**构造正文（offset 越界等失败路径在这里
 * throw），**后**入账。反过来会把「没读到」记成「读过了」，随后 write_file
 * 的非空覆写闸就被这次失败读放行。
 *
 * 入账口径 = `resolved`（`resolveWithinRoot` 的解析结果），与 write_file 侧的
 * `target` 同源（同一个 resolve 输出），两边才可能命中同一条。
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
 * `resolveWithinRoot` options as the write tools' `tmpWriteRoot` — one
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
    tmpWriteRoot: roots.sessionTmpRoot,
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
   * 显式行窗；**不写 `limit` → `undefined`**（区别于旧契约的默认 200）。
   * handler 据此分派「行窗」与「整读到 EOF / 16000 cp」两条路径（D1c）。
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
  // 不写 limit → undefined（整读路径）；写了才 clamp 到 2000 行。
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
 * 显式 `limit` 路径 —— 行窗，语义与 ADR-0004 时期一致：窗口 = 从 `offset`
 * 起至多 `limit` 行（硬顶 2000，由 parseInput clamp）。
 *
 * 窗口之上叠**与整读路径同一对页预算**（16000 code point / 19000 UTF-16
 * 单元）：`limit: 2000` 在宽行文件上可产出 ~816000 单元的页，正好落进
 * ADR-0006 Decision 4 禁止的双重截断 —— 工具层先给足、executor 再砍尾，
 * 模型拿到无解释的半页。预算先触时窗口提前收尾并发**显式**续读标记；
 * 窗口自己先到顶（行数约束）则正文与旧契约逐字节一致，无标记。
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
 * 预算（非 `limit` 行数）切短行窗时的续读标记。与整读路径的
 * `continuationHint` 分开：这里必须说清「窗口没读完是页预算造成的」，
 * 否则模型会把短页误当 `limit` 已满足，不再续读。
 *
 * 恢复路径是**下一次调用加大 `offset`**（行窗语义不变，`limit` 可原样带
 * 上）——提示里的 offset 必须是下一次调用接受的合法值。
 */
function windowCutHint(
  nextOffset: number,
  windowEnd: number,
  totalLines: number
): string {
  return `[read_file] page budget cut this window short at line ${nextOffset + 1} of ${totalLines} (limit window reached line ${windowEnd} of ${totalLines}); call read_file again with offset=${nextOffset} for the rest.`;
}

/**
 * 不写 `limit` 路径（D1c）—— 从 `offset` 尽量读到 EOF，正文硬停
 * `MAX_READ_CODE_POINTS` code point / `MAX_READ_UTF16_UNITS` UTF-16 单元
 * （先触者停）。未到 EOF 时正文尾部附续读提示（含下次 offset）。**不**回落
 * 到任何默认行数（spec SC13 明确否决默认 200/2000）。
 *
 * 单行自身超预算时正文里附带截断标记：offset 按行翻页，行内余下部分没有
 * 可达路径 —— 不说清就是静默数据丢失（ADR-0006 Decision 4）。
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
 * 逐行累加到页预算为止（或到 `endIndex` 行窗上界为止，先触者停）。返回
 * **整行**正文与下一条待读行下标 —— 非末行只截整行，模型不会拿到半行
 * 内容后误以为完整。
 *
 * 单行自身超预算（1MB 单行文件 / astral 长行）时至少发一条截断行 + 显式
 * 标记，并前进一行，保证续读提示里的 offset 严格增长（否则模型会在同一
 * offset 上打转）。
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

/** 一行的页预算开销（含与前一行之间的换行符）。 */
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
 * 单行超预算时的兜底渲染：行号 + 截到剩余预算的行文 + **显式截断标记**。
 * 标记说明两件事：这一行被截断了；余下部分不在 offset 翻页的可达面上
 * （offset 按行计，行内偏移没有入参）—— 模型据此改用更小的读法（如 bash
 * 的 `cut`/`sed -n` 行内切片）而不是徒劳地续读。
 */
function truncateLine(line: string, offset: number): string {
  const prefix = `${String(offset + 1).padStart(6)}\t`;
  const marker = truncationMarker(prefix);
  return prefix + sliceWithinBudget(line, prefix + marker) + marker;
}

/** 截断标记文案（正文的一部分，计入页预算）。 */
function truncationMarker(prefix: string): string {
  const lineNumber = Number.parseInt(prefix, 10);
  return ` …[read_file] line ${lineNumber} truncated at the page budget; the rest of this line is not reachable via offset paging (offset counts lines).`;
}

/**
 * 在 prefix+marker 已占用的预算之上，取行文的最长前缀，**同时**满足
 * code point 与 UTF-16 单元两个上限 —— 逐 code point 累加，先触者停
 * （astral 字符一个 code point 占两个单元，两个度量不能互相换算）。
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

/** 续读提示行（正文之外；其长度已由页预算的 headroom 覆盖）。 */
function continuationHint(nextOffset: number, totalLines: number): string {
  return `[read_file] continued at line ${nextOffset + 1} of ${totalLines}; call read_file again with offset=${nextOffset} for the rest.`;
}

/** code point 计数（surrogate pair 算一个）—— 与 executor 截断口径一致。 */
function countCodePoints(text: string): number {
  return Array.from(text).length;
}
