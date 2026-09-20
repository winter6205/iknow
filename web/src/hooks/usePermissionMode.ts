import { useCallback, useEffect, useState } from "react";
import { cyclePermissionMode, getPermissionMode } from "../api/client";
import { SessionApiError, type PermissionMode } from "../api/types";

export interface PermissionModeApi {
  /** Current permission mode; null = endpoint absent (404) or not loaded → no badge rendered. */
  readonly mode: PermissionMode | null;
  /** POST to cycle (backend SSOT nextShiftTabMode); resolves with the new mode. */
  readonly cycle: () => Promise<PermissionMode>;
}

/**
 * Permission mode (web mirror of the TUI's Shift+Tab): read once on mount;
 * endpoint absent (404, holder not assembled) → null → no badge. Cycling goes
 * through the backend SSOT cycle — the front-end never duplicates the loop semantics.
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
          // EXIT: endpoint not assembled (non-serve entry) — expected degradation, badge stays absent.
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
