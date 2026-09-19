/**
 * Foundation 自治错误类 (spec E2).
 *
 * 三个错误类分别承担 015 / 014 / 015 边界的失败信号。Foundation
 * 自治:不依赖宿主业务包,不重新导出任何供应商 SDK 类型。
 *
 * - RegistryConstructionError: 构造期失败(重复名 / 坏 schema / validator 编译失败)
 * - ProtocolError: 014 整回合协议结构错误,整回合不进入权威历史
 * - PromptTooLongError: #252 T2 — SDK 400 prompt-too-long 的翻译错误,
 *   继承 ProtocolError 使 loop-engine `instanceof ProtocolError` 分支命中
 *   (T3 reactive compact 地基)
 * - MaxTurnsExceeded: plan T3 + ADR-0011 — maxTurns 超限的强制感知信号
 *   (throw 替代 silent-stop;不携带 messages / usage 快照,数据留在 session 权威状态)
 * - ToolExecutionError: Executor 接住并净化后,作为可反馈业务失败信号;
 *   正常路径上,Executor 把工具业务失败装入 ToolExecutionResult,而非抛错
 * - SubAgentSandboxRootError: #357 T1 — sandboxRoot 收窄越界 typed 拒绝;
 *   buildWorkerPayload 单点校验发现 def.sandboxRoot 落在父 sandboxRoot 之外
 *   / 不存在时同步抛,spawn 工厂不被调用(走 typed error,不裸抛 Error)
 * - SkipAppendWithTextError / SkipAppendEmptyPriorError: #687 T1 —
 *   skip-append 守卫（EXIT `skip_append_with_text` / `skip_append_empty_prior`）
 */

export class RegistryConstructionError extends Error {
  override readonly name = "RegistryConstructionError";
}

export class ProtocolError extends Error {
  // `: string` 显式注解:让子类可 override name 为其它字面量
  // (否则 parent name 被推断为 "ProtocolError" 字面量,子类 override 报 TS2416)。
  override readonly name: string = "ProtocolError";
}

/**
 * #252 T2 (reactive compact 地基): SDK 抛 400 prompt-too-long 的翻译错误。
 *
 * 继承 ProtocolError — 让 `loop-engine.ts:431` 的 `instanceof ProtocolError`
 * 分支能命中 (T3 reactive compact 分支依赖此命中)。
 *
 * Adapter 在两个 SDK 调用点 (`messages.create` 非流式臂 / `finalMessage()`
 * 流式臂) catch 后按 `instanceof APIError && status === 400 && /prompt.*length
 * |too long/i.test(message)` 翻译为本类;其余 400 / 其他 status 原样 rethrow。
 */
export class PromptTooLongError extends ProtocolError {
  override readonly name = "PromptTooLongError";
}

/**
 * #672 T2: ModelAdapter 传输重试耗尽。typed 失败，禁止用裸 `Error` 表示。
 * loop-engine 将其映射为 StopReason `protocolError`（整回合不进历史）。
 */
