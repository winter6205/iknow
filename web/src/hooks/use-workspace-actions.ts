/**
 * serve-workspace T7a — App 层 workspace 相关 handler + auto-open effect
 * 的纯函数抽离 (review fix M6)。
 *
 * 把 ChatApp 内零散分布在 60+ 行内的三组 workspace handler 集中到一处 hook，
 * 让 ChatApp 主文件收敛到 ≤ 200 行：
 *  - `handleNewSession`：unbound 引导 picker / bound 直接 newSession + bumpSidebar。
 *  - `handleCreateInWorkspace`：换根 + newSession，失败走 chat.pushNotice。
 *  - `handleSelect`：切到目标会话 + bumpSidebar。
 *  - `autoOpenedRef` + effect: unbound 用户首次进入自动弹 picker。
 *
 * 行为契约：与原 ChatApp 内 inline handler 100% 等价；只换载体。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { useSessionChat } from "./useSessionChat";
import type { useWorkspace } from "./useWorkspace";

type ChatApi = ReturnType<typeof useSessionChat>;
type WsApi = ReturnType<typeof useWorkspace>;

export type UseWorkspaceActionsResult = {
  /** Picker 显示态 — CTA / chip / /workspace 三入口共用。 */
  readonly workspaceOpen: boolean;
  readonly setWorkspaceOpen: (open: boolean) => void;
  /** Sidebar 列表刷新信号 — lifecycle 事件后 bump。 */
  readonly sidebarSignal: number;
  readonly bumpSidebar: () => void;
  /** 创建新会话：unbound 引导 picker；bound 直接 newSession + bumpSidebar。 */
  readonly handleNewSession: () => Promise<void>;
  /** Sidebar 组头部 + 按钮：在指定 workspace 内新建会话。 */
  readonly handleCreateInWorkspace: (root: string) => Promise<void>;
  /** Sidebar 切换会话。 */
  readonly handleSelect: (id: string) => Promise<void>;
};

export function useWorkspaceActions(
  chat: ChatApi,
  ws: WsApi
): UseWorkspaceActionsResult {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [sidebarSignal, setSidebarSignal] = useState(0);
  const bumpSidebar = useCallback(() => setSidebarSignal((n) => n + 1), []);

  // T5: 挂载一次性自动打开 picker（unbound 用户首次进站引导）。
  // 用 ref 标记 — 用户手动关闭后不再触发, 避免每次 ws.bound 重置都弹。
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (ws.phase !== "ready") return;
    if (ws.bound) return;
    autoOpenedRef.current = true;
    setWorkspaceOpen(true);
  }, [ws.phase, ws.bound]);

  /**
   * T5: unbound 状态下点「新会话」→ 打开 picker 引导选根（spec §Commands 1:
   * unbound 不可发 turn）。T6 联动改 sidebar 时这条分支继续生效。
   * ws.bound: 后端 hub.createSession 取 this.boundRoot (= ws.root) 写入
   * 新会话, 不需要额外传 workspaceRoot 参数(T7+ 后端扩展点)。
   */
  const handleNewSession = useCallback(async () => {
    if (!ws.bound) {
      setWorkspaceOpen(true);
      return;
    }
    await chat.newSession();
    bumpSidebar();
  }, [chat, bumpSidebar, ws.bound]);

  /**
   * T6: Sidebar 组头部"+"按钮回调 — 在指定 workspace 内新建会话。
   * 流程: 把 picker 绑到目标 root → 再建新会话。后端 createSession 取
   * this.boundRoot 写入新会话。失败兜底走 chat.pushNotice。
   */
  const handleCreateInWorkspace = useCallback(
    async (root: string) => {
      try {
        if (!ws.bound || ws.root !== root) {
          // sidebar 组根是从已存在的 session 文件读的, 必是已信任 — 无需
          // confirmTrust。bindWorkspace 在 recentsHome 未装配(legacy)时
          // 也总是成功。
          await ws.bind(root);
        }
        await chat.newSession();
        bumpSidebar();
      } catch (e) {
        chat.pushNotice(
          `在 ${root} 内新建会话失败：${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }
    },
    [chat, ws, bumpSidebar]
  );

  /**
   * Sidebar 切换会话。setConversation may switch to a session not yet in
   * the cached list (e.g. just-created entries still propagating); refresh
   * sidebar to be safe.
   */
  const handleSelect = useCallback(
    async (id: string) => {
      await chat.setConversation(id);
      bumpSidebar();
    },
    [chat, bumpSidebar]
  );

  return {
    workspaceOpen,
    setWorkspaceOpen,
    sidebarSignal,
    bumpSidebar,
    handleNewSession,
    handleCreateInWorkspace,
    handleSelect,
  };
}
