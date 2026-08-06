/**
 * T2 (#175): 流式草稿共享层 — 把 harness `HarnessStreamEvent` 累积为带遮蔽的
 * 当前文本,供 chat REPL(stdout)和 TUI(`useSyncExternalStore` 订阅)同源消费。
 *
 * 设计要点(D4 裁决):
 * - `rawBuffer` 增量累积文本;`masked()` 每次调用**全量**重 mask。
 *   跨 delta 边界的截断密钥(如 `sk-` + `abc123`)在累积完成后被
 *   `createOutputMask(currentSecretValues()).mask(rawBuffer)` 整段捕获,
 *   自然满足 D4 「跨边界密钥」验收。rawBuffer 是回合内文本(几百~几千字),
 *   O(N) 重 mask 可接受;不增量优化。
 * - **不在模块级缓存 mask 实例**:`currentSecretValues()` 每次现取 process.env
 *   (对齐 `src/cli/format.ts` 的 start-of-run snapshot 语义,但 stream-draft
 *   跨回合连续,故每读一次 env),保持「无记忆化 seam」。
 * - listener 用 `Set` 去重;unsubscribe 幂等;同一 listener 多次 subscribe
 *   只触发一次。
 * - 无 fd / 无 React 依赖,纯字符串 + Set 状态。
 */
import type { HarnessStreamEvent } from "../harness/stream.js";
import {
  createOutputMask,
  currentSecretValues,
} from "../harness/sandbox/index.js";

export interface StreamDraft {
  append(event: HarnessStreamEvent): void;
  raw(): string;
  masked(): string;
  reset(): void;
  subscribe(listener: () => void): () => void;
}

export function createStreamDraft(): StreamDraft {
  let rawBuffer = "";
  const listeners = new Set<() => void>();

  const notify = (): void => {
    // D3 纪律: 观察者异常不得反向破坏数据生产者(也不得阻断其他 listener)。
    // 单 listener throw 隔离 — 与 anthropic-adapter wireStreamEvents safeEmit
    // 同源契约;stream-draft 作为共享层,无法假设所有消费者自带 try/catch
    // (e.g. TUI React listener),因此在 SSOT 层兜底。
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // swallow — D3
      }
    }
  };

  return {
    append(event: HarnessStreamEvent): void {
      if (event.type === "text_delta") {
        rawBuffer += event.text;
        notify();
      }
    },
    raw(): string {
      return rawBuffer;
    },
    masked(): string {
      return createOutputMask(currentSecretValues()).mask(rawBuffer);
    },
    reset(): void {
      rawBuffer = "";
      notify();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      let unsubscribed = false;
      return (): void => {
        if (unsubscribed) return;
        unsubscribed = true;
        listeners.delete(listener);
      };
    },
  };
}
