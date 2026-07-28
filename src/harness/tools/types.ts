/**
 * Foundation 公共工具类型 (015 拥有)。
 *
 * 工具 / Registry / Executor 之间的边界形状。015 明确:
 *   - Tool 拥有模型可见的名称、描述、参数 JSON Schema、真实调用入口;
 *   - Registry 保存完整注册集合,负责构造期校验和按名定位,不知道 Loop;
 *   - Executor 持有调用身份与原始 input,完成定位、严格校验和真实调用,
 *     再返回匹配身份的 ToolExecutionResult。
 *
 * 公共错误类型与 ToolExecutionResult 的具体字段拼写在 015 不予过早固定;
 * 此处给出稳定可区分、对模型可操作、可无损编码且默认不泄露的最小形状。
 */

import type { AnthropicContentBlock } from "../model-adapter/types.js";

/**
 * 工具运行时入口签名:接收严格校验后的输入,返回 model-facing payload。
 *
 * Tool/Adapter 成功时返回已经过字段选择 / 排序 / 截断的 JSON-compatible
 * model-facing payload。允许字符串或结构化 JSON 值;不允许 undefined /
 * BigInt / 循环对象 / Map / Date / class instance。
 */
export type ToolHandler = (input: unknown) => Promise<unknown> | unknown;

/**
 * 工具描述符:模型可见名称 + JSON Schema(给模型与 Executor 同源校验用)
 * + 真实调用入口。015 强制:工具 input_schema 与 Executor 校验用同一份
 * 权威 JSON Schema,不允许分别维护。
 */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  /** JSON Schema(与 Executor 严格校验同源;015 冻)。 */
  readonly inputSchema: Record<string, unknown>;
  readonly handler: ToolHandler;
}

/** Registry 公共接口:构造期校验、不可变、按名定位(015 拥有)。 */
export interface Registry {
  readonly list: () => ReadonlyArray<ToolDef>;
  readonly get: (name: string) => ToolDef | undefined;
}

/** 工具调用身份 + 输入:由 Model Adapter 投影消费后交给 Executor。 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * 工具执行结果(015 拥有):一次执行的确定性结果/收据。
 *
 * 承载调用身份、成功 payload 或失败标签。失败标签在字段上结构化,
 * 区分"业务公开失败"(可向模型暴露)与"未知异常"(已净化为通用失败)。
 *
 * 不携带 Anthropic 原生编码;由 Model Adapter 负责原生 tool_result 编码。
 */
export type ToolExecutionResult =
  | {
      readonly kind: "ok";
      readonly toolUseId: string;
      readonly payload: AnthropicContentBlock[];
    }
  | {
      readonly kind: "validation_failed";
      readonly toolUseId: string;
      /** 人类可读的安全错误摘要(可向模型暴露)。 */
      readonly message: string;
    }
  | {
      readonly kind: "tool_not_found";
      readonly toolUseId: string;
      readonly toolName: string;
    }
  | {
      readonly kind: "execution_failed";
      readonly toolUseId: string;
      /** 净化后的安全错误摘要(可向模型暴露)。 */
      readonly message: string;
    };

/** Executor 接口:接收 014 合法有序 tool-call 投影,返回匹配身份的 ToolExecutionResult。 */
export interface Executor {
  /** 串行执行一序列调用;015 强制:无短路、无自动重试。 */
  readonly executeAll: (
    calls: ReadonlyArray<ToolCall>
  ) => Promise<ReadonlyArray<ToolExecutionResult>>;
}