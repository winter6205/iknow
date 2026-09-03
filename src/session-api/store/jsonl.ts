/**
 * T1 (#618 / spec session-jsonl-resume D1–D2, ADR-0027): session 权威历史的
 * 单文件 append-only JSONL 形态 —— 纯 codec + 投影,零 IO。
 *
 * 记录形态(每行一条 JSON):
 *   1. session header(首行):`{type:"session", ...SessionFileV1 metadata}` —
 *      goal/cwd/title/schemaVersion 等元数据(D2),不另开 meta.json。构造时
 *      从 SessionFileV1 spread(去掉 messages),未知字段随之透传(#120
 *      spread-preserve 纪律在 JSONL 形态下同样成立)。
 *   2. message event:`{type:"message", id:"e<N>", parent:"e<N-1>"|null,
 *      message: AnthropicNativeMessage}` —— 每条事件有唯一 id 与 parent,
 *      组成链;tool_result 是 user message 的 content block,不单独成事件。
 *   3. head record:`{type:"head", id:"e<N>"|null}` —— 落盘的 rewind 头指针
 *      (spec:头指针落盘)。最后一条 head record 生效;缺省时取最后一个事件
 *      (容错:崩溃可能落在 event 已写、head 未写之间)。
 *
 * 命名 EXIT(spec Testing Decisions exception 类,T1 锁定其一):
 *   `drop-trailing-corrupt-line` —— 最后一个非空行 JSON.parse 失败 → 丢弃
 *   该行仍 load(崩溃半截 append 的唯一合法形态);任何非末行损坏 →
 *   parse_failed。形状错误(可解析但 wrong-shape)→ schema_invalid。
 *
 * id 方案:`e<index>`,index 为事件在 messages[] 中的下标;appendEvents 从
 * 盘上 maxEventIndex+1 继续编号,因此 rewind 后 fork 的新事件拿全新 id、
 * parent 指向当前 head,旧链留在文件里(T5 语义的原语底座)。
 *
 * T5 (#622):save 改为 append-only 感知 —— 以盘上 head 链为基准做
 * 最长公共前缀(LCP)对齐:投影一致 → 仅刷新 header(事件/head 记录原样
 * 保留);投影是链的延伸 → 追加尾部事件;投影是链的严格前缀 → 只追加
 * head 记录;分叉 → 从 LCP 边界续写新分支。任何情况下既有事件记录永不
 * 丢弃,rewind 跳过的链因此跨 save 永留同一份文件。
 */
import type { AnthropicNativeMessage } from "../../harness/index.js";
import type { CheckpointRecord, GoalState, SessionFileV1 } from "./schema.js";
import { sanitizeSessionFile } from "./schema.js";

/** JSONL session log 扩展名。load 按扩展名识别形态:有 `<id>.jsonl` 走
 *  JSONL(权威),否则回退 legacy `<id>.json`。 */
export const SESSION_JSONL_EXT = ".jsonl";

/** session header record(D2 元数据)。字段镜像 SessionFileV1 减去
 *  messages;optional 字段缺席即省略(spread-discipline)。`messageCreatedAt`
 *  is declared here (despite not being a SessionHeaderRecord-native field
 *  by intent) because the header line is built via `JSON.stringify({
 *  type:"session", ...file_minus_messages })` after a stamped save — the
 *  array carries through to disk and back, so load() must accept it as part
 *  of the header shape. projectSessionLog strips it on the no-stamp branch
 *  so a stale header cannot poison the picker with misaligned timestamps. */
export interface SessionHeaderRecord {
  readonly type: "session";
  readonly schemaVersion: number;
  readonly conversation_id: string;
  readonly title: string;
  readonly cwd: string;
  readonly sanitized_at: string;
  readonly jsonMode: boolean;
  readonly turnCount: number;
  readonly updatedAt: string;
  readonly checkpoints?: ReadonlyArray<CheckpointRecord>;
  readonly goal?: GoalState;
  readonly workspaceRoot?: string;
  readonly messageCreatedAt?: ReadonlyArray<string | null>;
  /** D2 (tui-display-consistency):assistant 回合思考时长(ms)的并行数组。
   *  与 SessionFileV1.thinkingMs 同 spread-discipline: 缺席合法。 */
  readonly thinkingMs?: ReadonlyArray<number | null>;
}

/** 一条 message 事件:唯一 id + parent 链 + 原生消息原文。`createdAt` 是
 *  appendEvents 写盘时的入账时刻(ISO);optional for 兼容旧 JSONL——
 *  parseSessionJsonl 不做严格校验(spread 纪律),缺席不 fail validation,
 *  投影时落成 messageCreatedAt[i] = null。`thinkingMs` 是 D2 落盘的
 *  assistant 回合思考时长(ms),仅在 assistant 事件上由 appendEvents
 *  conditional spread 挂上;非 assistant / 流式回合无思考 → 字段缺席。 */
