/**
 * Session list reader (read side of the trace inspection panel, v2).
 *
 * 只读目录元数据 + 会话根记录的 agent_version，不读其它会话内容：
 *   - readdirSync 列目录 → 每个 `<convId>.jsonl` 文件 = 一个会话（文件名 = conversation_id）。
 *   - statSync 取 mtime / size（最近活跃 + 字节，列表不读内容，行数≈size）。
 *   - 仅读每文件第一行（会话根记录，L1 根先写）提取 agent_version。
 *
 * 失败路径（SC-R 17/18）：
 *   - readdir ENOENT（无目录）→ 空列表，非 500 / 非 throw。
 *   - 单文件 stat ENOENT（读时该会话被删）→ 跳过该文件。
 *   - 根记录缺失 / 坏行 / 非 string agent_version → 字段 absent（optional，不整体失败）。
 *   - 其它读侧 IO 错误 → TraceReadError（serve.ts:157-166 映射 500，不泄漏 fs 细节）。
 */
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { TraceReadError } from "./types.js";

/** 会话列表条目的读侧元数据（wire 形状 snake_case）。 */
export interface SessionSummary {
  conversation_id: string; // 文件名去 `.jsonl` 后缀 = UUID
  mtime: number; // 最近活跃（stat.mtimeMs）
  size: number; // 字节（列表不读内容，行数≈size）
  agent_version?: string; // 从会话根记录读；缺失 / 坏行 → absent
}

const SESSION_FILE_SUFFIX = ".jsonl";

// -- 只读第一行（不读整个文件内容） ---------------------------------------------

/**
 * Read only the first line of a file, bounded to `cap` bytes.
 *
 * 读侧对会话列表的约束是「不读文件内容」，唯一例外是 agent_version 需从
 * 会话根记录读。根记录是 L1 根、每个会话文件的**第一行**先写（jsonl.ts
 * recordSession 先于任何 turn/llm/tool）——故只读第一行即够，且对超大文件
 * 也保持有界（cap 截断，绝不整文件 readFileSync）。
 */
function readFirstLine(filePath: string, cap = 8192): string | undefined {
  const buf = Buffer.alloc(cap);
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const n = readSync(fd, buf, 0, cap, 0);
    const text = buf.toString("utf8", 0, n);
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } catch (err) {
    if (isEnoent(err)) return undefined; // stat 后、读前被删 → agent_version absent
    throw wrapIoError(err);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// -- agent_version 提取 --------------------------------------------------------

/**
 * Parse the session root record's agent_version off the first line.
 * 根记录缺失 / 坏行 / 非 string → undefined（字段 optional，不整体失败）。
 */
function agentVersionFromLine(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined; // 坏行：agent_version absent
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const row = parsed as Record<string, unknown>;
  if (row["record_type"] !== "session") return undefined; // 首行非会话根 → absent
  const v = row["agent_version"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// -- 目录扫描 ------------------------------------------------------------------

/**
 * List every session in `traceDir` by readdir + stat.
 *
 * 无目录（readdir ENOENT）→ 空列表（非 500）；单文件 stat ENOENT → 跳过；
 * 其它 IO 错误 → TraceReadError。只统计 `.jsonl` 文件（每会话一文件，
 * 写侧 jsonl.ts 目录语义），conversation_id = 文件名去后缀。
 */
export function listSessions(traceDir: string): SessionSummary[] {
  let names: string[];
  try {
    names = readdirSync(traceDir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw wrapIoError(err);
  }

  const sessions: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(SESSION_FILE_SUFFIX)) continue;
    const conversationId = name.slice(0, -SESSION_FILE_SUFFIX.length);
    const filePath = join(traceDir, name);
    let stats;
    try {
      stats = statSync(filePath);
    } catch (err) {
      if (isEnoent(err)) continue; // 读时该会话被删 → 跳过该文件
      throw wrapIoError(err);
    }
    if (!stats.isFile()) continue;
    const agentVersion = agentVersionFromLine(readFirstLine(filePath));
    sessions.push({
      conversation_id: conversationId,
      mtime: stats.mtimeMs,
      size: stats.size,
      ...(agentVersion !== undefined ? { agent_version: agentVersion } : {}),
    });
  }
  return sessions;
}

// -- 错误建模（复用 reader.ts 的 isEnoent / wrapIoError 模式） -----------------

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function wrapIoError(err: unknown): TraceReadError {
  const code =
    typeof err === "object" &&
    err !== null &&
    typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "IO";
  return new TraceReadError(`trace session list failed: ${code}`);
}
