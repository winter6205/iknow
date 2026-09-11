/**
 * 自带引擎执行层（D6 / SC9；SC12「argv 构造」「行解析」）。
 *
 * 契约：生产 handler **只 exec 安装根钉死的那条路径**（`engine-manifest.ts`
 * 给出），不 `which rg`、不回落 PATH 上的 `rg`。PATH 里的 rg 是不是存在、
 * 是不是别的版本，都与此无关。
 *
 * 「自带起不来」的判定收在这里：spawn 抛 ENOENT / EACCES（或安装根没有该
 * 平台资产）→ 返回 `{ kind: "unavailable" }`，由 handler 转 Node 全语义扫。
 * 这是**唯一**的降级出口 —— 起不来不等于该调用失败。
 *
 * 本模块不排序、不分页、不投影：它只把 rg 的 stdout 变成与 Node 引擎同形的
 * 原始产物，两条引擎因此共用同一条流水线。
 */

import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { relative } from "node:path";

import { ToolExecutionError } from "../../errors.js";
import { spawnWithStopSignal } from "../../sandbox/runner.js";
import { buildRgArgs } from "./argv.js";
import { parseRgContextStdout } from "./context-groups.js";
import {
  MAX_MATCH_LINE_COLUMNS,
  parseRgNullCounts,
  parseRgNullLines,
  parseRgNullPaths,
  truncateMatchContent,
} from "./rg-output.js";
import type { ContextGroup, FileCount, LineHit, QuerySpec } from "./types.js";

/** 测试接缝：生产 = node:child_process.spawn；可注入以模拟缺失 / 固定 stdout。 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof nodeSpawn>[2]
) => ChildProcess;

/** 引擎产物：三种出法各自的原始形态（尚未排序 / 分页）。 */
export type EngineResult =
  | { readonly kind: "unavailable" }
  | { readonly kind: "lines"; readonly lines: ReadonlyArray<LineHit> }
  | { readonly kind: "paths"; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "counts"; readonly counts: ReadonlyArray<FileCount> }
  | { readonly kind: "context"; readonly groups: ReadonlyArray<ContextGroup> };

export interface RgEngineInput {
  readonly spec: QuerySpec;
  /** 钉死二进制的绝对路径；`undefined` = 该平台无资产 → 直接降级。 */
  readonly binaryPath: string | undefined;
  readonly searchRoot: string;
  readonly workspaceRoot: string;
  readonly signal: AbortSignal | undefined;
  readonly spawn: SpawnFn | undefined;
}

/**
 * 跑 rg。任何「起不来」都返回 `unavailable`（含平台无资产），
 * 其余失败照常 typed 抛出。
 */
export async function runRgEngine(input: RgEngineInput): Promise<EngineResult> {
  if (input.binaryPath === undefined) return { kind: "unavailable" };

  // cwd = **workspace 根**（不是 searchRoot）：rg 回显喂进去的路径、且
  // `--glob` 的锚定相对 cwd 判段 —— 两者都要求搜索路径相对 workspace 表达，
  // 才能与 Node 引擎（按 workspace 相对 path 判段、吐相对 path）同口径。
  const searchPath = toSearchPath(input.workspaceRoot, input.searchRoot);
  const args = buildRgArgs(input.spec, searchPath, MAX_MATCH_LINE_COLUMNS);
  const collected = await collect(input, args);
  if (collected === "unavailable") return { kind: "unavailable" };
  return interpret(collected, input);
}

type Collected =
  | "unavailable"
  | {
      readonly code: number | null;
      readonly stdout: string;
      readonly stderr: string;
    };

/** spawn 并把 stdout/stderr 收全；ENOENT / EACCES → `unavailable`。 */
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
    if (isUnavailable(error)) return "unavailable";
    throw error;
  }
}

/**
 * 测试接缝分支：与生产路径的 kill 语义刻意不同（只够 ENOENT 模拟与
 * 固定 stdout 的解析覆盖）。需要完整 abort/kill 覆盖的用例走生产路径。
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
 * 搜索根 → rg 的路径参数（相对 workspace 根，posix 分隔符）。
 *
 * identity root 在 workspace 之外（ADR-0037 改绑后的只读面）→ 这里会停下
 * `..` 形态的路径，rg 把它当「workspace 相对且带 `..`」搜。Node 扫同口径：
 * 它**不**按 `..` 前缀剔除（见 `node-scan.ts`），两条引擎的读面因此一致。
 * 越界已由 `resolveSearchRoot` 的 containment 校验挡在入口。
 */
function toSearchPath(workspaceRoot: string, searchRoot: string): string {
  const rel = relative(workspaceRoot, searchRoot).split("\\").join("/");
  return rel.length === 0 ? "." : rel;
}

/** 安装根二进制不存在 / 不可执行 —— D6 的唯一起不来判据。 */
function isUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

/**
 * rc 解释：0/1 正常（1 = 无匹配）；2 = 用法 / 正则错误，**或**只是有文件读
 * 不到（`--no-messages` 已把后者压成空 stderr）；其余 = 引擎故障。
 *
 * rc=2 且 stderr 空时 stdout 仍是合法命中 —— 若在这里抛，一个不可读的邻居
 * 文件就会让整次查询失败，而 Node 引擎只是跳过该文件，两条引擎对同一目录
 * 给出不同答案（SC9）。所以这种 2 当「部分成功」处理：解析拿到的行。
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

/** 按出法解析 stdout；content + context 走组解析（SC6）。 */
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
  return {
    kind: "lines",
    lines: parseRgNullLines(stdout).map((hit) => ({
      ...hit,
      text: truncateMatchContent(hit.text),
    })),
  };
}

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return (idx === -1 ? text : text.slice(0, idx)).trim();
}
