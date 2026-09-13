/**
 * grep 工具 — 搜面契约（specs/aci-file-search-surface.md D2–D7 / SC4–SC10）。
 *
 * 行为概要：
 *   - 出法（D2）：`paths`（默认，唯一相对路径）/ `content`（`path:line:text`）/
 *     `count`（`path:条数` + 全库 `total:`）。
 *   - 分页（D3）：`offset` + `head_limit`（默认 50、硬顶 2000）切**已排序**
 *     名单；排序（path 再行号）发生在切片之前。偏移越过最后一条且本次有命中
 *     → 精确回执 `No entries at this offset`；无匹配 → 空串。
 *   - 收窄（D4）：`path`（目录）/ `glob`（文件名模式）/ `type`（语言，二者并列）。
 *     未知 `type` 与坏正则是**两种** typed 错误（SC10）。
 *   - 行窗（D5）：`also` + `within_lines`（默认 5）是**过滤**，只在窗内找第二段。
 *   - 引擎（D6 / ADR-0089）：有 rg 时匹配只出 rg（不再 JS 再滤）；起不来
 *     （不存在 / ENOENT / 不可执行）→ Node 遍历 + JS `RegExp` 编得过的
 *     pattern，调用仍成功。命中集不必与 rg 一致 —— Node 不模仿 rg 的
 *     默认引擎拒绝集。**不** 回落到 PATH 上的 `rg`。
 *
 * 复杂度（SC12）：flag 解析 / argv / 行解析 / 行窗 / 组构造 / 排序 / 分页 /
 * 投影各自独立成模块，本文件只做装配与引擎分派。
 */

import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { isTaskWorktreePath } from "../../isolation/worktree-gate.js";
import { resolveInstallRoot, type LiveTaskRoot } from "../../session-roots.js";
import { resolveWithinRoot } from "./helpers.js";
import { compilePattern } from "../search/pattern.js";
import { parseQuerySpec, rejectRetiredLimitField } from "../search/options.js";
import { engineSpecFor, renderResult } from "../search/pipeline.js";
import { readWorkspaceLines } from "../search/file-lines.js";
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

/** 依赖注入：覆盖点（默认 = 生产值）。 */
export interface GrepToolDeps {
  /** 替换引擎 spawn（最常见用法：模拟安装根二进制缺失以驱动 Node 降级路径）。 */
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
   * 覆盖钉死二进制路径。缺席 → `<resolveInstallRoot()>/vendor/ripgrep/...`。
   * 测试可指向不存在的路径来驱动「安装根二进制不存在」这一 D6 分支。
   */
  readonly engineBinaryPath?: string;
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
    // T6 D2: per-handler batch snapshot —— root 在入口读一次冻结，贯穿整条
    // 路径（compileInput → rg / Node 扫）。handler 内后续 cell 翻转不渗透
    // 进本次调用。cell 缺席 → 退到工厂捕获 root（legacy parity）。
    rejectRetiredLimitField(input);
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
    // 取样 spec：`also` 在场时改取内容行（行窗要行号才能判）。
    const sampleSpec = engineSpecFor(compiled.spec);
    // 主 pattern 的编译**只在 Node 降级路径里**触发（ADR-0089）：有 rg 时
    // 匹配只出 rg，rg 自身的 pattern 错误由 rg 子进程（rc=2）报；rg 起不来
    // 时 Node 遍历 + `RegExp` 出结果，调用仍成功。共享入口不预判 rg 路径的
    // pattern 合法性 —— rg 接受而 JS 拒绝的构造（PCRE2 命名组 `(?P<n>abc)`、
    // inline flag `(?i)abc` 等）必须能走通 rg 路径。
    const explicitFileRel = await explicitFileRelative(compiled);
    const readLines = (path: string) =>
      readWorkspaceLines(compiled.workspaceRoot, path, {
        allowOversize: path === explicitFileRel,
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

/** 模型可见文案（D7）：schema 与描述提为模块常量，工厂保持短小。 */
export const GREP_DESCRIPTION = `Search file contents under a workspace directory using a regular expression; use it to discover which files carry a pattern before reading them, and pair it with read_file once you have a pinpointed path. Returns relative paths by default (output=paths) — set output=\"content\" for path:line:text or output=\"count\" for per-file counts plus a total:. Narrow with glob / type, show nearby lines with context, or keep only hits whose second literal also appears within within_lines of the match. Page a sorted result list with offset + head_limit (default 50, hard cap ${String(2000)}); an offset past the last entry returns "No entries at this offset". Runs on a bundled search engine (ripgrep ${RIPGREP_VERSION}) resolved from the install root, and falls back to a built-in Node scan when that engine is unavailable — the Node fallback walks files and matches with JavaScript RegExp and may answer differently from ripgrep.`;

/**
 * 输入 schema（与 `options.ts` 的解析层是同一契约的两道防线）。
 *
 * 不开 `additionalProperties: false` —— SC10 / D4 承诺「退役字段 `limit` /
 * `grep_limit`」要给到模型一条 typed 指引（指向 `head_limit`），但 ajv 的
 * `additionalProperties` 泛化消息（`must NOT have additional properties`）
 * 会抢先于 handler 里的 `rejectRetiredLimitField` 命中，模型只看到前者。
 * 改为放行 extra，由 handler 第 107 行的 `rejectRetiredLimitField` 接住退役
 * 名（拒）；其它真正未知的字段由 `compileInput → parseQuerySpec` 静默忽略
 * （与 `additionalProperties:true` 同形，不变 schema 已知的必填与类型闸门）。
 */
export const GREP_INPUT_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    path: { type: "string" },
    output: {
      type: "string",
      enum: ["paths", "content", "count"],
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
 * 搜索根是文件时的 workspace 相对路径（与 `node-scan` 吐出的 relPath 同形）；
 * 目录 / 不存在的路径 → `undefined`（体积闸照常生效）。
 */
async function explicitFileRelative(
  compiled: CompiledInput
): Promise<string | undefined> {
  const info = await stat(compiled.searchRoot).catch(() => null);
  if (info === null || !info.isFile()) return undefined;
  return toWorkspaceRelative(compiled.workspaceRoot, compiled.searchRoot);
}

/**
 * 引擎分派（D6 / SC9 / ADR-0089）。
 *
 * 生产路径只 exec 安装根钉死二进制；rg 在场 → 直接用 rg 的命中（不再 JS
 * 再滤）。起不来 → Node 遍历 + JS `RegExp`（`compilePattern` 已编过的），
 * 调用仍成功。命中集允许两条路径不同（Node 不模仿 rg 的默认引擎拒绝集）。
 * 这里**没有** PATH `rg` 的分支 —— 那是契约明令禁止的凑合路径。
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

  // Node 降级路径（ADR-0089）：此处才编主 pattern —— rg 路径不预判合法性，
  // rg 接受而 JS 拒绝的构造（PCRE2 命名组 / inline flag 等）必须能走通 rg
  // 路径。Node 侧编不过 → typed 拒绝（文案点名 pattern，与未知 type 的失败
  // 域互不混同，SC10）。
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
