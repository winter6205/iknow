/**
 * `get_record` — the content axis of the read side: one record named by
 * `record_id`, read as a character window the caller addresses. Shared core
 * behind both thin faces (ACI in-process + stdio MCP), mirroring the
 * `query_trace` / `list_sessions` contract: `options` in, one serialized JSON
 * string out; the faces add schema, tool-name prefix, and error mapping.
 *
 * 三条轴的读单元各不同，这件工具的存在理由就在其中：
 *   - `list_sessions` 的单位是一页会话摘要（目录轴）；
 *   - `query_trace` 的单位是一行（行轴：筛选 + 分页，记录整体返回）；
 *   - `get_record` 的单位是**一个 part 的一段字符窗**（内容轴）。
 * 前两者都无法回答「这条 43 KB 的 tool result 的第 9000 到 10000 个字符是什么」，
 * 而把整条塞进一次输出正是 executor 帽存在的原因。本轴让调用方自己给坐标，于是
 * 「读多少」第一次成为合同的显式部分，而不是输出的偶然属性。
 *
 * `conversation_id` 在本面**必填**（Assumption 4）：`query_trace` 的「缺省=最近活
 * 跃会话」是外部 agent 读到过一个它从未点名的文件的根因，内容轴第一个把它关掉。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  collectToolResults,
  dereferenceTraceMessages,
  isRecord,
  messageContentBlocks,
  type ProjectedToolResult,
} from "./project-tool-results.js";
import { createJsonlTraceReader } from "./reader.js";
import {
  lookupRecordById,
  projectRecordBase,
  type RecordMatch,
} from "./record-lookup.js";
import {
  TraceQueryValidationError,
  TraceRecordNotFoundError,
  TraceSessionNotFoundError,
  TraceWindowOverflowError,
} from "./query-trace-errors.js";
import { parseInteger } from "./parse-integer.js";
import type { TraceRecordRow } from "./types.js";

/**
 * 缺省窗与窗上限（plan T6 实测：message p50 = 393，part p99 = 13 848，part
 * max = 43 174 字符）。
 *
 * 400 让一次缺省调用装得下一条中位 message，也与行轴 `TOOL_RESULT_PREVIEW_CAP`
 * 同一个量级，调用方在两面之间换轴时不必换算。16 000 只由 part 分布决定（p99 一窗
 * 装得下，max 需 3 窗），**不**承诺「最大合法窗也落在 `TRACE_OUTPUT_BACKSTOP` 之内」
 * ——实测反证：`record` 标量投影序列化后 max = 6 025（5 546 条记录），且 `text` 经
 * `JSON.stringify` 会转义膨胀（p99 = 1.21，max = 1.30 倍），两条都足以单独越帽。所以
 * `count` 预算的是**正文字符数**，不是响应大小；核在两种情况下都不裁任何东西，越帽
 * 时唯一动手的是 face 的 backstop（MCP）或 executor 帽（ACI，同值）。
 *
 * 界在核（`parseInteger`）与两张皮的 schema 里各自声明一次且同值（spec SC18）。
 */
export const GET_RECORD_DEFAULT_COUNT = 400;
export const GET_RECORD_MAX_COUNT = 16_000;

/**
 * The one description text for both faces (spec SC7 / SC18: one source, and it
 * claims no character cap — the budget on this axis is the caller's own `count`).
 * Positive-trigger phrasing per #483 D9, enforced by
 * tests/harness/aci/tools/d9-description-guard.test.ts.
 */
export const GET_RECORD_DESCRIPTION =
  "Read one record's content with get_record, addressed as a character window " +
  "inside one record named by record_id in a required conversation_id. Two arms: " +
  "pass part_index to read a window, omit part_index to get an inventory of the " +
  "record's addressable parts — each part's coordinates, its message's role " +
  "(present under detail=messages; absent under detail=tool_results), and its " +
  "size in characters, with no content, which is how you learn a part's length " +
  "before spending output on it. A window returns exactly count characters " +
  "starting at from_char, reports the part's length as part_chars, and echoes " +
  "the effective coordinates, so count is the read unit you budget with. To page " +
  "through a part, read the first window, then raise from_char by count until " +
  "from_char + count would pass part_chars; a window past the part end answers " +
  "with that size and the remaining characters. Use detail=messages to address " +
  "an LLM call's message content blocks (each inventory part carries the role " +
  "of its message), which also requires message_index; leave detail at its " +
  "default tool_results to address that call's projected tool results by " +
  "part_index, in projection order and in full. Positions count UTF-16 code " +
  "units, so a boundary may fall between the halves of a surrogate pair. " +
  "Discover conversation_id with list_sessions and record_id with query_trace.";