export interface SessionEventRecord {
  readonly type: "message";
  readonly id: string;
  readonly parent: string | null;
  readonly message: AnthropicNativeMessage;
  readonly createdAt?: string;
  readonly thinkingMs?: number;
}

/** 落盘的 rewind 头指针;id 为 null 表示空 transcript(空会话)。 */
export interface SessionHeadRecord {
  readonly type: "head";
  readonly id: string | null;
}

export type SessionJsonlRecord =
  SessionHeaderRecord | SessionEventRecord | SessionHeadRecord;

/** parseSessionJsonl / projectSessionLog 抛出的结构化错误(不含
 *  conversation_id —— 纯函数不携带 store 身份,由 store 捕获后补上,
 *  与 sanitizeSessionFile 的 {kind:"schema_invalid", field} 约定一致)。 */
export type SessionJsonlError =
  | { kind: "parse_failed"; reason: string }
  | { kind: "schema_invalid"; field: string };

/** 事件 id 方案:`e<index>`。appendEvents 依赖该形态恢复下一个编号。 */
export function messageEventId(index: number): string {
  return `e${index}`;
}

const EVENT_ID_RE = /^e(\d+)$/;

/** 解析后的 JSONL log:header + 文件序事件 + 生效 head + 最大事件下标。 */
export interface ParsedSessionLog {
  readonly header: SessionHeaderRecord;
  readonly events: ReadonlyArray<SessionEventRecord>;
  readonly head: string | null;
  /** 事件中最大 `e<N>` 的 N;无事件为 -1(appendEvents 从 +1 继续编号)。 */
  readonly maxEventIndex: number;
  /** T5:header 之后的全部记录(event + head),按文件序。save 的
   *  header-refresh 重写依赖它原样保留既有记录(含历史 head 记录)。 */
  readonly records: ReadonlyArray<SessionEventRecord | SessionHeadRecord>;
}

/**
 * Serialize a SessionFileV1 to JSONL text (header + chained events + head).
 * Pure. 未知顶层字段经 spread 进 header 透传;`messages` 不进 header。
 */
export function sessionFileToJsonl(file: SessionFileV1): string {
  const { messages, messageCreatedAt, thinkingMs, ...meta } = file;
  const lines: string[] = [JSON.stringify({ type: "session", ...meta })];
  messages.forEach((message, index) => {
    const stamp = messageCreatedAt?.[index];
    const think = thinkingMs?.[index];
    const record: SessionEventRecord = {
      type: "message",
      id: messageEventId(index),
      parent: index === 0 ? null : messageEventId(index - 1),
      message,
      ...(typeof stamp === "string" ? { createdAt: stamp } : {}),
      // D2: thinkingMs 仅在 assistant 事件上挂值(消费者侧 ?? undefined 兜底
      // 已经为非 assistant 元素填 null,但为避免噪声,只在有值时挂 key)。
      ...(typeof think === "number" && Number.isFinite(think) && think > 0
        ? { thinkingMs: think }
        : {}),
    };
    lines.push(JSON.stringify(record));
  });
  const head: SessionHeadRecord = {
    type: "head",
    id: messages.length === 0 ? null : messageEventId(messages.length - 1),
  };
  lines.push(JSON.stringify(head));
  return `${lines.join("\n")}\n`;
}

/**
 * Parse JSONL text into a structured log. Pure, no IO.
 *
 * Corrupt-tail EXIT `drop-trailing-corrupt-line`:仅当最后一个非空行
 * JSON.parse 失败时丢弃该行(崩溃半截 append);其余行损坏 →
 * throw {kind:"parse_failed"}。形状错误 → throw {kind:"schema_invalid"}:
 *   - 首记录不是 session header → field "root"
 *   - 未知 record type → field "type"
 *   - 事件形状 / id 形态 / 重复 id / parent 未先出现 → field "events"
 *   - head 引用未知事件 id → field "head"
 */
