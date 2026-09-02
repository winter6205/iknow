/**
 * `list_sessions` — the shared read-side core behind both thin tool faces
 * (ACI in-process + stdio MCP), mirroring `createQueryTraceCore`'s contract:
 * `options` in, one serialized JSON string out. The faces add their own schema,
 * their own tool-name prefix, and their own error mapping; they do not re-do the
 * reading, the ordering, or the paging.
 *
 * 这条轴为什么需要一件独立的工具（`query_trace` 顶不了）：
 *   - `query_trace` 只读**一个**文件（`conversation_id ?? newestConversationId`，
 *     见 query-trace-core.ts），所以它结构上看不见目录里其余的会话；
 *   - 会话根记录要到 run 结束才落盘（src/harness/trace/jsonl.ts:267-282，唯一调用点
 *     src/harness/loop-engine.ts:2149-2158），永远是文件最后一行，crash / 进行中的
 *     会话根本没有根记录；
 *   - `listSessions`（sessions.ts）以 readdir + stat 建索引，正文只在首 64 KiB
 *     窗口内扫一根记录取 `agent_version`（不整文件读入，也不把记录内容带进响应），
 *     两类都发现得到。
 * 所以本工具回答的是「有哪些会话」这一条目录轴，与行轴（`query_trace`）、字节窗轴
 * （`get_record`，T6）正交。
 */
import { sessionsByRecency, type SessionSummary } from "./sessions.js";
import { parseInteger } from "./parse-integer.js";
import { TraceQueryValidationError } from "./query-trace-errors.js";

/**
 * 本轴的读单元 = 一页会话摘要。缺省 100 与 `query_trace` 同量级，名字**故意分开**：
 * 两条轴的单位不同（一条摘要 vs 一行记录），plan T7 只会重新校准 `query_trace`
 * 那一组。
 *
 * 上限 128 由 `TRACE_OUTPUT_BACKSTOP` 反推，不是取整偏好。一满页必须序列化成帽内
 * 可解析的 JSON，否则截断标记会落在数组中间，调用方拿到的不是一页索引而是一段残文
 * ——而 backstop / executor 帽都按 `text.length` 计，所以这里的预算单位是**字符**不是
 * 字节。实测（主仓 81 个真实会话，一次性探针）：单条摘要的 JSON 本体 71–124 字符
 * （UUID `conversation_id` + `agent_version` 都在 = 124；无 `agent_version` = 71），
 * 页面内连写还要 +1 个条目间逗号 ⇒ 72–125（测试注释用的是后一个口径）。按页内口径：
 * 128 × 125 = 16 000 < 20 000，200 × 125 = 25 000 已越帽；四字段的可打印上限约 126
 * （订正：plan 第 13 条记作「单条约 141 B」，本轮在同一份真实目录上复现不出来——最宽
 * 124 字符且 `agent_version` 全为 `0.1.0`——以本处复测为准）。
 * 「一满页在帽内」由 tests/traceserver/list-sessions-core.test.ts 的实测断言钉住
 * （摘要尺寸会随 `agent_version` 之类字段漂移，光看这个数字不够）。
 */
export const LIST_SESSIONS_DEFAULT_LIMIT = 100;
export const LIST_SESSIONS_MAX_LIMIT = 128;

/**
 * The one description text for both faces (spec SC7 / SC18: one source, and it
 * claims no character cap — how much you read is `limit`, never a byte budget).
 * Positive-trigger phrasing per #483 D9, enforced by
 * tests/harness/aci/tools/d9-description-guard.test.ts.
 */
export const LIST_SESSIONS_DESCRIPTION =
  "List the trace sessions in this trace directory, most recently active first. " +
  "Read this to discover which conversation_id values exist before querying one. " +
  "Each entry carries conversation_id, mtime (epoch milliseconds), size (bytes), " +
  "and agent_version taken from that session's root record. The writer appends " +
  "the root record when a run ends, while this tool reads only the first 64 KiB " +
  "of each file, so the field is absent in two cases: the run has not ended, or " +
  "the file is larger than that read window and the root record sits past it. " +
  "Absence therefore reports that no root record was found in the window, and " +
  "says nothing about whether the session finished. Page the index with limit " +
  "(default 100, up to 128) and offset; the response echoes the effective limit " +
  "and offset, so a page shorter than the echoed limit means the index is " +
  "exhausted and offset + entries returned continues it. Pair a returned " +
  "conversation_id with query_trace to read that session's records.";

interface ListSessionsInput {
  readonly limit?: unknown;
  readonly offset?: unknown;
}

/**
 * tool face 的线形状：`sessions` + **回显本次真正用到的坐标**。
 *
 * 回显坐标不是截断元数据：契约 X 只禁 `truncated` / `total` /
 * `response_truncated`（ADR-0004:23、spec SC7），而 `limit` / `offset` 是调用方
 * 自己给的 read unit。plan §序列化 把 tool face 输出定义为「数组 + 回显调用方给过
 * 的坐标」，边界类表 overflow 格的判据是「只丢尾 + 续取坐标」，T7 同样保留行轴
 * `offset` —— 三处文本同一个形状。回显的是**生效值**（未传时是默认值），所以「这页
 * 是否到底」可由 `sessions.length < limit` 就地判定，续取坐标 = `offset +
 * sessions.length`，调用方不必记住自己传了什么。
 */
export interface ListSessionsPage {
  readonly sessions: ReadonlyArray<SessionSummary>;
  readonly limit: number;
  readonly offset: number;
}

export interface ListSessionsCoreOptions {
  readonly traceDir: string;
}

export type ListSessionsCoreHandler = (input: unknown) => Promise<string>;

export function createListSessionsCore(
  options: string | ListSessionsCoreOptions
): ListSessionsCoreHandler {
  const traceDir = typeof options === "string" ? options : options.traceDir;

  return async (input: unknown): Promise<string> => {
    const { limit, offset } = parseInput(input);
    // 每次调用重读索引：会话在跑，缓存会把新会话藏起来（与 newestConversationId
    // 同一个理由）。页序由 sessions.ts 的比较式给，本处只切位置。
    const page: ListSessionsPage = {
      sessions: sessionsByRecency(traceDir).slice(offset, offset + limit),
      limit,
      offset,
    };
    return JSON.stringify(page);
  };
}

function parseInput(input: unknown): { limit: number; offset: number } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TraceQueryValidationError("input", "input must be an object");
  }
  const raw = input as ListSessionsInput;
  // 两张皮各自在自己 schema 上声明同样的界（ACI ajv 编译并强制、MCP zod 强制），
  // 这里复查是同一条规则的第二道权威，不是第三套语义。上界取本文件常量；下界
  // （`limit` 1 / `offset` 0）在三处都是字面量，跨面是否漂移由
  // tests/trace-mcp/server.test.ts 的 SC18 diff 测无条件比对 `minimum` 钉住。
  const limit =
    parseInteger(raw.limit, "limit", 1, LIST_SESSIONS_MAX_LIMIT) ??
    LIST_SESSIONS_DEFAULT_LIMIT;
  const offset = parseInteger(raw.offset, "offset", 0) ?? 0;
  return { limit, offset };
}