type Detail = "messages" | "tool_results";

interface GetRecordInput {
  readonly conversation_id?: unknown;
  readonly record_id?: unknown;
  readonly detail?: unknown;
  readonly message_index?: unknown;
  readonly part_index?: unknown;
  readonly from_char?: unknown;
  readonly count?: unknown;
}

export interface GetRecordCoreOptions {
  readonly traceDir: string;
}

export type GetRecordCoreHandler = (input: unknown) => Promise<string>;

export function createGetRecordCore(
  options: string | GetRecordCoreOptions
): GetRecordCoreHandler {
  const traceDir = typeof options === "string" ? options : options.traceDir;

  return async (input: unknown): Promise<string> => {
    const parsed = parseInput(input);
    const filePath = join(traceDir, `${parsed.conversationId}.jsonl`);
    // 先判文件在不在，再判记录在不在：两者是不同的主张（「这个会话没被读到」vs
    // 「读完了，没有这条」），合成一个 `record_not_found` 就会把前者说成后者。
    // 用 existsSync 而非 statSync().isFile()：目录名撞上 `<conv>.jsonl` 时
    // isFile() 会把一个 IO 问题报成 not found，交给 reader 报 EISDIR 才诚实。
    if (!existsSync(filePath)) {
      throw new TraceSessionNotFoundError(parsed.conversationId);
    }
    const reader = createJsonlTraceReader({ filePath });
    // 与行轴同一份扫描实现（record-lookup.ts）：上限、id 字段顺序、
    // `record_scan` 的判据都只有一处定义。
    const found = lookupRecordById(reader, {}, parsed.recordId);
    if (found.match === undefined) {
      throw new TraceRecordNotFoundError(parsed.recordId);
    }

    const parts = await addressParts(found.match.row, parsed.detail, traceDir);
    return JSON.stringify(
      parsed.partIndex === undefined
        ? manifestOf(found.match, parsed, parts)
        : windowOf(found.match, parsed, parts)
    );
  };
}

/**
 * 解析后的坐标：`fromChar` / `count` 是**生效值**（未传时是缺省值），
 * `messageIndex` / `partIndex` 保留「有没有传」这一档信息 —— 臂的选择和「哪个坐标
 * 参与了寻址」都依赖它。
 */
interface ResolvedRequest {
  readonly detail: Detail;
  readonly messageIndex?: number;
  readonly partIndex?: number;
  readonly fromChar: number;
  readonly count: number;
  readonly windowCoordinatesGiven: {
    readonly fromChar: boolean;
    readonly count: boolean;
  };
}

function parseInput(input: unknown): ResolvedRequest & {
  readonly conversationId: string;
  readonly recordId: string;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TraceQueryValidationError("input", "input must be an object");
  }
  const raw = input as GetRecordInput;
  const conversationId = requireNonEmptyString(
    raw.conversation_id,
    "conversation_id"
  );
  if (conversationId.includes("/") || conversationId.includes("\\")) {
    throw new TraceQueryValidationError(
      "conversation_id",
      "conversation_id must not contain path separators"
    );
  }
  const recordId = requireNonEmptyString(raw.record_id, "record_id");
  const detail = parseDetail(raw.detail);
  // 坐标的**界**在这里查（负数、小数、超限）；坐标的**可达性**（这一条记录到底有
  // 几条 message / 几个 part）在下面寻址时查，因为那要读到记录才知道。
  const messageIndex = parseInteger(raw.message_index, "message_index", 0);
  const partIndex = parseInteger(raw.part_index, "part_index", 0);
  const fromChar = parseInteger(raw.from_char, "from_char", 0) ?? 0;
  const count =
    parseInteger(raw.count, "count", 1, GET_RECORD_MAX_COUNT) ??
    GET_RECORD_DEFAULT_COUNT;
  return {
    conversationId,
    recordId,
    detail,
    ...(messageIndex === undefined ? {} : { messageIndex }),
    ...(partIndex === undefined ? {} : { partIndex }),
    fromChar,
    count,
    // 「调用方给了窗坐标」与「窗坐标等于缺省值」是两件事：清单臂要拒的是前者，
    // 所以这里留一份 presence，而不是回头比对数值。
    windowCoordinatesGiven: {
      fromChar: raw.from_char !== undefined,
      count: raw.count !== undefined,
    },
  };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TraceQueryValidationError(
      field,
      `${field} must be a non-empty string`
    );
  }
  return value;
}

