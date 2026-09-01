/**
 * Session list reader (read side of the trace inspection panel, v2).
 *
 * 只读目录元数据 + 会话根记录的 agent_version，不读其它会话内容：
 *   - readdirSync 列目录 → 每个 `<convId>.jsonl` 文件 = 一个会话（文件名 = conversation_id）。
 *   - statSync 取 mtime / size（最近活跃 + 字节，列表不读内容，行数≈size）。
 *   - 全文件有界扫描找会话根记录（record_type === "session"）提取 agent_version。
 *
 * 根记录位置与写侧的关系（SC-R 18 修正）：
 *   recordSession 在 loop-engine run **末尾**落盘（诚实值红线：endedAt /
 *   durationMs / status 只有 run 结束才能确定，见 loop-engine.ts run()），
 *   所以真实 writer 产出文件里 session 根是**最后一行**，首行通常是
 *   llm_call/turn —— 读首行会让 agent_version 恒 absent。故改为有界扫描
 *   全文件找 `record_type==="session"` 的行取 agent_version；找不到 / 坏行
 *   → 字段 absent（SC-R 18 语义不变：缺失/坏行 → absent，不因单会话坏行
 *   整体失败）。cap 截断保证对超大文件仍保持有界（不整文件 readFileSync）。
 *
 * 失败路径（SC-R 17/18）：
 *   - readdir ENOENT（无目录）→ 空列表，非 500 / 非 throw。
 *   - 单文件 stat ENOENT（读时该会话被删）→ 跳过该文件。
 *   - 根记录缺失 / 坏行 / 非 string agent_version → 字段 absent（optional，不整体失败）。
 *   - 其它读侧 IO 错误 → TraceReadError（serve.ts:157-166 映射 500，不泄漏 fs 细节）。
 */
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { isEnoent, wrapIoError } from "./io.js";

/** 会话列表条目的读侧元数据（wire 形状 snake_case）。 */
export interface SessionSummary {
  conversation_id: string; // 文件名去 `.jsonl` 后缀 = UUID
  mtime: number; // 最近活跃（stat.mtimeMs）
  size: number; // 字节（列表不读内容，行数≈size）
  agent_version?: string; // 从会话根记录读；缺失 / 坏行 → absent
}

const SESSION_FILE_SUFFIX = ".jsonl";

// -- 有界读取（不整文件 readFileSync） -----------------------------------------

/**
 * Read up to `cap` bytes of a file (bounded pread).
 *
 * 读侧对会话列表的约束是「不读文件内容」，唯一例外是 agent_version 需从
 * 会话根记录读。cap 截断保证对超大文件仍保持有界；文件更大时只扫描前缀
 * （会话根记录在 run 末尾落盘，文件内几乎必然在前缀内；截断边界上未命中
 * 会话根 → 字段 absent，不误报）。
 */
function readBounded(filePath: string, cap = 65536): string | undefined {
  const buf = Buffer.alloc(cap);
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const n = readSync(fd, buf, 0, cap, 0);
    return buf.toString("utf8", 0, n);
  } catch (err) {
    if (isEnoent(err)) return undefined; // stat 后、读前被删 → agent_version absent
    throw wrapIoError(err);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// -- agent_version 提取 --------------------------------------------------------

/**
 * Scan file text for the session root record and return its agent_version.
 *
 * 逐行解析，只认 `record_type === "session"` 的行（真实 writer 把它写在
 * run 末尾 = 最后一行；首行通常是 llm_call/turn，不因首行不是 session 而
 * 放弃）。根记录缺失 / 坏行 / 非 string → undefined（字段 optional，
 * 不整体失败，SC-R 18）。
 */
function agentVersionFromText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // 坏行：跳过，继续找会话根；全文件都坏 → absent
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    const row = parsed as Record<string, unknown>;
    if (row["record_type"] !== "session") continue; // 非会话根行 → 跳过
    const v = row["agent_version"];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  }
  return undefined; // 找不到会话根记录 / 全部坏行 → absent
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
    const agentVersion = agentVersionFromText(readBounded(filePath));
    sessions.push({
      conversation_id: conversationId,
      mtime: stats.mtimeMs,
      size: stats.size,
      ...(agentVersion !== undefined ? { agent_version: agentVersion } : {}),
    });
  }
  return sessions;
}

// -- 缺省会话（SC-R 12） --------------------------------------------------------

/** 索引里 mtime 最大的一条；相等时保留先入表者（只需要最大值，不需要排序）。 */
function newestSession(
  sessions: ReadonlyArray<SessionSummary>
): SessionSummary | undefined {
  return sessions.reduce<SessionSummary | undefined>((latest, session) => {
    if (latest === undefined) return session;
    return session.mtime > latest.mtime ? session : latest;
  }, undefined);
}

/**
 * 「最近活跃会话」的唯一推导，panel (`http.ts`) 与 tool
 * (`query-trace-core.ts`) 的隐式缺省都经它 (SC-R 12)。
 *
 * 每次调用重读索引，不缓存：面板在轮询、工具在连续调用之间都会有新会话落盘，
 * 缓存的缺省会静默变陈旧。无会话 / 目录不存在 → undefined，由调用方决定
 * 自己那面的空结果表达。
 */
export function newestConversationId(traceDir: string): string | undefined {
  return newestSession(listSessions(traceDir))?.conversation_id;
}
