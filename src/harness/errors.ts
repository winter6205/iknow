/**
 * Foundation 自治错误类 (spec E2).
 *
 * 三个错误类分别承担 015 / 014 / 015 边界的失败信号。Foundation
 * 自治:不依赖宿主业务包,不重新导出任何供应商 SDK 类型。
 *
 * - RegistryConstructionError: 构造期失败(重复名 / 坏 schema / validator 编译失败)
 * - ProtocolError: 014 整回合协议结构错误,整回合不进入权威历史
 * - ToolExecutionError: Executor 接住并净化后,作为可反馈业务失败信号;
 *   正常路径上,Executor 把工具业务失败装入 ToolExecutionResult,而非抛错
 */

export class RegistryConstructionError extends Error {
  override readonly name = "RegistryConstructionError";
}

export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
}

export class ToolExecutionError extends Error {
  override readonly name = "ToolExecutionError";
}