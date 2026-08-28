/**
 * #356 subagent JSON envelope — 父↔子 进程间信封 schema 冻结落点 (D1)。
 *
 * 两个方向的信封:
 *   - 父→子 worker 请求 (parseWorkerEnvelope):
 *       { task, systemPrompt?, disallowedTools?, model?, maxTurns?, timeoutMs?,
 *         sandboxRoot, env?, role?, finalText?, evidenceContext? }
 *   - 子→父 result (parseParentEnvelope / truncateEnvelopeResult):
 *       { status: "ok"|"failed", summary, result, fileRefs?, usage?, reason?,
 *         stop_reason?, truncated?, totalLength? }
 *
 * 校验规则 (SC13 / plan D1 acceptance 3):
 *   - 缺必填字段 / wrong type / 非对象 → throw ProtocolError (协议错误);
 *   - 收尾 newline 先 trim 再 parse;多条 newline 按首条独立 JSON parse
 *     (第二条独立 JSON 被忽略,取首条);
 *   - ajv 实例与仓库同款 strict 配置 (同 src/harness/tools/registry.ts
 *     makeAjv),不引入第二份配置差异。
 *
 * 父可见投影 (T5): 长终稿不作为父代理交差正文。超过上限时只保留短摘要、
 * 改过的路径、停因与「汇报已收束」标记；status/reason 不因汇报折叠而改变。
 */
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { ProtocolError } from "../errors.js";
import type { StopReason } from "../model-adapter/types.js";

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
  /**
   * #556 T2: 来自 SubAgentDefinition.role 的 wire-additive 字段。worker 装配
   * 期查 catalog 取 body 注入 persona 段 (T2 acceptance); 缺省 / 未知 →
   * V1 baseline (defense-in-depth fallback, 详见 worker.ts + plan T2)。
   */
  readonly role?: string;
  /**
   * Host truncated dialogue (judge). Independent of `task`.
   */
  readonly finalText?: string;
  /**
   * Evidence prompt object (judge). Independent of `task`.
   */
  readonly evidenceContext?: object;
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
  /**
   * D-α 观测地板 (additive):子代理 run() 的实际停因,来源
   * `RunResult.stopReason`(loop-engine 八值 append-only 联合)。
   *
   * 与 `reason` 语义不同,**不合并**:`reason` 是父代理侧的失败归因四值枚举
   * (crashed / maxTurnsExceeded / timeout / protocolError),`stop_reason` 是
   * 子代理循环自身的停止原因(含 completed 等成功停因)。status / reason 两个
   * 枚举维持 V1 冻结形态(envelope-freeze.test.ts 锁定)。
   *
   * TS 侧直接复用 `StopReason`(唯一声明点,联合追加值时零漂移);wire schema
   * 侧刻意**不冻 enum**(见 PARENT_SCHEMA 注释)。缺席 = 该信封不是从一次
   * run() 返回值派生的(如 MaxTurnsExceeded 抛出路径),不可猜测。
   */
  readonly stop_reason?: StopReason;
  readonly truncated?: boolean;
  readonly totalLength?: number;
}

const TRUNCATION_LIMIT = 20000;
const SUMMARY_LIMIT = 2000;
const TRUNCATION_MARKER = (total: number) =>
  `[report folded; total ${total} chars]`;

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
    role: { type: "string" },
    finalText: { type: "string" },
    evidenceContext: { type: "object" },
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
    // D-α 观测地板 (additive): 子代理 run() 的实际停因。
    // `additionalProperties: false` 下新字段必须显式声明, 否则 ajv 直接把带
    // stop_reason 的信封判成 ProtocolError。
    //
    // 刻意**无 enum**: `StopReason` 是 append-only 联合 (016 五值 → 017 两值
    // → #672 fused), 把当前八值冻进 wire schema 意味着每次追加停因都要同步改
    // 两处、且旧 parent 会拒收新 worker 的合法信封。status / reason 两个枚举
    // 之所以冻, 是因为它们是父代理的**判定面** (V1 冻结契约 SC9); stop_reason
    // 只是观测面, 不参与任何分支判定, 因此按 Postel 收宽。
    stop_reason: { type: "string" },
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

function shortSummary(summary: string, result: string): string {
  const source = summary.length > 0 ? summary : result;
  return source.length > SUMMARY_LIMIT
    ? `${source.slice(0, SUMMARY_LIMIT)}…`
    : source;
}

function failedSummary(env: SubAgentEnvelope): string {
  return env.reason === undefined
    ? "subagent failed"
    : `subagent failed: ${env.reason}`;
}

function shortHandoff(
  summary: string,
  fileRefs: readonly string[] | undefined,
  stopReason: StopReason | undefined
): string {
  const sections = [summary];
  if (fileRefs !== undefined && fileRefs.length > 0) {
    sections.push(
      `Changed files:\n${fileRefs.map((fileRef) => `- ${fileRef}`).join("\n")}`
    );
  }
  if (stopReason !== undefined) {
    sections.push(`Stop reason: ${stopReason}`);
  }
  return sections.filter((section) => section.length > 0).join("\n\n");
}

/**
 * 父可见投影 (T5 / SC10): result > 20000 chars 时，不把终稿全文继续向上
 * 传递，而是合成短交差。result 保留摘要、路径和停因的可读副本，字段
 * `fileRefs` / `stop_reason` 仍作为结构化真值保留。
 *
 * `truncated` 表示汇报正文已收束，不表示任务失败；因此始终保留原 status
 * 与 reason。未超限的 envelope 保持对象与字段不变，避免无关路径漂移。
 */
export function truncateEnvelopeResult(
  env: SubAgentEnvelope
): SubAgentEnvelope {
  if (env.result.length <= TRUNCATION_LIMIT) {
    if (
      env.status === "failed" &&
      env.summary.length === 0 &&
      env.reason !== "timeout"
    ) {
      return { ...env, summary: failedSummary(env) };
    }
    return env;
  }
  const summary =
    env.status === "failed" &&
    env.summary.length === 0 &&
    env.reason !== "timeout"
      ? failedSummary(env)
      : shortSummary(env.summary, env.result);
  const handoff = shortHandoff(summary, env.fileRefs, env.stop_reason);
  const marker = TRUNCATION_MARKER(env.result.length);
  const separator = handoff.length > 0 ? "\n\n" : "";
  const available = TRUNCATION_LIMIT - marker.length - separator.length;
  const boundedHandoff =
    handoff.length <= available
      ? handoff
      : `${handoff.slice(0, Math.max(0, available - 1))}…`;
  return {
    ...env,
    summary,
    result: `${boundedHandoff}${separator}${marker}`,
    truncated: true,
    totalLength: env.result.length,
  };
}

const workerValidate = compileEnvelopeAjv(WORKER_SCHEMA);
const parentValidate = compileEnvelopeAjv(PARENT_SCHEMA);
