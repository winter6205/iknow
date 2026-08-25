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
  override readonly name = "ToolExecutionError";
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
