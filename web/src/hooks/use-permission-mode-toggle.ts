/**
 * ChatApp `cyclePermMode` hook.
 *
 * Extracts the ~12-line `cyclePermMode` + perm call pattern from ChatApp.
 * Behavioral contract: 100% equivalent to the original inline handler.
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