function parseDetail(value: unknown): Detail {
  if (value === undefined) return "tool_results";
  if (value !== "messages" && value !== "tool_results") {
    throw new TraceQueryValidationError(
      "detail",
      "detail must be one of: messages, tool_results"
    );
  }
  return value;
}

/** 一个可寻址的 part：坐标 + 全文。窗与清单都从这一份列表回答，两者因此不可能对不上。 */
interface AddressablePart {
  readonly messageIndex?: number;
  readonly partIndex: number;
  readonly text: string;
  readonly identity?: Record<string, unknown>;
  // v1.2 判据 (a): detail=messages 清单臂的 part 携带所属 message 的 role
  // (ADR-0003 messages[].role 值域: user / assistant / tool / system). 投影层
  // 字段, 仅清单臂使用, 不进窗臂, 也不进 detail=tool_results parts (tool_result
  // 按定义在 user 侧, 加 role 是冗余且易混淆 user-message 与其中嵌套的
  // tool_result — 参 CONTEXT.md tool_result projection 词条).
  readonly role?: string;
}

/**
 * 一条记录里可寻址的 part 列表，按 `detail` 二选一。
 *
 * `messages` 取 message 的 content blocks（先经 ADR-0036 的 blob 解引用，所以
 * blob 存的 message 与内联的同法寻址）；`tool_results` 取投影后的 tool_result
 * **全文**，顺序与投影一致 —— 行轴那份 `preview` 受 400 字符帽管，拿它的长度当
 * 本轴的尺寸会告诉调用方「一条装得下」而实际要三窗。
 */
async function addressParts(
  row: TraceRecordRow,
  detail: Detail,
  traceDir: string
): Promise<{
  readonly parts: ReadonlyArray<AddressablePart>;
  readonly messageCount: number;
}> {
  const messages = Array.isArray(row["messages"]) ? row["messages"] : [];
  const dereferenced = await dereferenceTraceMessages(messages, { traceDir });
  if (detail === "tool_results") {
    const results: readonly ProjectedToolResult[] =
      collectToolResults(dereferenced);
    return {
      messageCount: dereferenced.length,
      parts: results.map((result, index) => ({
        partIndex: index,
        text: result.text,
        identity: {
          tool_use_id: result.tool_use_id,
          ...(result.name === undefined ? {} : { name: result.name }),
          is_error: result.is_error,
        },
      })),
    };
  }
  const parts: AddressablePart[] = [];
  dereferenced.forEach((message, messageIndex) => {
    // v1.2 判据 (a): 解引用后的 message 上读 role (string 时). 不可读时
    // (例如解引用降级到空数组已由 dereferenceTraceMessages 处理, 正常路径
    // 上不会出现) 不带 role -- 与 detail=tool_results parts 行为一致:
    // 字段缺席而非 null/undefined.
    const role =
      isRecord(message) && typeof message.role === "string"
        ? message.role
        : undefined;
    messageContentBlocks(message).forEach((block, partIndex) => {
      parts.push({
        messageIndex,
        partIndex,
        text: renderPart(block),
        ...(role === undefined ? {} : { role }),
      });
    });
  });
  return { parts, messageCount: dereferenced.length };
}

/**
 * part 的正文：存的什么形态就是什么文本 —— 裸字符串按自身，其余（content block
 * 对象等）按其 JSON 文本。这是第 14 条留给实现的那条渲染规则，写成一处以免清单的
 * `chars` 与窗的 `text` 各自演算。
 */
function renderPart(part: unknown): string {
  return typeof part === "string" ? part : JSON.stringify(part);
}

/** 清单臂：记录标量 + 可寻址 part 的坐标与尺寸，不带任何正文。 */
function manifestOf(
  match: RecordMatch,
  parsed: ResolvedRequest,
  addressable: {
    readonly parts: ReadonlyArray<AddressablePart>;
    readonly messageCount: number;
  }
): Record<string, unknown> {
  rejectUnusedWindowCoordinates(parsed);
  const scoped = parsed.messageIndex !== undefined;
  const parts = selectParts(addressable.parts, parsed, addressable);
  return {
    record: projectRecordBase(match.row),
    matched_on: match.matchedOn,
    detail: parsed.detail,
    ...(scoped ? { message_index: parsed.messageIndex } : {}),
    parts: parts.map((part) => ({
      ...(part.messageIndex === undefined || scoped
        ? {}
        : { message_index: part.messageIndex }),
      part_index: part.partIndex,
      chars: part.text.length,
      ...(part.identity ?? {}),
      // v1.2 判据 (a): detail=messages 的 part 携带所属 message 的 role;
      // tool_results parts 上无 role (AddressablePart.role 不带, 见
      // addressParts 的 detail === "tool_results" 分支). 字段缺席 = 不
      // 渲染空键, 与本文件其他 part 字段保持一致.
      ...(part.role === undefined ? {} : { role: part.role }),
    })),
  };
}