export function parseSessionJsonl(raw: string): ParsedSessionLog {
  const lines = raw.split("\n");
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) lastNonEmpty = i;
  }
  const records: unknown[] = [];
  for (let i = 0; i <= lastNonEmpty; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Named EXIT: drop-trailing-corrupt-line — 崩溃只可能在 append 尾部
      // 留下半截行;丢掉它,前面的 log 仍完整。
      if (i === lastNonEmpty) break;
      throw {
        kind: "parse_failed",
        reason: `line ${i + 1}: ${line.slice(0, 120)}`,
      } satisfies SessionJsonlError;
    }
  }
  const [first, ...rest] = records;
  if (!isHeaderRecord(first)) {
    throw { kind: "schema_invalid", field: "root" } satisfies SessionJsonlError;
  }
  const events: SessionEventRecord[] = [];
  const tail: Array<SessionEventRecord | SessionHeadRecord> = [];
  const ids = new Set<string>();
  let head: string | null = null;
  let headSeen = false;
  let maxEventIndex = -1;
  for (const rec of rest) {
    if (isEventRecord(rec)) {
      const match = EVENT_ID_RE.exec(rec.id);
      if (match === null || ids.has(rec.id)) {
        throw {
          kind: "schema_invalid",
          field: "events",
        } satisfies SessionJsonlError;
      }
      // append-only 不变式:parent 必须先于子事件出现(崩溃尾部丢弃后
      // 仍成立 —— 被引用的 parent 一定在更早的行)。
      if (rec.parent !== null && !ids.has(rec.parent)) {
        throw {
          kind: "schema_invalid",
          field: "events",
        } satisfies SessionJsonlError;
      }
      ids.add(rec.id);
      maxEventIndex = Math.max(maxEventIndex, Number(match[1]));
      events.push(rec);
      tail.push(rec);
      continue;
    }
    if (isHeadRecord(rec)) {
      head = rec.id; // 最后一条 head record 生效
      headSeen = true;
      tail.push(rec);
      continue;
    }
    throw { kind: "schema_invalid", field: "type" } satisfies SessionJsonlError;
  }
  if (!headSeen) {
    head = events.length === 0 ? null : events[events.length - 1]!.id;
  }
  if (head !== null && !ids.has(head)) {
    throw { kind: "schema_invalid", field: "head" } satisfies SessionJsonlError;
  }
  return { header: first, events, head, maxEventIndex, records: tail };
}

/**
 * Project a parsed log to the current-head transcript as SessionFileV1.
 * 从 head 沿 parent 走回根再反转;不在链上的事件(fork 分支 / 孤儿)留在
 * 盘上但不进投影。元数据校验复用 sanitizeSessionFile(schema SSOT)。
 * Pure.
 */
export function projectSessionLog(log: ParsedSessionLog): SessionFileV1 {
  const byId = new Map(log.events.map((e) => [e.id, e]));
  const messages: AnthropicNativeMessage[] = [];
  const createdAtList: Array<string | null> = [];
  // D2 (tui-display-consistency):并行重建 thinkingMs 数组 —— 与
  // createdAtList 同 spread-discipline 纪律(全链无 thinkingMs → 不挂 key)。
  const thinkingMsList: Array<number | null> = [];
  const seen = new Set<string>();
  let cur = log.head;
  while (cur !== null) {
    if (seen.has(cur)) {
      // 防御:append-only + parent-先现 不变式下不可能成环;成环即真损坏。
      throw {
        kind: "schema_invalid",
        field: "events",
      } satisfies SessionJsonlError;
    }
    seen.add(cur);
    const event = byId.get(cur);
    if (!event) {
      throw {
        kind: "schema_invalid",
        field: "head",
      } satisfies SessionJsonlError;
    }
    messages.push(event.message);
    // `event.createdAt` is `string | undefined` in-memory; coerce the hole to
    // `null` so the parallel array matches the on-disk JSON shape (undefined
    // would serialize to null via JSON.stringify anyway). Validator accepts
    // only `null` holes — never `undefined`.
    createdAtList.push(event.createdAt ?? null);
    // D2: `event.thinkingMs` 是 `number | undefined` in-memory(appendEvents
    // 仅在 assistant + thinkingMs 有效时挂上)。事件无 thinkingMs → 填 null
    // (与 JSON round-trip 形态对齐);number → 原样透传(appendEvents 入口已
    // 过滤 ≤ 0 / 非有限数,此处不再校验)。
    thinkingMsList.push(
      typeof event.thinkingMs === "number" ? event.thinkingMs : null
    );
    cur = event.parent;
  }
  messages.reverse();
  createdAtList.reverse();
  thinkingMsList.reverse();
  const { type: _type, ...meta } = log.header;
  // spread-discipline: 全链都无 createdAt(纯旧文件 / 未经过 appendEvents
  // stamping 的 fork 旧分支)时省略 key,与 sanitize.ts 的 conditional-goal-
  // key 纪律一致(never emit `field: undefined` keys)。这样旧文件
  // sessionFileToJsonl → parseSessionJsonl → projectSessionLog 整对象
  // round-trip 字节不变(既有 deepEqual 测试锚定契约)。任一事件带
  // createdAt → 发 key,数组内 null 元素来自该位置事件无 createdAt
  // (旧链 / fork 旧分支),picker 用 ?? "" 兜底渲染。
  const hasAny = createdAtList.some((c) => c !== null);
  // Stale-header guard (#622 review-fix Medium): when the current head chain
  // carries no createdAt (rewind back into a pre-stamping fork branch, or a
  // legacy chain), a previously-stamped save left the header's
  // messageCreatedAt at its OLD length. Spread via `...meta` would leak that
  // stale array into the projection — picker joins index-by-index and would
  // read misaligned timestamps. Mirror `sanitizeSessionFile`'s `delete
  // result["summary"]` posture: drop the key explicitly when there's nothing
  // to emit. When `hasAny === true` the explicit `messageCreatedAt:` in the
  // result literal below overrides any stale value in `meta`.
  if (!hasAny) {
    delete meta.messageCreatedAt;
  }
  // D2 (tui-display-consistency):thinkingMs 与 messageCreatedAt 完全镜像的
  // spread-discipline —— 全链均无 thinkingMs 时不挂 key,任一事件带值则发
  // key,数组内 null 元素 = 该位置事件无 thinkingMs(非 assistant / 流式回合
  // 无思考 / legacy 文件)。同 stale-header guard:全链无 thinkingMs 时显式
  // 从 meta 删除,避免 picker 读到错位数组。
  const hasAnyThinking = thinkingMsList.some((c) => c !== null);
  if (!hasAnyThinking) {
    delete meta.thinkingMs;
  }
  return sanitizeSessionFile({
    ...meta,
    messages,
    ...(hasAny ? { messageCreatedAt: createdAtList } : {}),
    ...(hasAnyThinking ? { thinkingMs: thinkingMsList } : {}),
  });
}