export class TransportRetryExhaustedError extends Error {
  override readonly name = "TransportRetryExhaustedError";
  readonly attempts: number;
  readonly cause: unknown;
  constructor(attempts: number, cause: unknown) {
    super(`transport retry exhausted after ${attempts} attempt(s)`);
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * ADR-0111 Decision 1: 上游流结束但未产出完整 assistant Message（空流 / 断流，
 * 瞬时形态）。继承 `ProtocolError` —— loop-engine `instanceof ProtocolError`
 * 支干净收口（先例 `PromptTooLongError`，子类支排在通用支之前）。
 *
 * - `visible` = 本次 attempt 是否见过非空可见增量（判据同 `clock_timeout`：
 *   不可见 → 整 step 重试安全；已出字 → 不自动重试，落 typed 失败）。
 * - `cause` = 原 SDK 错误（仿 `TransportRetryExhaustedError` 的 cause 形态）；
 *   apiError 摘要经 `transportApiErrorOf` 走 `summarizeTransportCause`
 *   （ADR-0111 Decision 2(c)）。
 */
export class ModelStreamIncompleteError extends ProtocolError {
  override readonly name = "ModelStreamIncompleteError";
  readonly visible: boolean;
  readonly cause: unknown;
  constructor(visible: boolean, cause: unknown) {
    super("model stream ended without producing a complete assistant message");
    this.visible = visible;
    this.cause = cause;
  }
}

/**
 * plan T3 + ADR-0011: maxTurns 超限的强制感知信号。
 *
 * 不携带 messages / usage 快照(SSOT 守门:权威历史留在 session,
 * 数据不双份重复),仅承载已跑轮数 + 原因;surface (chat / ask / serve /
 * tui, T6 范畴) 收到此异常时必须先写盘保存当前会话,再呈现收尾摘要。
 *
 * 行为对齐 (`query.py:129-134` + `ui/runtime.py:681-682`):
 * `max_turns` 超限 raise `MaxTurnsExceeded` 而非 silent-stop。
 */
export class MaxTurnsExceeded extends Error {
  override readonly name = "MaxTurnsExceeded";
  readonly turnsRan: number;
  readonly reason: string;
  constructor(turnsRan: number, reason: string) {
    super(`MaxTurnsExceeded: ${reason} after ${turnsRan} turns`);
    this.turnsRan = turnsRan;
    this.reason = reason;
  }
}

export class ToolExecutionError extends Error {
  override readonly name: string = "ToolExecutionError";
}

/**
 * runtime-capability-memory-gate T2 (ADR-0086):「message 可向模型透出」的自愿
 * 契约。Executor 的失败净化默认只放行 `ToolExecutionError` 的 message,其余
 * 异常一律塌成常量字符串(不泄漏 stack / 路径)。
 *
 * 某些 bounded context 有自己的 typed error 基类(如 memory 的 `MemoryError`),
 * 但它们的失败原因同样要让模型读到 —— 继承 `ToolExecutionError` 会把
 * foundation 类塞进该上下文的错误层级。这类子类只需实现本接口(落
 * `readonly modelFacing = true`),无需换基类。
 *
 * 注意这是**申报**而非推断:未申报的错误 message 仍被净化,默认不放宽。
 */
export interface ModelFacingError {
  readonly modelFacing: true;
}

/** `ToolExecutionError` 命中,或错误自行申报 `modelFacing`。 */
export function isModelFacingError(err: unknown): boolean {
  if (err instanceof ToolExecutionError) return true;
  return (
    err instanceof Error &&
    (err as { readonly modelFacing?: unknown }).modelFacing === true
  );
}

/** Stable failure discriminants for MCP root/config/reload lifecycle edges. */
export type McpLifecycleErrorKind =
  | "missing_cwd"
  | "invalid_cwd"
  | "invalid_config_root"
  | "root_mismatch"
  | "config_load_failed"
  | "reload_failed";

const MCP_LIFECYCLE_DETAIL_FALLBACK = "MCP lifecycle operation failed";

/**
 * Keep lifecycle diagnostics useful without copying raw transport input into
 * the product-visible error. In particular, command arguments and
 * secret-shaped values must not cross this error boundary.
 */
function sanitizeMcpLifecycleDetail(detail: string): string {
  let safeDetail =
    typeof detail === "string" ? detail.trim() : MCP_LIFECYCLE_DETAIL_FALLBACK;

  if (!safeDetail) return MCP_LIFECYCLE_DETAIL_FALLBACK;

  safeDetail = safeDetail
    .replace(
      /\b(?:command|cmd|argv|args)\b\s*[:=]\s*[^\n;]*/gi,
      "[command redacted]"
    )
    .replace(
      /\b(?:node|npm|npx|bun|deno|bash|sh|python|tsx)\b(?:\s+\S+)+/gi,
      "[command redacted]"
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[-_ ]?key|token|secret|password|passwd|authorization|credential|cookie)\b\s*[:=]\s*\S+/gi,
      "$1=[redacted]"
    )
    .replace(
      /\b[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD)\s*=\s*\S+/g,
      "[env]=[redacted]"
    )
    .replace(
      /\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*\b/g,
      "process.env.[redacted]"
    )
    .replace(/\$[A-Z_][A-Z0-9_]*/g, "$[redacted]");

  return safeDetail.trim() || MCP_LIFECYCLE_DETAIL_FALLBACK;
}

/**
 * Typed, stable MCP lifecycle failure. Callers branch on `kind`, while
 * `message` and `detail` remain non-empty and safe for product surfaces.
 */
export class McpLifecycleError extends ToolExecutionError {
  override readonly name: string = "McpLifecycleError";
  readonly kind: McpLifecycleErrorKind;
  readonly detail: string;

