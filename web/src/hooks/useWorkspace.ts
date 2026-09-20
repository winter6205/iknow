import { useCallback, useEffect, useState } from "react";
import * as api from "../api/client";
import type { WorkspaceSubdirEntry } from "../api/client";

/**
 * State anchor for the top-bar chip + picker.
 *
 * On mount, fetch GET /api/v1/workspace and GET /api/v1/workspaces in
 * parallel. The former failing means unbound + empty recents (serve not
 * running, or the trust list not assembled); the latter's 404 degrades
 * silently to an empty list — an absent recentsHome is legal
 * and never blocks the bind flow. After a successful `bind`,
 * refetch recents immediately so the newly bound root appears in the trust
 * list.
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
  /**
   * Probe one directory level, passing through
   * `listWorkspaceSubdirs`. No caching — the picker browses on open and
   * re-browses on each user click; an extra useState layer would only add
   * staleness complexity. Failures throw `SessionApiError` through the
   * existing `request<T>` channel; callers fall back to onNotice.
   */
  readonly browseSubdirs: (
    root: string,
    signal?: AbortSignal
  ) => Promise<ReadonlyArray<WorkspaceSubdirEntry>>;
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
      // absent recentsHome → backend 404; UI degrades silently (chip never blocks the main flow).
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
        // GET workspace also failed — maybe serve isn't running? Still treat
        // as unbound so the chip never hangs in loading; the error goes to
        // console for ops-side collection.
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
      // Refetch recents: a trust-gated bind must not break the recents read (it can still 404).
      try {
        const ws = await api.listTrustedWorkspaces();
        setRecents(ws.workspaces.map((w) => w.root));
      } catch {
        /* absent recents do not affect the bind result */
      }
    },
    []
  );

  const browseSubdirs = useCallback(
    async (root: string, signal?: AbortSignal) => {
      const res = await api.listWorkspaceSubdirs(root, signal);
      return res.entries;
    },
    []
  );

  return { phase, bound, root, recents, refresh, bind, browseSubdirs };
}
