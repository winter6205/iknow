/**
 * 「按 path 取全文行」的 fs 边界（D5 行窗 + D3 context 共用）。
 *
 * 单点职责：把「一个 workspace 相对路径」变成行数组，或 null（不可读 /
 * 二进制 / 超大）。`also-window.ts` 与 `context-groups.ts` 都消费它，因此
 * 两条展示路径的文件准入完全一致 —— 不会出现「also 能看但 context 看不了」
 * 这类分叉。
 *
 * 跳过策略沿用旧 Node 回退（ADR-0004 修订）：>1MB 或含 NUL 探针命中的文件
 * 不当文本读。行号 1 基 = 下标 + 1，所以 `readLines()[n-1]` 是第 n 行。
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

/** 与 read_file 对齐：1MB 以上不当文本读。 */
export const MAX_TEXT_FILE_BYTES = 1_048_576;

/** 二进制探针窗口。 */
export const BINARY_PROBE_BYTES = 8_192;

/** Workspace 相对路径 → 行数组；不可读 / 二进制 / 超大 → null。 */
export async function readWorkspaceLines(
  workspaceRoot: string,
  relPath: string
): Promise<ReadonlyArray<string> | null> {
  const abs = resolve(workspaceRoot, relPath);
  const info = await stat(abs).catch(() => null);
  if (info === null || !info.isFile()) return null;
  if (info.size > MAX_TEXT_FILE_BYTES) return null;
  const buf = await readFile(abs).catch(() => null);
  if (buf === null) return null;
  if (containsNul(buf, BINARY_PROBE_BYTES)) return null;
  return splitLines(buf);
}

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

/** 二进制探针：前 probeBytes 字节里出现 NUL 即判二进制。 */
export function containsNul(buffer: Buffer, probeBytes: number): boolean {
  const end = Math.min(buffer.length, probeBytes);
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}