  constructor(
    kind: McpLifecycleErrorKind,
    detail: string,
    options?: { readonly cause?: unknown }
  ) {
    const safeDetail = sanitizeMcpLifecycleDetail(detail);
    super(`McpLifecycleError: ${kind} — ${safeDetail}`, options);
    this.kind = kind;
    this.detail = safeDetail;
  }
}

/**
 * T2 (plans/worktree-session-roots.md / ADR-0037 §4): 会话三根解析失败。
 *
 * kind 只分两态,因为角色由 `detail` 里的根名(`productRoot` / `taskRoot` /
 * `installRoot`)承载,调用方无需为每个角色各配一个 kind。「与已固定的根不一致」
 * 归 `McpLifecycleError.root_mismatch`(非 ask 面的既有校验点),这里不平行开第
 * 二套。复用 `McpLifecycleError` 的 detail 脱敏(根路径可能带 env 形状的片段)。
 */
export type SessionRootErrorKind = "missing_root" | "invalid_root";

export class SessionRootError extends ToolExecutionError {
  override readonly name: string = "SessionRootError";
  readonly kind: SessionRootErrorKind;
  readonly detail: string;

  constructor(
    kind: SessionRootErrorKind,
    detail: string,
    options?: { readonly cause?: unknown }
  ) {
    const safeDetail = sanitizeMcpLifecycleDetail(detail);
    super(`SessionRootError: ${kind} — ${safeDetail}`, options);
    this.kind = kind;
    this.detail = safeDetail;
  }
}

/**
 * #620 T3 (spec session-jsonl-resume D4): host 注入的 commit 钩子失败信号。
 *
 * loop-engine 对 commit 失败不重试、不吞咽、不映射 stop reason —— 包成
 * MessageCommitError 原路上抛,run 随之 throw(与 adapter 抛错同一大类
 * 控制流:内存 run 中止,已 commit 的事件留在盘上)。surface 可经
 * instanceof 区分「持久化失败」与模型/协议/工具失败;cause 保留 host
 * 侧原始 typed error,不丢 kind/context。
 */
export class MessageCommitError extends Error {
  override readonly name = "MessageCommitError";
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(`MessageCommitError: commit hook failed: ${errorMessage(cause)}`);
    this.cause = cause;
  }
}

/**
 * continue_pending T1 (#687): skip-append 守卫。`appendUserText: false`
 * 时禁止再带新任务 user 文本（EXIT `skip_append_with_text`）。
 */
export class SkipAppendWithTextError extends Error {
  override readonly name = "SkipAppendWithTextError";
  constructor() {
    super(
      "skip_append_with_text: appendUserText false requires empty userText"
    );
  }
}

/**
 * continue_pending T1 (#687): skip-append 守卫。`appendUserText: false`
 * 时 priorMessages 必须在场且 length > 0（EXIT `skip_append_empty_prior`）。
 */
export class SkipAppendEmptyPriorError extends Error {
  override readonly name = "SkipAppendEmptyPriorError";
  constructor() {
    super(
      "skip_append_empty_prior: appendUserText false requires non-empty priorMessages"
    );
  }
}

/**
 * #357 T1: sandboxRoot 收窄越界 typed 拒绝。
 *
 * `buildWorkerPayload` 单点校验(manager 内)发现 def.sandboxRoot 落在父
 * sandboxRoot 之外 / 解析后 ENOENT 时同步抛;spawn 工厂不触发。
 * 仿 `SubAgentCapacityError` 形态(命名 + readonly name + readonly context 字段),
 * 区别于 capacity 的 status/reason 字段 —— 此错误域不参与 envelope 失败态,
 * 是输入拒绝(类似 ToolExecutionError 域),由 tool handler catch 后转
 * ToolExecutionError 抛给 executor。
 *
 * message 面向模型:说明 requested 路径越界,要求留在 parent sandboxRoot 内,
 * 模型可据此缩小 sandboxRoot 范围或省略字段以继承父根(SC8)。
 */
export class SubAgentSandboxRootError extends Error {
  override readonly name = "SubAgentSandboxRootError";
  readonly context: {
    readonly parentSandboxRoot: string;
    readonly requested: string;
  };
  constructor(context: {
    readonly parentSandboxRoot: string;
    readonly requested: string;
  }) {
    super(
      `spawn_subagent: sandboxRoot '${context.requested}' is outside the parent sandbox root '${context.parentSandboxRoot}'. Pass a path inside the parent sandbox root, or omit sandboxRoot to inherit the parent root.`
    );
    this.context = context;
  }
}

