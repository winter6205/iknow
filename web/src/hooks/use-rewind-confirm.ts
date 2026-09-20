/**
 * ChatApp rewind-confirm async side-effect hook.
 *
 * Extracts the ~15-line `confirmRewind` (confirm click → chat.rewind + close
 * picker) so ChatApp's main file does not carry the IIFE + notice strings.
 *
 * Behavioral contract: 100% equivalent to the original inline handler.
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
          `已回退到 ［${t.userMessageText || "(无文本)"}］ 之前。`
        );
      } catch (e) {
        chat.pushNotice(
          `回退失败：${e instanceof Error ? e.message : String(e)}`
        );
      }
    })();
  }, [chat, rewindTargets, rewindIndex, setRewindTargets]);
}
