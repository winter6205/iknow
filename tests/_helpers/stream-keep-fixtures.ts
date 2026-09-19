/**
 * ADR-0108 interrupt frozen prefix keep —— 跨文件共享流式夹具。
 *
 * 收敛 tests/harness/loop-engine.test.ts 与
 * tests/session-api/hub-interrupt-frozen-prefix.test.ts 两处近乎相同的
 * 副本：`textOf` 逐字节重复 + 「emit 脚本 text_delta → 悬挂至 signal
 * abort」的流式 adapter 工厂。keep 面字节形状（deltas 与墙上 draft 同源）
 * 一改就得两处同步，故单一来源。仅测试树消费，src/ 不导出任何测试专用符号。
 */
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  HarnessStreamEvent,
  LoopAdapter,
  LoopState,
} from "../../src/harness/index.ts";
import { toAnthropicToolResults } from "../../src/harness/tools/tool-result.ts";
import type { ToolExecutionResult } from "../../src/harness/tools/types.ts";
import { assistantResult } from "../cli/_fixtures.ts";

/** 拼接消息内所有 text block（tool_use / tool_result block 不参与）。 */
export function textOf(msg: AnthropicNativeMessage): string {
  return msg.content
    .filter(
      (b): b is { type: "text"; text: string } =>
        b.type === "text" && typeof (b as { text?: unknown }).text === "string"
    )
    .map((b) => b.text)
    .join("");
}

/**
 * 脚本步骤：先同步 emit `deltas`（模拟与墙上 draft 同源字节的流式输出），
 * 带 `result` 则立即交付该回合；无 `result` 则悬挂至 signal abort
 * （模拟模型在途永不交付）。脚本耗尽后的调用（收尾摘要轮）立即返回空
 * 结果，避免测试挂起。
 */
export interface StreamKeepStep {
  readonly deltas?: ReadonlyArray<string>;
  readonly result?: AssistantTurnResult;
}

/**
 * 夹具适配器工厂。`onFirstStream` 在第 1 次 step 的 deltas emit 完毕后
 * 调用，让测试确定性地「看到流再打断」。每次 step 记录收到的
 * state.messages（stepPriors），作为 model prior 的观察面。
 */
export function makeStreamKeepAdapter(
  steps: ReadonlyArray<StreamKeepStep>,
  opts?: { readonly onFirstStream?: () => void }
): {
  adapter: LoopAdapter;
  stepPriors: AnthropicNativeMessage[][];
} {
  const stepPriors: AnthropicNativeMessage[][] = [];
  let call = 0;
  const adapter: LoopAdapter = {
    encodeUserText: (text: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text }],
    }),
    encodeToolResults: (results: ReadonlyArray<ToolExecutionResult>) =>
      toAnthropicToolResults(results),
    step: async (
      state: LoopState,
      request: { onStream?: (event: HarnessStreamEvent) => void },
      signal?: AbortSignal
    ): Promise<AssistantTurnResult> => {
      stepPriors.push([...state.messages]);
      const script = steps[Math.min(call, steps.length - 1)]!;
      const inRange = call < steps.length;
      const isFirst = call === 0;
      call += 1;
      for (const text of script.deltas ?? []) {
        request.onStream?.({ type: "text_delta", text });
      }
      if (isFirst) opts?.onFirstStream?.();
      if (!inRange || script.result !== undefined) {
        return (
          script.result ??
          assistantResult({ texts: [], toolCalls: [], supplierStop: "success" })
        );
      }
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
      throw new DOMException("aborted", "AbortError"); // unreachable
    },
  };
  return { adapter, stepPriors };
}