/**
 * 任意 throwable → 安全字符串摘要（typed error 已由调用方判定分支）。
 *
 * 取代 `err instanceof Error ? err.message : String(err)`：后者把 plain object
 * 打成 `[object Object]`，丢光 kind/context。code-quality.md typed-error catch 契约
 * 明确禁止该形态。本 helper 与 lessons from tools/list-mcp-resources.ts /
 * read-mcp-resource.ts 的工具层 `errMessage` 一致；现在抽到 errors.ts 单点维护。
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * ADR-0094 SC4-SC5: viewport API error 摘要——status 可选 + 非空 message。
 *
 * 单点类型别名：loop-engine / hub DTO / TUI bridge / app 渲染面共用，禁止
 * 逐处内联同一匿名形状（code-review Standards Low）。
 */
export type ApiErrorSummary = {
  readonly status?: number;
  readonly message: string;
};

/** object（含 Error 实例）→ Record 视图；其它 → undefined。 */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : undefined;
}

/** 非空（trim 后非空）string → 原值；否则 undefined。 */
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * 网关嵌套错误体里的 message：`error.message` 优先，再嵌一层的
 * `error.error.message` 次之（中转网关常见两层）。缺失/空 → undefined。
 */
function extractNestedMessage(
  record: Record<string, unknown>
): string | undefined {
  const body = asRecord(record["error"]);
  if (body === undefined) return undefined;
  return (
    nonEmptyString(body["message"]) ??
    nonEmptyString(asRecord(body["error"])?.["message"])
  );
}

/**
 * 顶层 message：Error.message / 裸 string / object.message。嵌套网关体
 * （供应商原文）比 SDK 的 "404 Not Found" HTTP 描述更可行动（ADR-0094），
 * 故调用方让嵌套体优先、本函数作回落。
 */
function extractBaseMessage(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  const record = asRecord(cause);
  return typeof record?.["message"] === "string"
    ? (record["message"] as string)
    : undefined;
}

/** cause 的有限 number status（仅 object 形态）；否则 undefined。 */
function extractCauseStatus(cause: unknown): number | undefined {
  const status = asRecord(cause)?.["status"];
  return typeof status === "number" && Number.isFinite(status)
    ? status
    : undefined;
}

/**
 * ADR-0094 SC4-SC5 (viewport API error): 从 TransportRetryExhaustedError.cause
 * 提炼「viewport API 错误」摘要 —— SDK-agnostic，不耦合 Anthropic SDK 类型。
 *
 * 返回 `{ status?, message }`；message 永远非空（提炼不到 → `String(cause)`
 * 兜底）。null / undefined cause → undefined，由调用方保留既有通用文案。
 */
export function summarizeTransportCause(
  cause: unknown
): ApiErrorSummary | undefined {
  if (cause === null || cause === undefined) return undefined;
  // SDK APIError 同时是 Error 实例与「带嵌套错误体的 object」——嵌套体提取
  // 对两种形态都生效（extractBaseMessage 只管回落），服务商原文优先。
  const record = asRecord(cause);
  const message =
    (record !== undefined ? extractNestedMessage(record) : undefined) ??
    extractBaseMessage(cause) ??
    "";
  const status = extractCauseStatus(cause);
  const nonEmpty = message.trim() || String(cause);
  return status !== undefined
    ? { status, message: nonEmpty }
    : { message: nonEmpty };
}

/**
 * ADR-0094 SC4-SC5 + ADR-0111 Decision 2(c): throw 路径专用——
 * `TransportRetryExhaustedError` / `ModelStreamIncompleteError`（带 cause 的
 * 瞬时模型流/传输失败）→ cause `{ message, status? }` 摘要；其它 throwable
 * （含 4xx 裸 SDK APIError 之外的本地错误、无 cause 的 ProtocolError 直抛）
 * → undefined，由调用方保留既有通用文案。不变式：apiError 在场 ⇔ 带 cause
 * 的瞬时模型流/传输失败。
 */
export function transportApiErrorOf(err: unknown): ApiErrorSummary | undefined {
  if (err instanceof TransportRetryExhaustedError) {
    return summarizeTransportCause(err.cause);
  }
  if (err instanceof ModelStreamIncompleteError) {
    return summarizeTransportCause(err.cause);
  }
  return undefined;
}

/**
 * ADR-0094: byte-stable 可选字段挂载 —— `apiError` 定义时才挂 key（缺席
 * 与 `lastUsage` 同模式的 wire 表面纪律）。复杂装配函数用它代替
 * `...(x !== undefined ? {x} : {})` 条件 spread，避免每个调用点各加一个分支。
 */
export function withApiError<T extends object>(
  target: T,
  apiError: ApiErrorSummary | undefined
): T & { readonly apiError?: ApiErrorSummary } {
  return apiError !== undefined ? { ...target, apiError } : target;
}
