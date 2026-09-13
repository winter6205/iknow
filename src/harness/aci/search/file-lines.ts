/**
 * 「按 path 取全文行」的 fs 边界（D5 行窗 + D3 context 共用）。
 *
 * 单点职责：把「一个 workspace 相对路径」变成行数组，或 null（不可读 /
 * 二进制 / 超大）。`also-window.ts` 与 `context-groups.ts` 都消费它，因此
 * 两条展示路径的文件准入完全一致 —— 不会出现「also 能看但 context 看不了」
 * 这类分叉。
 *
 * 跳过策略沿用旧 Node 回退（ADR-0004 修订）：>1MB 或**整文件**含 NUL 的文件
 * 不当文本读（显式点名的文件另有一个宽裕上界，见 `MAX_EXPLICIT_FILE_BYTES`）。
 * 行号 1 基 = 下标 + 1，所以 `readLines()[n-1]` 是第 n 行。
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 文本文件的体积闸（**唯一权威**）：1 MiB 以上不当文本读。
 *
 * 与 `read_file` 的拒读线同值但**不是同一份常量** —— `read-file.ts` 另有私有
 * `MAX_FILE_BYTES`（Task A 面，本切片不动）。搜索侧三处消费者（遍历期的
 * `--max-filesize`、`readWorkspaceLines`、`node-scan` 的准入）都从这里取，
 * 避免再长出一份漂移的复制。
 */
export const MAX_TEXT_FILE_BYTES = 1_048_576;

/**
 * 显式点名文件的体积上界（**16 倍** `MAX_TEXT_FILE_BYTES`）。
 *
 * 「显式文件豁免」是为对齐 rg 的 `--max-filesize` 只管遍历期而设的（见
 * 下）。但豁免若无上界，`{path: "<超大文件>"}` 会把任意大的文件整个读进
 * 内存；rg 那边是流式扫，Node 这边就成了 OOM 面。给一个宽裕但有限的上界，
 * 且**两条引擎共用这一条**：超过它的显式文件在 rg 与 Node 上都不被搜索
 * （rg 侧由 `grep.ts` 的准入过滤裁掉，不是各写一份阈值）。
 */
export const MAX_EXPLICIT_FILE_BYTES = MAX_TEXT_FILE_BYTES * 16;

/**
 * Workspace 相对路径 → 文本 buffer；不可读 / 二进制 / 超大 → null。
 *
 * 这是「文件能不能当文本读」的**唯一准入判定**：`readWorkspaceLines` 与
 * `isTextFile` 都走它，两条引擎的接受集因此同源。分开两种消费形状（要行 /
 * 只要一个布尔）是为了让 `paths` / `count` 出法不必付切行的代价。
 *
 * `allowOversize` 只给「搜索根是**显式点名的单个文件**」这一条路用：rg 的
 * `--max-filesize` 只在**递归遍历**时生效，显式喂进来的文件即使超限也照搜
 * （实测 rg 15.1.0）。Node 侧若一律按体积拒读，同一个 `path: "big.ts"`
 * 就会在两条引擎上给出不同答案；反过来若完全不加界，超大文件就是无界读。
 * 于是取 `MAX_EXPLICIT_FILE_BYTES` 这个共同上界。
 *
 * 二进制判据是**整文件**扫描 NUL（`containsNul`），与 `read_file` 的
 * `buffer.includes(0x00)` 同口径（ADR-0004 的读侧先例）。为什么不能沿用
 * rg 自己的二进制检测当权威：它按 64 KiB 窗口判，且**同一文件在不同出法下
 * 结论不同** —— 远距离 NUL 的文件 `-l` 会列出、`--count` 会略过（实测
 * 15.1.0，因为 `-l` 命中即返回、`--count` 要读到文件尾）。那种「口径」没有
 * 可复刻的一致含义，所以两条引擎统一采用本函数的整文件判定，rg 自带的检测
 * 只当省 I/O 的粗筛（见 `rg-engine.ts` 的准入过滤）。
 */
