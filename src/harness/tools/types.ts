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
import type { HarnessStreamEvent } from "../stream.js";

/**
 * 工具运行时入口签名:接收严格校验后的输入,返回 model-facing payload。
 *
 * Tool/Adapter 成功时返回已经过字段选择 / 排序 / 截断的 JSON-compatible
 * model-facing payload。允许字符串或结构化 JSON 值;不允许 undefined /
 * BigInt / 循环对象 / Map / Date / class instance。
 */
export type ToolHandler = (
  input: unknown,
  ctx?: ToolExecutionContext // 017 新增;015 老 handler (input) => ... 继续合法
) => Promise<unknown> | unknown;

/** 017: Executor 透传给 handler 的执行上下文;含 signal + conversationId。timeoutMs 由 Executor Promise.race 外包不在此。T5: conversationId 注入用于 bash background conversation scope 过滤（bash-output / bash-stop handler 读 ctx 交给 manager；缺省 = 不过滤，向后兼容，ADR-0021 D1.4）。 */
export interface ToolExecutionContext {
  readonly signal?: AbortSignal;
  readonly conversationId?: string;
  /**
   * 本次调用所属回合的 trace turn id（F-4）。`conversationId` 回答"哪个会话"、
   * 装配期定死;`turnId` 回答"哪一回合"、每回合翻新,所以只能顺着 executeAll 走。
   * 消费方 = `spawn_subagent`(写进 def.parentTurnId → 子代理三类 record)。
   * 缺省 = 无归属回合(worker / ask / 直接调 handler),下游按 Postel 不落该键。
   */
  readonly turnId?: string;
  /**
   * 本回合宿主流观察者（F 图进度）。`run_graph` 经 safeEmitStream 推
   * `graph_progress`；缺席 = 不发事件（ask / 直调 handler 默认）。
   */
  readonly onStream?: (event: HarnessStreamEvent) => void;
  /**
   * T5 (plans/session-folder-consolidation.md / SC8):本次 tool_call 的
   * Anthropic tool_use_id(模型那侧的 wire id) —— `spawn_subagent` 工具消费
   * 后写入 def.toolUseId,manager 抄进 `.meta.json` 的 `toolUseId` 字段,
   * 用于反查父 loop 的那一次工具调用。缺席 = Postel(meta 键省略),兼容
   * 直接调 handler / 测试注入。
   */
  readonly toolUseId?: string;
}

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
/**
 * ToolExecutionResult `ok` 变体的可选 side-channel (#298):不改模型可见
 * payload 的前提下,为宿主携带 diff 类的 old/new 内容。仅在有内容时存在;
 * additive，不破坏既有 `payload` 契约。
 *
 * T4 (#693) D4:扩 bash 输出承载字段 `stdout` / `stderr`（显示层投影）——
 * 走观测旁路，永不进模型 tool_result。`executor.ts` 形状守卫仅校验字段
 * 类型（string），其它 host 用途字段如需加入按 SSOT 走同套纪律。
 */
export interface ToolResultMeta {
  readonly oldContent?: string;
  readonly newContent?: string;
  readonly stdout?: string;
  readonly stderr?: string;
}

/**
 * #298 handler 可返回的结构化 envelope 形状（T4 side-channel SSOT）：
 * `{ output: string, meta?: ToolResultMeta }`。Executor 仅取 `output` 进
 * model-facing tool_result；`meta` 走观测侧信道，不进模型可见 payload。
 *
 * 单一权威形状：executor 落址此处（不再在各处内联重写 shape-check），
 * 类型守卫与取值共用同一接口（#298 review-Low：3 处独立 shape-check 收敛）。
 */
export interface ToolOutputEnvelope {
  readonly output: string;
  readonly meta?: ToolResultMeta;
}

export type ToolExecutionResult =
  | {
      readonly kind: "ok";
      readonly toolUseId: string;
      readonly payload: AnthropicContentBlock[];
      /** 可选 typed envelope(#298):宿主侧消费 diff old/new;模型不可见。 */
      readonly meta?: ToolResultMeta;
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
      /**
       * 可选 partial stdout/stderr — 由被中断/超时的 handler 在 #124 SC13
       * 下产出，便于模型在收到 cancelled/timeout 后看到已有输出。仅在
       * 真实产生过输出时存在;additive，不破坏 `message` 的 strict-equal
       * 比对契约(loop-engine 仍按 message 判定 stopReason)。
       */
      readonly partial?: { readonly stdout?: string; readonly stderr?: string };
      /**
       * caller 已经收到 cancelled，但 handler 未响应 signal，仍在后台运行。
       * 仅在 ACI detach 该 handler 时出现；真正收尾的取消不带此字段。
       */
      readonly background?: true;
    };

/** Executor 接口:接收 014 合法有序 tool-call 投影,返回匹配身份的 ToolExecutionResult。 */
export interface Executor {
  /**
   * 执行一序列调用。基础 executor 串行;ACI 调度层可对 isConcurrencySafe
   * 批次重叠。无短路、无自动重试。onSettled 按输入下标在每个结果 settle
   * 时回调(#620),缺省不调用。
   */
  readonly executeAll: (
    calls: ReadonlyArray<ToolCall>,
    signal?: AbortSignal, // 017: 原样透传到 ctx.signal
    timeoutMs?: number, // 017: 单 handler Promise.race 超时;undefined = 不 race(015 语义)
    conversationId?: string, // 017 T5: 原样透传到 ctx.conversationId;缺省 = 不过滤(向后兼容)
    /** #653 / #620:each result as it settles (index = input order). Optional. */
    onSettled?: (
      result: ToolExecutionResult,
      index: number
    ) => void | Promise<void>,
    turnId?: string, // F-4: 原样透传到 ctx.turnId;缺省 = 无归属回合
    onStream?: (event: HarnessStreamEvent) => void // 图进度等工具内 emit
  ) => Promise<ReadonlyArray<ToolExecutionResult>>;
}
