/**
 * Session list reader (read side of the trace inspection panel, v2).
 *
 * T6 (plans/session-folder-consolidation.md / SC16): two-level tree walk.
 *   - `traceDir` is now the **baseDir** — the parent of `<baseDir>/projects/`.
 *     Same path the cli passes via `IKNOW_TRACE_OUT`; the read side used to
 *     treat it as a flat `<traceDir>/<convId>.jsonl` directory, but T1
 *     already moved writes under the projects tree, and the read side
 *     has to follow.
 *   - Walk: `<baseDir>/projects/<project-slug>/<convId>/trace.jsonl`.
 *     Each conversation folder is a leaf, the `subagents/` sibling is
 *     excluded (SC16 subagent exclusion), and the `blobs/` subfolder is
 *     ignored (it sits under `<convId>/`, not a project root).
 *   - `mtime` / `size` = stat `trace.jsonl` (the file the reader reads),
 *     not the conversation folder or the project root. Pinned by tests
 *     under `t6-two-level-tree.test.ts`.
 *
 * 读 + 派生 agent_version (前缀 64 KiB 扫根记录) + 总序比较 这三层依旧在
 * 本文件;只是「每个会话在哪里」从「平铺目录文件」变成「两级树下找 leaf」。
 * 沿用既有的有界前缀扫描 (见前 SC-R 18 注释),其窗口代价与父任务 T6 无关。
 *
 * 失败路径(沿用 T1 之前的契约):
 *   - readdir ENOENT(无 baseDir / 无 projects/ 子层)→ 空列表,非 500 / 非 throw。
 *   - 单文件 stat ENOENT(读时该会话被删)→ 跳过该文件。
 *   - 根记录缺失 / 坏行 / 非 string agent_version → 字段 absent (optional, 不整体失败)。
 *   - 其它读侧 IO 错误 → TraceReadError (serve.ts:157-166 映射 500, 不泄漏 fs 细节)。
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

/**
 * T6 (SC16): trace file sits at the conversation folder root. The list
 * only walks folders whose `trace.jsonl` exists — that's the SC16 session
 * criterion. Folder-without-trace.jsonl is ignored (a freshly-mkdir'd
 * session that hasn't recorded yet).
 */
const TRACE_FILE_NAME_FOR_LIST = "trace.jsonl";

// -- 有界读取（不整文件 readFileSync） -----------------------------------------

/**
 * Read up to `cap` bytes of a file (bounded pread).
 *
 * 读侧对会话列表的约束是「不读文件内容」，唯一例外是 agent_version 需从
 * 会话根记录读。cap 截断保证对超大文件仍保持有界；文件更大时只扫描前缀，
 * 而根记录在 run 末尾落盘 —— 只有整个文件装进窗口时前缀扫描才碰得到它，
 * 未命中即字段 absent（代价与实测比例见文件头「有界前缀扫描的已知代价」）。
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

const PROJECTS_DIR_NAME = "projects";
const SUBAGENTS_DIR_NAME = "subagents";

/**
 * List every session in `traceDir` by two-level readdir + stat.
 *
 * Walk: `<traceDir>/projects/<project-slug>/<convId>/trace.jsonl`.
 * The `subagents/` subfolder under each project is a per-agent sibling,
 * not a session — it never carries a `trace.jsonl` (per-agent trace lives
 * deeper at `<project-slug>/<convId>/subagents/agent-<taskId>.jsonl`),
 * but excluding it by name is the SC16 contract and protects the listing
 * if the per-agent file ever takes a `trace.jsonl` name.
 *
 * 无目录（readdir ENOENT）→ 空列表（非 500）；单文件 stat ENOENT → 跳过；
 * 其它 IO 错误 → TraceReadError。conversation_id = conversation folder
 * 名（写侧 T1 已锁：sanitized UUID 形状）。
 */
export function listSessions(traceDir: string): SessionSummary[] {
  const projectsRoot = join(traceDir, PROJECTS_DIR_NAME);
  let projectDirNames: string[];
  try {
    projectDirNames = readdirSync(projectsRoot);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw wrapIoError(err);
  }

  const sessions: SessionSummary[] = [];
  for (const projectName of projectDirNames) {
    const projectDir = join(projectsRoot, projectName);
    let convDirNames: string[];
    try {
      convDirNames = readdirSync(projectDir);
    } catch (err) {
      if (isEnoent(err)) continue; // project 目录在 list 中途被删 → 跳过
      throw wrapIoError(err);
    }
    for (const convDirName of convDirNames) {
      // SC16: 排除 subagents/ 文件夹 —— 它在 <project-slug>/ 下挂载, 不是会话。
      if (convDirName === SUBAGENTS_DIR_NAME) continue;
      const convDir = join(projectDir, convDirName);
      const filePath = join(convDir, TRACE_FILE_NAME_FOR_LIST);
      let stats;
      try {
        stats = statSync(filePath);
      } catch (err) {
        if (isEnoent(err)) continue; // 该会话没 trace.jsonl → 跳过
        throw wrapIoError(err);
      }
      if (!stats.isFile()) continue;
      const agentVersion = agentVersionFromText(readBounded(filePath));
      sessions.push({
        conversation_id: convDirName,
        mtime: stats.mtimeMs,
        size: stats.size,
        ...(agentVersion !== undefined ? { agent_version: agentVersion } : {}),
      });
    }
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
 *
 * 本函数**不**建立在 `sessionsByRecency` 之上：它的并列规则是「严格更新者胜、
 * 否则保留先入表者」，那是 SC-R 12 的既有语义（面板缺省会话由它决定；并列这一级
 * 由 `tests/traceserver/sessions.test.ts:418` 钉，`http.test.ts` 只覆盖 mtime 有别的
 * 缺省路由），而分页要的是确定性全序。两者不同，各留各的比较式。
 */
export function newestConversationId(traceDir: string): string | undefined {
  return newestSession(listSessions(traceDir))?.conversation_id;
}

/**
 * 同一份会话索引的**确定性页序**：`mtime` 降序（最近活跃先出），并列时
 * `conversation_id` 升序。`list_sessions` tool face（plan
 * `trace-mcp-read-side-split` T5b）按 caller 给的 `limit` / `offset` 切片时经它。
 *
 * 为什么必须有 `conversation_id` 这一级：`listSessions` 返回 readdir 原序，而
 * readdir 顺序由文件系统决定，同一页在两次调用之间可能换人 —— 并列 mtime 不兜住
 * 就不是「调用方指定位置的一页」，是随机一页。
 *
 * 为什么是新函数而不是把排序塞进 `listSessions`：面板 (`http.ts:212-219`) 直接
 * 要 readdir 语义的索引，两张皮各管自己的线形状（plan 第 120 行）。
 */
export function sessionsByRecency(traceDir: string): SessionSummary[] {
  return listSessions(traceDir).sort(compareByRecency);
}

/** `mtime` 降序 → 同值时 `conversation_id` 升序（全序，与 readdir 顺序无关）。 */
function compareByRecency(a: SessionSummary, b: SessionSummary): number {
  if (a.mtime !== b.mtime) return b.mtime - a.mtime;
  if (a.conversation_id === b.conversation_id) return 0;
  // 纯码点比较，不用 localeCompare：页序不能随 ICU locale 变。
  return a.conversation_id < b.conversation_id ? -1 : 1;
}
