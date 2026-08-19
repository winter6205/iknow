import { useCallback, useEffect, useState } from "react";
import * as api from "../api/client";

/**
 * serve-workspace T5: 顶栏 chip + picker 的状态锚。
 *
 * 挂载即拉 GET /api/v1/workspace + GET /api/v1/workspaces（并行）。前者失败
 * 视为 unbound + recents 空（serve 未启动或 trust 名单未装配），后者 404
 * 静默降级为空列表——recentsHome 缺席是合法的（plan §4.1 允许），不阻塞
 * 绑定主流程。`bind` 写成功后立即重读 recents，使新绑定的根出现在信任
 * 列表（plan §5 acceptance 5）。
 */
export type WorkspacePhase = "loading" | "ready" | "error";

export type WorkspaceApi = {
  readonly phase: WorkspacePhase;
  readonly bound: boolean;
  readonly root: string | null;
  readonly recents: ReadonlyArray<string>;
  readonly refresh: () => void;
  readonly bind: (
    path: string,
    opts?: { confirmTrust?: boolean }
  ) => Promise<void>;
};

export function useWorkspace(): WorkspaceApi {
  const [phase, setPhase] = useState<WorkspacePhase>("loading");
  const [bound, setBound] = useState(false);
  const [root, setRoot] = useState<string | null>(null);
  const [recents, setRecents] = useState<ReadonlyArray<string>>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setPhase("loading");
    Promise.all([
      api.getWorkspace(ctrl.signal),
      // recentsHome 缺席 → 后端 404；UI 层静默降级（chip 不阻塞主流程）。
      api
        .listTrustedWorkspaces(ctrl.signal)
        .catch(() => ({ workspaces: [] as ReadonlyArray<{ root: string }> })),
    ]).then(
      ([state, ws]) => {
        if (ctrl.signal.aborted) return;
        setBound(state.bound);
        setRoot(state.root ?? null);
        setRecents(ws.workspaces.map((w) => w.root));
        setPhase("ready");
      },
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        // GET workspace 也失败 → serve 未启动？仍以 unbound 视之，避免 chip
        // 永远 loading；err 打到 console 由运维侧收集。
        console.error("[workspace] load failed:", e);
        setBound(false);
        setRoot(null);
        setPhase("ready");
      }
    );
    return () => ctrl.abort();
  }, [reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const bind = useCallback(
    async (path: string, opts?: { confirmTrust?: boolean }) => {
      const res = await api.putWorkspace({
        path,
        confirmTrust: opts?.confirmTrust,
      });
      setBound(res.bound);
      setRoot(res.root ?? null);
      // recents 重读：trust-gated bind 不应炸 recents 读（仍可能 404）。
      try {
        const ws = await api.listTrustedWorkspaces();
        setRecents(ws.workspaces.map((w) => w.root));
      } catch {
        /* recents 缺席不影响主绑定结果 */
      }
    },
    []
  );

  return { phase, bound, root, recents, refresh, bind };
}
