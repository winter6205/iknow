/**
 * JsonlTraceService — JSONL 文件写入实现 (T3, GH #64)。
 *
 * ADR-0003 Decision 5:  ID 由 TraceService 生成 (crypto.randomUUID)。
 * ADR-0003 Decision 8:  camelToSnake 集中在此文件, 只转顶层 schema key,
 *                       不递归进 content payload (messages / arguments / result)。
 * ADR-0003 Decision 11: 同步 append (appendFileSync), 不用 stream。
 * ADR-0003 Decision 12: 不 fsync, 依赖 OS buffer。
 * ADR-0003 Decision 13: recordXxx 内部 try/catch, 失败 console.warn 一次, 返回 undefined。
 * ADR-0003 Decision 14: parentLlmCallId=undefined → JSONL 字面 null (不省略 key)。
 *
 * Gate B 判据 12 守门: 本文件不引入条件式修复层能力 (无自动重试 / 无 checkpoint /
 * 无 token-cost 护栏 / 无外部观测后端导出, B-scope 留位由 observability-bridge 桩负责)。
 */

import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  TraceService,
  LlmCallRecord,
  ToolCallRecord,
  TurnRecord,
} from "./types.js";

export interface JsonlTraceOptions {
  /** JSONL 文件路径 (绝对或相对 CWD)。 */
  filePath: string;
  /** 实例绑定的 conversation_id, 每条记录都写入 (ADR Decision 4)。 */
  conversationId: string;
  /** 可选注入 writer (测试用 always-throw writer)。 */
  writer?: (line: string) => void;
}

/**
 * camelCase → snake_case (ADR Decision 8: 集中在一处)。
 * 只对 record 顶层 schema 字段做 key 转换, 不递归进 content payload。
 */
function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
}

/**
 * 将 record 的顶层 key 转为 snake_case。
 * 值原样透传 (包括嵌套对象 messages / arguments / result / error)。
 */
function toSnakeCaseRecord<T extends object>(
  record: T
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[camelToSnake(key)] = value;
  }
  return out;
}

export function createJsonlTraceService(
  options: JsonlTraceOptions
): TraceService {
  const { filePath, conversationId } = options;
  const writer: (line: string) => void =
    options.writer ??
    ((line: string): void => {
      appendFileSync(filePath, line + "\n", "utf8");
    });

  // 实例级去重: 首次写盘失败 warn 一次, 后续静默 (ADR Decision 13)。
  let warnedOnce = false;

  function warnOnce(err: unknown): void {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn("[JsonlTraceService] write failed:", err);
    }
  }

  return {
    async recordLlmCall(record: LlmCallRecord): Promise<string | undefined> {
      const id = randomUUID();
      const line: Record<string, unknown> = {
        conversation_id: conversationId,
        record_type: "llm_call",
        llm_call_id: id,
        ...toSnakeCaseRecord(record),
      };
      try {
        writer(JSON.stringify(line));
        return id;
      } catch (err) {
        warnOnce(err);
        return undefined;
      }
    },

    async recordToolCall(record: ToolCallRecord): Promise<string | undefined> {
      const id = randomUUID();
      const snake = toSnakeCaseRecord(record);
      // ADR Decision 14: undefined → 字面 null, 不省略 key。
      // JSON.stringify 会省略 undefined 值, 所以必须显式 ?? null。
      snake.parent_llm_call_id = record.parentLlmCallId ?? null;
      const line: Record<string, unknown> = {
        conversation_id: conversationId,
        record_type: "tool_call",
        tool_call_id: id,
        ...snake,
      };
      try {
        writer(JSON.stringify(line));
        return id;
      } catch (err) {
        warnOnce(err);
        return undefined;
      }
    },

    async recordTurn(record: TurnRecord): Promise<string | undefined> {
      const id = randomUUID();
      const line: Record<string, unknown> = {
        conversation_id: conversationId,
        record_type: "turn",
        turn_id: id,
        ...toSnakeCaseRecord(record),
      };
      try {
        writer(JSON.stringify(line));
        return id;
      } catch (err) {
        warnOnce(err);
        return undefined;
      }
    },
  };
}