/**
 * T5: the current-head chain as EVENTS, root → head order (the same walk
 * projectSessionLog does, but keeping id/parent). Fork branches / orphans
 * are not included. Throws schema_invalid on a cycle or a dangling head,
 * same as projectSessionLog. Pure.
 */
export function headChainEvents(
  log: ParsedSessionLog
): ReadonlyArray<SessionEventRecord> {
  return chainFromHead(log, log.head);
}

/**
 * Ancestor chain from an arbitrary head id (null = empty). Rewind to a
 * skipped-branch user message walks this, not the current head prefix.
 * Throws schema_invalid on a cycle or dangling id. Pure.
 */
export function chainFromHead(
  log: ParsedSessionLog,
  head: string | null
): ReadonlyArray<SessionEventRecord> {
  const byId = new Map(log.events.map((e) => [e.id, e]));
  const chain: SessionEventRecord[] = [];
  const seen = new Set<string>();
  let cur = head;
  while (cur !== null) {
    if (seen.has(cur)) {
      throw {
        kind: "schema_invalid",
        field: "events",
      } satisfies SessionJsonlError;
    }
    seen.add(cur);
    const event = byId.get(cur);
    if (!event) {
      throw {
        kind: "schema_invalid",
        field: "head",
      } satisfies SessionJsonlError;
    }
    chain.push(event);
    cur = event.parent;
  }
  chain.reverse();
  return chain;
}

/**
 * T5: serialize a header + record list back to JSONL text (one record per
 * line, trailing newline). The header is built from SessionFileV1 metadata
 * (spread-preserve, minus messages); records pass through verbatim — the
 * append-only save relies on this to keep existing event/head records
 * byte-stable across a header refresh. Pure.
 */
export function serializeSessionLog(
  file: Omit<SessionFileV1, "messages">,
  records: ReadonlyArray<SessionEventRecord | SessionHeadRecord>
): string {
  const lines: string[] = [JSON.stringify({ type: "session", ...file })];
  for (const record of records) {
    lines.push(JSON.stringify(record));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * T5: structural deep-equal over JSON-shaped values (message content blocks
 * included). Used by the append-only save to align the caller's projection
 * with the persisted head chain. Treats absent vs undefined as equal only
 * when the key is absent in BOTH (plain JSON semantics); arrays are
 * order-sensitive. Pure.
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, key)) return false;
    if (!jsonDeepEqual(ao[key], bo[key])) return false;
  }
  return true;
}

// -- record shape guards -------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isHeaderRecord(value: unknown): value is SessionHeaderRecord {
  return isRecord(value) && value["type"] === "session";
}

function isEventRecord(value: unknown): value is SessionEventRecord {
  return (
    isRecord(value) &&
    value["type"] === "message" &&
    typeof value["id"] === "string" &&
    (value["parent"] === null || typeof value["parent"] === "string") &&
    isRecord(value["message"])
  );
}

function isHeadRecord(value: unknown): value is SessionHeadRecord {
  return (
    isRecord(value) &&
    value["type"] === "head" &&
    (value["id"] === null || typeof value["id"] === "string")
  );
}
