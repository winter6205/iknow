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
  /** T3 (#175): thinking 增量累积的原始文本(独立于 answer 的 rawBuffer)。 */
  thinkingRaw(): string;
  /** T3: thinking 原始文本遮蔽后的可渲染串(SC20 一致性,密钥不裸出)。 */
  thinkingMasked(): string;
  /** 首次 thinking_delta 到现在的耗时秒数（无 thinking 返回 0）。 */
  thinkingSeconds(): number;
  reset(): void;
  subscribe(listener: () => void): () => void;
}

export function createStreamDraft(): StreamDraft {
  let rawBuffer = "";
  // T3 (#175): thinking buffer 与 answer text buffer 分离 — 两者各自累积 /
  // 遮蔽,互不污染。thinking 不进 answer rawBuffer(终稿 thinking blocks 是
  // SSOT,流式 thinking 只是临时展示层)。
  let thinkingBuffer = "";
  // 首次 thinking_delta 到达时刻（毫秒）—— 折叠行渲染「思考了 N 秒」用。
  // 流式面板需要「思考中… · 经过 N 秒」时由 app.tsx 每次通知覆算。
  let thinkingStartedAt: number | null = null;
  const listeners = new Set<() => void>();

  // T5 (#175): 渲染节流 —
  //  - 缓冲在 append 内**同步**更新(raw()/masked() 随时为当前值,REPL 的
  //    feed 依赖 append 后立即 masked() 同步写出);
  //  - 但 listener 通知走 50ms trailing timer 批处理,避免每 delta 全树重渲染
  //    (TUI 每 notify 一次 setDraftsMasked → 全 ChatView re-render + markdown
  //    重解析);
  //  - 累积 ≥ 384 字符立即 flush(不等 50ms) — 大量文本不淤积;
  //  - timer.unref():定时器不阻塞进程退出(回合结束 / Ctrl+C 时进程可即时退出)。
  //  - reset 取消 pending timer — 中断后不再有迟到 notify 触发已卸载的 UI。
  const THROTTLE_MS = 50;
  const EARLY_FLUSH_CHARS = 384;
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  // 自上次 flush 以来累积的字符数(跨 delta 边界累加,用于早 flush 判定)。
  let pendingChars = 0;

  const flush = (): void => {
    notifyTimer = null;
    pendingChars = 0;
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

  const scheduleNotify = (): void => {
    if (notifyTimer !== null) return; // 已有 pending 批处理,累积进同一批
    notifyTimer = setTimeout(flush, THROTTLE_MS);
    (notifyTimer as ReturnType<typeof setTimeout>).unref?.();
  };

  const cancelPending = (): void => {
    if (notifyTimer !== null) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
    pendingChars = 0;
  };

  const appendText = (text: string): void => {
    pendingChars += text.length;
    // ≥384 字符立即 flush — 大文本不等 50ms 窗口,避免用户感知延迟。
    if (pendingChars >= EARLY_FLUSH_CHARS) {
      cancelPending();
      flush();
      return;
    }
    scheduleNotify();
  };

  return {
    append(event: HarnessStreamEvent): void {
      if (event.type === "text_delta") {
        rawBuffer += event.text;
        appendText(event.text);
      } else if (event.type === "thinking_delta") {
        if (thinkingStartedAt === null) thinkingStartedAt = Date.now();
        thinkingBuffer += event.text;
        appendText(event.text);
      }
    },
    raw(): string {
      return rawBuffer;
    },
    masked(): string {
      return createOutputMask(currentSecretValues()).mask(rawBuffer);
    },
    thinkingRaw(): string {
      return thinkingBuffer;
    },
    thinkingMasked(): string {
      return createOutputMask(currentSecretValues()).mask(thinkingBuffer);
    },
    thinkingSeconds(): number {
      if (thinkingStartedAt === null) return 0;
      return Math.max(0, Math.floor((Date.now() - thinkingStartedAt) / 1000));
    },
    reset(): void {
      rawBuffer = "";
      thinkingBuffer = "";
      thinkingStartedAt = null;
      cancelPending();
      // 复位立即通知一次(清 UI 的草稿面板),不等节流窗口。
      flush();
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
