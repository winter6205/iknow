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
import { stat } from "node:fs/promises";
import { relative } from "node:path";

import { ToolExecutionError } from "../../errors.js";
import { spawnWithStopSignal } from "../../sandbox/runner.js";
import { buildRgArgs } from "./argv.js";
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
  // 搜索目标本身含 `\n` / `\0` 时直接给空结果，**不** exec rg：rg 的 `--glob`
  // 排除只作用于遍历期，显式点名的文件 / 目录照搜（实测 15.1.0），而它的
  // 记录用 `\n` 收尾 —— 带 `\n` 的路径会把一条记录拆成两段，后半段长成一条
  // **假命中**（`nl\nname.txt` → `name.txt:1:<正文>`），且该假路径若真存在就
  // 能通过文本准入活到模型面前。搜索目标不可表示时它**整棵子树**也不可表示
  // （任何子孙路径都带这段祖先名），空结果与「全部跳过」同义。规则与理由见
  // `path-representable.ts`；Node 引擎侧由 `pipeline.ts` 的同一判据兜住。
  if (!isPathRepresentable(searchPath)) return parseByMode("", input);
  const args = buildRgArgs(input.spec, searchPath, MAX_MATCH_LINE_COLUMNS);
  const collected = await collect(input, args);
  if (collected === "unavailable") return { kind: "unavailable" };
  return applyAdmission(interpret(collected, input), input);
}

/**
 * 二进制 / 超大的**准入复核**（D6/SC9：两条引擎同一条准入线）。
 *
 * 为什么 rg 报出来的路径还要复核：rg 自己的二进制检测是按 64 KiB 窗口做的，
 * 且**同一文件在不同出法下结论不同**（实测 15.1.0：NUL 在 70 KB 处的文件
 * `-l` 列出、`--count` 略过、`content` 吐 WARNING）。那种口径没有可复刻的
 * 一致含义，所以本工具的口径是「二进制（整文件含 NUL）不搜」—— 与
 * `read_file` 的 `buffer.includes(0x00)` 同源（ADR-0004），单一权威落在
 * `file-lines.ts` 的 `readTextBuffer`。rg 自带的检测因此只当省 I/O 的粗筛：
 * 它再准，最终接受集也由这里决定，两条引擎对同一个文件要么都收、要么都拒。
 *
 * `allowOversize` 的判据与 Node 扫同形（搜索根是显式点名的文件）—— 少了它，
 * `path: "big.ts"` 在 Node 路径能搜、rg 路径被这里拒掉，等于把豁免修复的
 * 分歧又倒回来。
 */
async function applyAdmission(
  result: EngineResult,
  input: RgEngineInput
): Promise<EngineResult> {
  // `unavailable` 不是本层产物（调用方已分派掉），但它属于同一联合类型；
  // 显式挡掉后其余三种形状各处都需要具体成员访问。
  if (result.kind === "unavailable") return result;
  const paths = resultPaths(result);
  if (paths.length === 0) return result;
  const unique = new Set(paths);
  const admitted = await admittedPaths(input.workspaceRoot, paths, {
    allowOversize: await isExplicitFile(input),
  });
  // 全员通过时原样返回（省掉一次逐条重造）：比较基数是**去重后**的数量，
  // 命中行形状下同一文件会出现多次，拿 `paths.length` 比会永远走不到快路。
  if (admitted.size === unique.size) return result;
  return keepAdmitted(result, admitted);
}

/** 结果涉及的路径（三种形状各自的投影面）。 */
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

/** 按准入集合过滤结果（保持各形状的原有顺序）。 */
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

/** 搜索根是否指向一个存在的文件（与 `node-scan` / `grep.ts` 同判据）。 */
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
  // `parseRgNullLines` 内部已按 MAX_MATCH_LINE_COLUMNS 走唯一一道闸，这里
  // 不再收第二遍 —— 重复收口只会让「到底谁是权威」变得含糊。
  return { kind: "lines", lines: parseRgNullLines(stdout) };
}

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return (idx === -1 ? text : text.slice(0, idx)).trim();
}
