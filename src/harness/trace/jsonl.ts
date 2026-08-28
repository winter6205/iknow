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

import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createOutputMask, currentSecretValues } from "../sandbox/index.js";
import {
  maybeRotate,
  type TraceRotationOptions,
} from "./rotation.js";
import type {
  TraceService,
  LlmCallRecord,
  ToolCallRecord,
  TurnRecord,
  SessionRecord,
  SandboxCmdRecord,
  VerificationRecord,
  GoalRecord,
  SubagentSpawnRecord,
  SubagentStopRecord,
  SubagentStateChangeRecord,
  SubagentStepRecord,
} from "./types.js";

export interface JsonlTraceOptions {
  /**
   * trace 目录 (绝对或相对 CWD)。
   * T2 每会话独立文件: 实际写入 <filePath>/<conversationId>.jsonl,
   * 目录不存在时 mkdirSync recursive 创建 (ADR-0003 D4: conversation_id 仍实例绑定)。
   */
  filePath: string;
  /** 实例绑定的 conversation_id, 每条记录都写入 (ADR Decision 4)。 */
  conversationId: string;
  /** 可选注入 writer (测试用 always-throw writer)。 */
  writer?: (line: string) => void;
  /** Rotation caps; omitted values use the conservative defaults. */
  rotation?: TraceRotationOptions;
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

/**
 * SC20 follow-up: mask known secret values in the serialized JSONL line.
 *
 * This is intentionally coarse — we serialize the entire line, mask the
 * resulting string with the current secret values, and emit the masked
 * string. The mask is built once per factory call (cheap) and re-used
 * across all record writes for this TraceService instance. If the env
 * changes mid-run (rare; CLI products don't mutate env mid-run), the mask
 * is stale until the next createJsonlTraceService call. SC20 spec left a
 * single-serializer-point mask as the preferred wiring; this is it.
 */
export function createJsonlTraceService(
  options: JsonlTraceOptions
): TraceService {
  const { filePath, conversationId } = options;
  maybeRotate(filePath, options.rotation);
  const outputMask = createOutputMask(currentSecretValues());
  // T2 每会话独立文件: filePath 是目录, 实际写 <filePath>/<conversationId>.jsonl。
  // mkdirSync recursive 兜底, 目录不存在时先建 (产品路径 traceOut 首次使用时目录
  // 可能未建)。仅默认 writer 时建目录 —— 注入自定义 writer (测试用 always-throw)
  // 时调用方掌控写盘, 目录创建由调用方负责, 不在工厂内强加 IO 副作用。
  const sessionFile = join(filePath, `${conversationId}.jsonl`);
  // mkdir 延迟到首次写入: 构造期不做 IO —— 目标路径被同名文件占据等失败由
  // recordXxx 的 try/catch warn-once 兜底 (ADR-0003 D13), 不在构造时抛错打挂 turn。
  let dirReady = false;
  const writer: (line: string) => void =
    options.writer ??
    ((line: string): void => {
      if (!dirReady) {
        mkdirSync(filePath, { recursive: true });
        dirReady = true;
      }
      appendFileSync(sessionFile, line + "\n", "utf8");
    });

  // 实例级去重: 首次写盘失败 warn 一次, 后续静默 (ADR Decision 13)。
  let warnedOnce = false;

  function warnOnce(err: unknown): void {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn("[JsonlTraceService] write failed:", err);
    }
  }

