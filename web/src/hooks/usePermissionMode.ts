import { useCallback, useEffect, useState } from "react";
import { cyclePermissionMode, getPermissionMode } from "../api/client";
import { SessionApiError, type PermissionMode } from "../api/types";

export interface PermissionModeApi {
  /** 当前 permission mode；null = 端点缺席（404）或未加载 → 徽标不渲染。 */
  readonly mode: PermissionMode | null;
  /** POST 循环切换（后端 SSOT nextShiftTabMode），返回切换后的 mode。 */
  readonly cycle: () => Promise<PermissionMode>;
}

/**
 * permission mode（TUI Shift+Tab 的 web 镜像）：挂载时读一次当前值；
 * 端点缺席（404，holder 未装配）→ null → 徽标不渲染。切换走后端 SSOT
 * cycle，前端不复制循环语义。
 */
export function usePermissionMode(): PermissionModeApi {
  const [mode, setMode] = useState<PermissionMode | null>(null);
  useEffect(() => {
    let cancelled = false;
    getPermissionMode()
      .then((m) => {
        if (!cancelled) setMode(m);
      })
      .catch((err: unknown) => {
        if (err instanceof SessionApiError && err.status === 404) {
          // EXIT: 端点未装配（非 serve 入口）—— 预期降级，徽标保持缺席。
          return;
        }
        console.warn("[permission-mode] initial read failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const cycle = useCallback(async (): Promise<PermissionMode> => {
    const next = await cyclePermissionMode();
    setMode(next);
    return next;
  }, []);
  return { mode, cycle };
}
