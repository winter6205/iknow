/**
 * Stub model (T4):Foundation 的替身 ModelAdapter。
 *
 * 接受脚本化 AssistantTurnResult 数组,每次 step 消费下一条,确定性、
 * 无时间 / 随机 / IO 依赖。响应耗尽时抛 ProtocolError(模拟"模型回应
 * 不再可用")。替身不进生产装配路径。
 *
 * 同时提供 encodeUserText / encodeToolResults 两个最小编码入口,让
 * Loop Engine 跑完 S1 完整闭环(替身不解释真实 Anthropic wire 格式)。
 *
 * 017:可选注入 step 返回前的延迟(delayMs),用来验证 S17 守门
 * (abort → AbortError)。替身允许时间依赖,因为测试控制时间。
 */

import { ProtocolError } from "../errors.js";
import { toAnthropicToolResults } from "../tools/tool-result.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
  ModelAdapter,
} from "../model-adapter/types.js";
import type { ToolExecutionResult } from "../tools/types.js";
import type { HarnessStreamEvent } from "../stream.js";

export interface StubModelOptions {
  readonly responses: ReadonlyArray<AssistantTurnResult>;
  /** 017: step 返回前的可注入延迟(ms)。测试替身允许时间依赖,因为测试控制时间。 */
  readonly delayMs?: number;
  /** 测试专用:每次 step 在返回 scripted response 前同步 emit 对应事件序列。
   * 与 `responses` 按 step 下标一一配对;缺省时该 step 不 emit(如队列更短)。 */
  readonly streamEventsByStep?: ReadonlyArray<
    ReadonlyArray<HarnessStreamEvent>
  >;
}

export interface StubModelFull extends ModelAdapter {
  readonly encodeUserText: (userText: string) => AnthropicNativeMessage;
  readonly encodeToolResults: (
    results: ReadonlyArray<ToolExecutionResult>
  ) => AnthropicContentBlock[];
}

/**
 * 模块私有:可被 AbortSignal 中断的延时。中断时 reject DOMException
 * ("AbortError"),与 Web/Node 平台约定一致,Executor / Promise.race
 * 会把它收敛为统一的失败标签。
 */
function delay(opts: {
  readonly ms: number;
  readonly signal?: AbortSignal;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // 入口已 abort:立即拒绝,不必启动 timer。
    if (opts.signal?.aborted) {
      reject(new DOMException("This operation was aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      // 正常 resolve:主动撤销监听,避免内存泄漏。
      opts.signal?.removeEventListener("abort", onAbort);
      resolve();
    }, opts.ms);
    const onAbort = (): void => {
      // 中断:清 timer + 拒绝同样的 AbortError。
      clearTimeout(timer);
      reject(new DOMException("This operation was aborted", "AbortError"));
    };
    // { once: true } 确保监听只触发一次,自然清理。
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createStubModel(opts: StubModelOptions): StubModelFull {
  const queue = opts.responses.slice();
  const streamEventsQueue = opts.streamEventsByStep?.slice() ?? [];
  const delayMs = opts.delayMs ?? 0;
  return Object.freeze({
    async step(
      _state: LoopState,
      request: {
        tools?: unknown;
        onStream?: (event: HarnessStreamEvent) => void;
      },
      signal?: AbortSignal // 017:与 Adapter.step / LoopAdapter.step 对齐,可选。
    ): Promise<AssistantTurnResult> {
      // 017 S17 守门:可选注入延迟 + abort 透传。
      if (delayMs > 0) {
        await delay({ ms: delayMs, signal });
      } else if (signal?.aborted) {
        // 无延迟配置但 signal 已 abort:立即拒绝,保持行为一致。
        throw new DOMException("This operation was aborted", "AbortError");
      }
      // 延迟之后再次确认:可能在 await 期间(无延迟但信号被外部触发)变 abort。
      if (signal?.aborted) {
        throw new DOMException("This operation was aborted", "AbortError");
      }
      const next = queue.shift();
      if (!next) {
        throw new ProtocolError(
          "stub-model: scripted responses exhausted (no further model reply)"
        );
      }
      for (const event of streamEventsQueue.shift() ?? []) {
        try {
          request.onStream?.(event);
        } catch {
          // 测试替身遵守 D3:观察者异常不得反向破坏模型回合。
        }
      }
      return next;
    },
    encodeUserText(userText: string): AnthropicNativeMessage {
      return {
        role: "user",
        content: [{ type: "text", text: userText }],
      };
    },
    encodeToolResults(
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] {
      return toAnthropicToolResults(results);
    },
  });
}