  function writeLine(payload: Record<string, unknown>): void {
    writer(outputMask.mask(JSON.stringify(payload)));
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
        writeLine(line);
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
        writeLine(line);
        return id;
      } catch (err) {
        warnOnce(err);
        return undefined;
      }
    },

    async recordTurn(record: TurnRecord): Promise<string | undefined> {
      // 调用方预生成的 id 优先 (F-4: 子代理埋点要在回合末尾之前就知道 turn id);
      // 缺席时退回实现生成。id 键从 snake 副本剔除, 单一载体仍是 turn_id
      // (与 recordVerification / recordGoal 同形态)。
      const id = record.id ?? randomUUID();
      const snake = toSnakeCaseRecord(record);
      delete snake.id;
      const line: Record<string, unknown> = {
        conversation_id: conversationId,
        record_type: "turn",
        turn_id: id,
        ...snake,
      };
      try {
        writeLine(line);
        return id;
      } catch (err) {
        warnOnce(err);
        return undefined;
      }
    },

    async recordSession(record: SessionRecord): Promise<string | undefined> {
      const id = randomUUID();
      const line: Record<string, unknown> = {
        conversation_id: conversationId,
        record_type: "session",
        session_id: id,
        ...toSnakeCaseRecord(record),
      };
      try {
        writeLine(line);
        return id;
      } catch (err) {
        warnOnce(err);
        return undefined;
      }
    },

    async recordSandboxCmd(
      record: SandboxCmdRecord
    ): Promise<string | undefined> {
      const id = randomUUID();
      const line: Record<string, unknown> = {
        conversation_id: conversationId,
        record_type: "sandbox_cmd",
        sandbox_cmd_id: id,
        ...toSnakeCaseRecord(record),
      };
      try {
        writeLine(line);
        return id;
      } catch (err) {
        warnOnce(err);
        return undefined;
      }
    },

    async recordVerification(
      record: VerificationRecord
    ): Promise<string | undefined> {
      // 与既有 record 的差异: id 由调用方提供, 不做 randomUUID 生成。
      // 单 id 载体对齐既有模式: 顶层 verification_id 承载 id, 其余顶层 key
      // 走 toSnakeCaseRecord; 从 snake 副本剔除原 id key, 避免重复落盘。
      const snake = toSnakeCaseRecord(record);
      delete snake.id;
      const line: Record<string, unknown> = {
        conversation_id: conversationId,
        record_type: "verification",
        verification_id: record.id,
        ...snake,
      };
      try {
        writeLine(line);
        return record.id;
      } catch (err) {
        warnOnce(err);
        return undefined;
      }
    },

    async recordGoal(record: GoalRecord): Promise<string | undefined> {
      // 与 recordVerification 同形态: id 由调用方提供, 不做 randomUUID 生成。
      // 单 id 载体对齐既有模式: 顶层 goal_id 承载 id, 其余顶层 key 走
      // toSnakeCaseRecord; 从 snake 副本剔除原 id key (避免重复落盘)。
      const snake = toSnakeCaseRecord(record);
      delete snake.id;
      // GoalRecord 携带 conversationId 字段, 但 conversation_id 是工厂实例绑定
      // (ADR-0003 D4), 剔除 snake 副本里的 conversation_id 保证工厂 binding 胜出,
      // 与 record 内冗余 conversationId 字段 (调用方透传) 语义对齐。
      delete snake.conversation_id;
      const line: Record<string, unknown> = {
        conversation_id: conversationId,
        record_type: "goal",
        goal_id: record.id,
        ...snake,
      };
      try {
        writeLine(line);
        return record.id;
      } catch (err) {
        warnOnce(err);
        return undefined;
      }
    },

    // ─── #358 T4 — 子代理生命周期三类事件 ────────────────────────────────
    // 与 recordVerification / recordGoal 同形态: id 由调用方提供 = manager
    // taskId; 实现不做 randomUUID 生成。顶层 subagent_id 承载 id, 其余
    // 顶层 key 走 toSnakeCaseRecord; 从 snake 副本剔除原 id key, 避免
    // 重复落盘。Postel: 可选字段仅有可填来源时存在 (manager 埋点遵守)。
    // ADR-0003 D13: 失败返回 undefined, 不抛。

    async recordSubagentSpawn(
      record: SubagentSpawnRecord
    ): Promise<string | undefined> {
      const snake = toSnakeCaseRecord(record);
      delete snake.id;
      const line: Record<string, unknown> = {
        conversation_id: conversationId,
        record_type: "subagent_spawn",
        subagent_id: record.id,
        ...snake,
      };
      try {
        writeLine(line);
        return record.id;
      } catch (err) {
        warnOnce(err);
        return undefined;
      }
    },

    async recordSubagentStop(
      record: SubagentStopRecord
    ): Promise<string | undefined> {
      const snake = toSnakeCaseRecord(record);
      delete snake.id;
      const line: Record<string, unknown> = {
        conversation_id: conversationId,
        record_type: "subagent_stop",
        subagent_id: record.id,
        ...snake,
      };
      try {
        writeLine(line);
        return record.id;
      } catch (err) {
        warnOnce(err);
        return undefined;
      }
    },

    async recordSubagentStateChange(
      record: SubagentStateChangeRecord
    ): Promise<string | undefined> {
      const snake = toSnakeCaseRecord(record);
      delete snake.id;
      const line: Record<string, unknown> = {
        conversation_id: conversationId,
        record_type: "subagent_state_change",
        subagent_id: record.id,
        ...snake,
      };
      try {
        writeLine(line);
        return record.id;
      } catch (err) {
        warnOnce(err);
        return undefined;
      }
    },

    async recordSubagentStep(
      record: SubagentStepRecord
    ): Promise<string | undefined> {
      // 唯一形态差异: id 载体是 subagent_step_id —— step 的 id 每步唯一,
      // 与前三类 "id === taskId" 的子代理实例 id 语义不同 (types.ts 注释)。
      const snake = toSnakeCaseRecord(record);
      delete snake.id;
      const line: Record<string, unknown> = {
        conversation_id: conversationId,
        record_type: "subagent_step",
        subagent_step_id: record.id,
        ...snake,
      };
      try {
        writeLine(line);
        return record.id;
      } catch (err) {
        warnOnce(err);
        return undefined;
      }
    },
  };
}
