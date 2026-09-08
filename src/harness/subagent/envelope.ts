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
 * 父可见投影 (T5): 父代理交差正文是短摘要、路径与停因，不是终稿全文。
 * 原文长于交差或超过 20000 字时置 truncated（汇报已收束）；status/reason 不变。
 */
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { ProtocolError } from "../errors.js";
import type { StopReason } from "../model-adapter/types.js";
import type { WriteSituation } from "../session-roots.js";

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
  /**
   * T6 (plans/write-situation-disclosure.md) — 写处境三态，由 spawn 期
   * `manager.buildWorkerPayload` 调用 `writeSituation(isolationOn, resolved)`
   * 算好后透传（ADR-0069 D2）。worker prior (`priorMessagesFromEnvelope`)
   * 据此渲染写根段：
   *   - `writable_main` / `writable_tree` → ①/② 文案（与改造前逐字节相等）；
   *   - `no_writable_root` → ③ 态披露（不点名建树工具，不嵌入沙箱根）；
   *   - 缺省（**legacy envelope** —— 跨版本 resume / 旧 worker bootstrap）→
   *     typed skip（spec OQ1 采纳 (b)），不注入写根段，不回落旧文案。
   *
   * Wire additive + optional —— 与 `role` 同形态;旧 envelope（无此字段）
   * 仍可被 ajv 接受，**不破现有契约**（`additionalProperties:false` 下需
   * 在 WORKER_SCHEMA.properties 显式声明）。
   */
  readonly writeSituation?: WriteSituation;
  /**
   * T5 (plans/session-folder-consolidation.md / SC8 + L2): 该 worker 的
   * taskId (parent spawn 时 manager.randomUUID() 锁定)。traceFilePath 配
   * 对使用 —— worker file-mode 落该路径 + conversationId=taskId,代替
   * L2 假 scope `randomUUID()`(已退役)。缺席 → 走 IKNOW_TRACE_OUT 退路。
   * Wire additive + optional —— 与 `role` 同形态;旧 envelope / 跨版本 resume
   * 仍 ajv 接受,worker 不退化(`additionalProperties:false` 下需在
   * WORKER_SCHEMA.properties 显式声明)。
   */
  readonly taskId?: string;
  /**
   * T5 (plans/session-folder-consolidation.md / SC8 + L2): worker 进程内
   * JsonlTraceService 的 file mode 锚点,由 spawn 期 `manager.buildWorkerPayload`
   * 算好后透传(父进程已经替这个 taskId 建好 `<父会话文件夹>/subagents/agent-<taskId>.jsonl`)。
   * worker 拿这个文件路径 + 对应 taskId 直接创 file-mode JsonlTraceService,
   * 不再走 `randomUUID()` L2 假 scope(已退役,per-agent 形态优先)。
   * Wire additive + optional —— 与 `role` 同形态;旧 envelope / 跨版本 resume →
   * 缺席,worker 退化到既有 IKNOW_TRACE_OUT / defaultTraceDir 形态(byte-stable)。
   */
  readonly traceFilePath?: string;
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
/** Parent-visible summary cap (handoff + crashed stderr tail). */
export const SUMMARY_LIMIT = 2000;
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
    // T6: 写处境三态 —— 与 role 同形态（wire additive, optional）。
    // 枚举值锁进 wire schema（与 status / reason 同 — 是判定面）；
    // 旧 envelope（缺此字段）→ ajv 接受 → worker typed skip。
    writeSituation: {
      type: "string",
      enum: ["writable_main", "writable_tree", "no_writable_root"],
    },
    // T5: taskId —— 与 role 同形态（wire additive, optional）。
    // 不锁格式（uuid 形态由调用方决定，无 SSOT 枚举）。
    // 旧 envelope / 跨版本 resume → 缺省 → worker 走 IKNOW_TRACE_OUT 退路。
    taskId: { type: "string" },
    // T5: traceFilePath —— 与 role 同形态（wire additive, optional）。
    // 字符串路径，不锁 enum（路径形态由调用方决定，无 SSOT 枚举）。
    // 旧 envelope / 跨版本 resume → 缺省 → worker 走 IKNOW_TRACE_OUT 退路。
    traceFilePath: { type: "string" },
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
 * 父可见投影：给父模型看的交差层（短摘要 + 路径 + 停因），不是终稿全文。
 * `truncated` 在原文长于交差或超过 20000 字时为真（汇报收束，不是任务失败）。
 */
export function projectParentVisibleEnvelope(
  env: SubAgentEnvelope
): SubAgentEnvelope {
  const summary =
    env.status === "failed" &&
    env.summary.length === 0 &&
    env.reason !== "timeout"
      ? failedSummary(env)
      : shortSummary(env.summary, env.result);
  const handoff = shortHandoff(summary, env.fileRefs, env.stop_reason);
  const originalLen = env.result.length;
  const needsFoldMarker = originalLen > TRUNCATION_LIMIT;
  let result = handoff;
  if (needsFoldMarker) {
    const marker = TRUNCATION_MARKER(originalLen);
    const separator = handoff.length > 0 ? "\n\n" : "";
    const available = TRUNCATION_LIMIT - marker.length - separator.length;
    const boundedHandoff =
      handoff.length <= available
        ? handoff
        : `${handoff.slice(0, Math.max(0, available - 1))}…`;
    result = `${boundedHandoff}${separator}${marker}`;
  }
  const truncated = needsFoldMarker || originalLen > result.length;
  if (
    env.summary === summary &&
    env.result === result &&
    env.truncated === undefined &&
    env.totalLength === undefined &&
    !truncated
  ) {
    return env;
  }
  return {
    ...env,
    summary,
    result,
    ...(truncated ? { truncated: true, totalLength: originalLen } : {}),
  };
}

/**
 * IPC 浓缩：result > 20000 时折叠，避免把终稿全文塞进进程间信封。
 * 未超限保持字段，供 graph 节点沿边传递上游产物。父模型交差走
 * `projectParentVisibleEnvelope`。
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
  return projectParentVisibleEnvelope(env);
}

const workerValidate = compileEnvelopeAjv(WORKER_SCHEMA);
const parentValidate = compileEnvelopeAjv(PARENT_SCHEMA);
