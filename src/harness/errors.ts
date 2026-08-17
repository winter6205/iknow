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
 * plan T3 + ADR-0011: maxTurns 超限的强制感知信号。
 *
 * 不携带 messages / usage 快照(SSOT 守门:权威历史留在 session,
 * 数据不双份重复),仅承载已跑轮数 + 原因;surface (chat / ask / serve /
 * tui, T6 范畴) 收到此异常时必须先写盘保存当前会话,再呈现收尾摘要。
 *
 * 行为对齐 OpenHarness (`query.py:129-134` + `ui/runtime.py:681-682`):
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
