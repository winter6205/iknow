/**
 * serve-workspace T7a — ChatApp `cyclePermMode` hook (review fix M6)。
 *
 * 把 ChatApp 内 ~12 行的 `cyclePermMode` 函数 + perm 调用模式抽到本 hook。
 * 行为契约：与原 inline handler 100% 等价。
 */
import { useCallback } from "react";
import { permissionModeLabel } from "../lib/permission-mode";
import type { usePermissionMode } from "./usePermissionMode";
import type { useSessionChat } from "./useSessionChat";

type ChatApi = ReturnType<typeof useSessionChat>;
type PermApi = ReturnType<typeof usePermissionMode>;

export function usePermissionModeToggle(
  chat: ChatApi,
  perm: PermApi
): () => Promise<void> {
  return useCallback(async () => {
    try {
      const next = await perm.cycle();
      chat.pushNotice(`权限模式：${permissionModeLabel(next)}`);
    } catch (e) {
      chat.pushNotice(
        `模式切换失败：${e instanceof Error ? e.message : String(e)}`
      );
    }
  }, [chat, perm]);
}