async function readTextBuffer(
  workspaceRoot: string,
  relPath: string,
  allowOversize: boolean
): Promise<Buffer | null> {
  const abs = resolve(workspaceRoot, relPath);
  const info = await stat(abs).catch(() => null);
  if (info === null || !info.isFile()) return null;
  if (
    info.size > (allowOversize ? MAX_EXPLICIT_FILE_BYTES : MAX_TEXT_FILE_BYTES)
  ) {
    return null;
  }
  const buf = await readFile(abs).catch(() => null);
  if (buf === null || containsNul(buf)) return null;
  return buf;
}

/**
 * Workspace 相对路径 → 行数组；不可读 / 二进制 / 超大 → null。
 *
 * 行号 1 基 = 下标 + 1，所以 `readLines()[n-1]` 是第 n 行。
 */
export async function readWorkspaceLines(
  workspaceRoot: string,
  relPath: string,
  options?: { readonly allowOversize?: boolean }
): Promise<ReadonlyArray<string> | null> {
  const buf = await readTextBuffer(
    workspaceRoot,
    relPath,
    options?.allowOversize === true
  );
  return buf === null ? null : splitLines(buf);
}

/**
 * 准入布尔：该路径此刻能不能被当作文本搜索（`readWorkspaceLines` 的非 null
 * 判据，只是不切行）。rg 引擎用它把「rg 报了但按本工具口径是二进制 / 超大」
 * 的文件剔掉 —— 两条引擎因此共用同一条准入（见 `rg-engine.ts`）。
 */
export async function isTextFile(
  workspaceRoot: string,
  relPath: string,
  options?: { readonly allowOversize?: boolean }
): Promise<boolean> {
  return (
    (await readTextBuffer(
      workspaceRoot,
      relPath,
      options?.allowOversize === true
    )) !== null
  );
}

/**
 * 一批 workspace 相对路径 → 通过准入的那些（**顺序保持**，同一路径只查一次）。
 *
 * 为什么需要「批」这个形状：rg 引擎只能在拿到它的候选之后才复核（见
 * `rg-engine.ts` 的准入过滤），而 rg 一次可以报出上万个文件。逐个 `await`
 * 会让墙钟跟文件数线性相乘；实测 34k 文件（本仓 `pattern=import` 的真实规模）
 * 串行 18.2s、8 路 3.2s、**64 路 1.3s**。整文件 NUL 扫描是纯 I/O，并发是安全
 * 的 —— 上限取 64 是为了不给文件描述符 / 页缓存添压，不是语义的一部分。
 */
export async function admittedPaths(
  workspaceRoot: string,
  paths: ReadonlyArray<string>,
  options?: { readonly allowOversize?: boolean }
): Promise<ReadonlySet<string>> {
  const admitted = new Set<string>();
  const pending: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    pending.push(path);
  }
  for (let i = 0; i < pending.length; i += ADMISSION_CONCURRENCY) {
    const slice = pending.slice(i, i + ADMISSION_CONCURRENCY);
    const flags = await Promise.all(
      slice.map((path) => isTextFile(workspaceRoot, path, options))
    );
    for (let j = 0; j < slice.length; j += 1) {
      if (flags[j] === true) admitted.add(slice[j]!);
    }
  }
  return admitted;
}

/** 准入复核的并发路数（纯 I/O；见 `admittedPaths` 的实测依据）。 */
const ADMISSION_CONCURRENCY = 64;

/** 按行切；CRLF 的 `\r` 剥掉；末行无换行也算一行。 */
export function splitLines(buffer: Buffer): string[] {
  const text = buffer.toString("utf8");
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      out.push(stripCr(text.slice(start, i)));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(stripCr(text.slice(start)));
  return out;
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * 二进制判据：**整个** buffer 里有 NUL 即判二进制。
 *
 * 不做窗口截断（旧实现只看前 8 KiB）：窗口是 rg 二进制检测的近似，而 rg 的
 * 窗口（64 KiB）与 NUL 位置的关系会产生「同一文件在具名搜索里被当二进制、
 * 在递归遍历里被当文本」这类自相矛盾的结果。NUL 只可能来自非文本内容，
 * 整文件扫描是唯一稳定的口径，也与 `read_file` 的 `buffer.includes(0x00)`
 * 完全一致。
 */
export function containsNul(buffer: Buffer): boolean {
  return buffer.includes(0x00);
}
