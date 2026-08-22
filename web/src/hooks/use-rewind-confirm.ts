/**
 * serve-workspace T7a — ChatApp rewind confirm 异步副作用 hook (review fix M6)。
 *
 * 把 ChatApp 内 ~15 行的 `confirmRewind` 函数（点确认 → chat.rewind + 关闭 picker）
 * 抽到本 hook，避免 ChatApp 主文件承载 IIFE + notice 字符串。
 *
 * 行为契约：与原 inline handler 100% 等价。
 */
import { useCallback } from "react";
import type { useSessionChat } from "./useSessionChat";
import type { WebRewindTarget } from "../lib/rewind-targets";

type ChatApi = ReturnType<typeof useSessionChat>;

export function useRewindConfirm({
  chat,
  rewindTargets,
  rewindIndex,
  setRewindTargets,
}: {
  chat: ChatApi;
  rewindTargets: ReadonlyArray<WebRewindTarget> | undefined;
  rewindIndex: number;
  setRewindTargets: (
    targets: ReadonlyArray<WebRewindTarget> | undefined
  ) => void;
}): () => void {
  return useCallback(() => {
    const t = rewindTargets?.[rewindIndex];
    if (!t) return;
    void (async () => {
      try {
        await chat.rewind(t.head);
        setRewindTargets(undefined);
        chat.pushNotice(
          t.head === null
            ? `已回退到 ［${t.userMessageText || "(无文本)"}］ 之前。`
            : `已将会话头指到 ［${t.userMessageText || "(无文本)"}］。`
        );
      } catch (e) {
        chat.pushNotice(
          `回退失败：${e instanceof Error ? e.message : String(e)}`
        );
      }
    })();
  }, [chat, rewindTargets, rewindIndex, setRewindTargets]);
}