/** 窗臂：记录标量 + 命中轴 + 生效坐标 + 该 part 尺寸 + 恰好 count 个字符。 */
function windowOf(
  match: RecordMatch,
  parsed: ResolvedRequest,
  addressable: {
    readonly parts: ReadonlyArray<AddressablePart>;
    readonly messageCount: number;
  }
): Record<string, unknown> {
  const part = selectParts(addressable.parts, parsed, addressable)[0]!;
  const { fromChar, count } = parsed;
  if (fromChar + count > part.text.length) {
    throw new TraceWindowOverflowError({
      fromChar,
      count,
      partChars: part.text.length,
    });
  }
  // `text` 必须是最后一个键：face 的 backstop 从尾部切，键序因此决定了被切到的是正文
  // 还是回显坐标（后者留下，调用方才能只改小 `count` 重发，不必重新寻址）。
  return {
    record: projectRecordBase(match.row),
    matched_on: match.matchedOn,
    detail: parsed.detail,
    ...(parsed.messageIndex === undefined
      ? {}
      : { message_index: parsed.messageIndex }),
    part_index: parsed.partIndex!,
    from_char: fromChar,
    count,
    part_chars: part.text.length,
    text: part.text.slice(fromChar, fromChar + count),
  };
}

/**
 * 把坐标收成一条 part —— 两臂共用同一条判据，所以「参与寻址的坐标必须被回答，
 * 不被使用的坐标必须被拒」只有一处实现。
 *
 * 越界的 `message_index` / `part_index` 报 `validation` 并带上**真实可寻址条数**
 * （SC20 只有五类，不第六类）；`detail=tool_results` 根本不按 message 寻址，传了
 * 就是拒；`detail=messages` 的窗必须有 `message_index`，缺省成 0 会把「没点名的
 * 那条」答成「第 0 条」。
 */
function selectParts(
  parts: ReadonlyArray<AddressablePart>,
  parsed: ResolvedRequest,
  addressable: { readonly messageCount: number }
): ReadonlyArray<AddressablePart> {
  const { detail, messageIndex, partIndex } = parsed;
  if (detail === "tool_results") {
    if (messageIndex !== undefined) {
      throw new TraceQueryValidationError(
        "message_index",
        "message_index addresses one message; detail=tool_results addresses projected tool results, which are not message-indexed"
      );
    }
    if (partIndex === undefined) return parts;
    if (partIndex >= parts.length) {
      throw outOfRange("part_index", partIndex, parts.length, "tool results");
    }
    return parts.slice(partIndex, partIndex + 1);
  }
  const windowArm = partIndex !== undefined;
  if (!windowArm && messageIndex === undefined) return parts;
  if (messageIndex === undefined) {
    if (!windowArm) return parts;
    throw new TraceQueryValidationError(
      "message_index",
      "message_index is required for a window: detail=messages parts are addressed by message_index plus part_index"
    );
  }
  if (messageIndex >= addressable.messageCount) {
    throw outOfRange(
      "message_index",
      messageIndex,
      addressable.messageCount,
      "messages"
    );
  }
  const scoped = parts.filter((part) => part.messageIndex === messageIndex);
  if (partIndex === undefined) return scoped;
  if (partIndex >= scoped.length) {
    throw outOfRange(
      "part_index",
      partIndex,
      scoped.length,
      "content blocks",
      `message ${messageIndex} has`
    );
  }
  return scoped.slice(partIndex, partIndex + 1);
}

function outOfRange(
  field: "message_index" | "part_index",
  index: number,
  count: number,
  unit: string,
  owner = "this record has"
): TraceQueryValidationError {
  return new TraceQueryValidationError(
    field,
    `${field} ${index} is out of range: ${owner} ${count} ${unit}`
  );
}

/** 清单臂上没有 `part_index` 就没有窗可读：窗坐标因此是被拒，不是被忽略。 */
function rejectUnusedWindowCoordinates(parsed: ResolvedRequest): void {
  if (parsed.partIndex !== undefined) return;
  for (const [field, given] of [
    ["from_char", parsed.windowCoordinatesGiven.fromChar],
    ["count", parsed.windowCoordinatesGiven.count],
  ] as const) {
    if (!given) continue;
    throw new TraceQueryValidationError(
      field,
      `${field} addresses a window and requires part_index; omit the window coordinates to read the inventory instead`
    );
  }
}
