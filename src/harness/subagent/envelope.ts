/**
 * #356 subagent JSON envelope — 父↔子 进程间信封 schema 冻结落点 (D1)。
 *
 * 两个方向的信封:
 *   - 父→子 worker 请求 (parseWorkerEnvelope):
 *       { task, systemPrompt?, disallowedTools?, model?, maxTurns?, timeoutMs?,
 *         sandboxRoot, env? }
 *   - 子→父 result (parseParentEnvelope / truncateEnvelopeResult):
 *       { status: "ok"|"failed", summary, result, fileRefs?, usage?, reason?,
 *         truncated?, totalLength? }
 *
 * 校验规则 (SC13 / plan D1 acceptance 3):
 *   - 缺必填字段 / wrong type / 非对象 → throw ProtocolError (协议错误);
 *   - 收尾 newline 先 trim 再 parse;多条 newline 按首条独立 JSON parse
 *     (第二条独立 JSON 被忽略,取首条);
 *   - ajv 实例与仓库同款 strict 配置 (同 src/harness/tools/registry.ts
 *     makeAjv),不引入第二份配置差异。
 *
 * 浓缩截断 (SC10 / spec 假设 17): result > 20000 chars 在 worker emit 前
 * 截断并合成标记,父代理只收已截断 envelope。
 */
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { ProtocolError } from "../errors.js";

/** 父→子 worker 请求信封。schema 冻结形态见 WORKER_SCHEMA。 */
export interface WorkerEnvelope {
  readonly task: string;
  readonly systemPrompt?: string;
  readonly disallowedTools?: readonly string[];
  readonly model?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly sandboxRoot: string;
  readonly env?: Readonly<Record<string, unknown>>;
}

/** 子→父 result 信封。schema 冻结形态见 PARENT_SCHEMA。 */
export interface SubAgentEnvelope {
  readonly status: "ok" | "failed";
  readonly summary: string;
  readonly result: string;
  readonly fileRefs?: readonly string[];
  /** 子代理 run 的 usage 快照 (TokenUsage 形态, JSON 可序列化; 与 schema `usage?: object` 对齐)。 */
  readonly usage?: object;
  readonly reason?:
    "crashed" | "maxTurnsExceeded" | "timeout" | "protocolError";
  readonly truncated?: boolean;
  readonly totalLength?: number;
}

const TRUNCATION_LIMIT = 20000;
const TRUNCATION_MARKER = (total: number) =>
  `[...truncated to 20000 chars; total ${total}]`;

/**
 * 仓库同款 ajv 配置: strict: true + ajv-formats (同
 * src/harness/tools/registry.ts makeAjv)。D1 探针与 envelope.ts 共用同一份配置。
 */
export function makeEnvelopeAjv(): Ajv.default {
  const ajv = new Ajv.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  return ajv;
}

/** 父→子 worker 请求 schema (D1 冻结,探针与 product 同源)。 */
export const WORKER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    task: { type: "string" },
    systemPrompt: { type: "string" },
    disallowedTools: { type: "array", items: { type: "string" } },
    model: { type: "string" },
    maxTurns: { type: "integer", minimum: 1 },
    timeoutMs: { type: "integer", minimum: 1 },
    sandboxRoot: { type: "string" },
    env: { type: "object" },
  },
  required: ["task", "sandboxRoot"],
  additionalProperties: false,
};

/** 子→父 result envelope schema (D1 冻结,探针与 product 同源)。 */
export const PARENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    summary: { type: "string" },
    result: { type: "string" },
    fileRefs: { type: "array", items: { type: "string" } },
    usage: { type: "object" },
    reason: {
      type: "string",
      enum: ["crashed", "maxTurnsExceeded", "timeout", "protocolError"],
    },
    truncated: { type: "boolean" },
    totalLength: { type: "integer" },
  },
  required: ["status", "summary", "result"],
  additionalProperties: false,
};

function compileEnvelopeAjv(schema: Record<string, unknown>): ValidateFunction {
  return makeEnvelopeAjv().compile(schema);
}

/**
 * 解析 + 校验父→子 worker 请求信封。
 *
 * 失败模式 (全部 throw ProtocolError,SC13):
 *   - 输入非对象 (裸字符串 / 数组 / null) → throw;
 *   - 缺必填字段 (task / sandboxRoot) → throw;
 *   - wrong type (如 task: 123) → throw。
 *
 * 收尾 newline 先 trim 再 parse;多条 newline 时按首条独立 JSON parse
 * (plan D1 acceptance 3 形态,第二条独立 JSON 被忽略)。
 */
export function parseWorkerEnvelope(input: string): WorkerEnvelope {
  return parseEnvelope(input, "worker") as WorkerEnvelope;
}

/**
 * 解析 + 校验子→父 result 信封。失败模式同 parseWorkerEnvelope。
 */
export function parseParentEnvelope(input: string): SubAgentEnvelope {
  return parseEnvelope(input, "parent") as SubAgentEnvelope;
}

function parseEnvelope(input: string, direction: "worker" | "parent"): unknown {
  const validate = direction === "worker" ? workerValidate : parentValidate;
  // 协议 = 一条 envelope 一行 (newline-JSON)。输入含多条 newline 时按首条独立
  // JSON parse (第二条独立 JSON 被忽略,plan D1 acceptance 3 形态);
  // 收尾 newline 由首行截取 + trim 消化。
  const firstLine = input.split("\n", 1)[0] ?? "";
  const trimmed = firstLine.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new ProtocolError(
      `subagent envelope parse failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProtocolError(
      `subagent ${direction} envelope: expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`
    );
  }
  if (!validate(parsed)) {
    throw new ProtocolError(
      `subagent ${direction} envelope validation failed: ${JSON.stringify(validate.errors ?? [])}`
    );
  }
  return parsed;
}

/**
 * 浓缩截断 (SC10 / spec 假设 17): result > 20000 chars 时截断为
 * `[...truncated to 20000 chars; total NNNN]` (无中间字符),置 truncated /
 * totalLength;未超时原样返回 (不改字段)。
 */
export function truncateEnvelopeResult(
  env: SubAgentEnvelope
): SubAgentEnvelope {
  if (env.result.length <= TRUNCATION_LIMIT) {
    return env;
  }
  return {
    ...env,
    result: TRUNCATION_MARKER(env.result.length),
    truncated: true,
    totalLength: env.result.length,
  };
}

const workerValidate = compileEnvelopeAjv(WORKER_SCHEMA);
const parentValidate = compileEnvelopeAjv(PARENT_SCHEMA);
