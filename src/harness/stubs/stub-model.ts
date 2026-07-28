/**
 * Stub model (T4):Foundation 的替身 ModelAdapter。
 *
 * 接受脚本化 AssistantTurnResult 数组,每次 step 消费下一条,确定性、
 * 无时间 / 随机 / IO 依赖。响应耗尽时抛 ProtocolError(模拟"模型回应
 * 不再可用")。替身不进生产装配路径。
 */

import { ProtocolError } from "../errors.js";
import type {
  AssistantTurnResult,
  LoopState,
  ModelAdapter,
} from "../model-adapter/types.js";

export function createStubModel(
  responses: ReadonlyArray<AssistantTurnResult>,
): ModelAdapter {
  const queue = responses.slice();
  return Object.freeze({
    async step(
      _state: LoopState,
      _request: { system?: string; tools?: unknown },
    ): Promise<AssistantTurnResult> {
      const next = queue.shift();
      if (!next) {
        throw new ProtocolError(
          "stub-model: scripted responses exhausted (no further model reply)",
        );
      }
      return next;
    },
  });
}