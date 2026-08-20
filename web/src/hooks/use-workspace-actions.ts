/**
 * serve-workspace T7a — App 层 workspace 相关 handler 抽离 (review fix M6)。
 *
 * 把 ChatApp 内零散分布在 60+ 行内的三组 workspace handler 集中到一处 hook，
 * 让 ChatApp 主文件收敛到 ≤ 200 行：
 *  - `handleNewSession`：unbound 引导 picker / bound 直接 newSession + bumpSidebar。
 *  - `handleCreateInWorkspace`：换根 + newSession，失败走 chat.pushNotice。
 *  - `handleSelect`：切到目标会话 + bumpSidebar。
 *
 * T9b: 进站 default workspace 由 serve T9a auto-bind, `ws.bound` 永远是 truthy,
 * 因此 T5 的 `autoOpenedRef` + 一次性 effect 已是 dead code, 删除。
 * `handleNewSession` 内 unbound 分支保留 — 用户主动解绑 (极少数) 后仍引导 picker。
 *
 * T8: popover 关闭 (Esc / outside-click) + 焦点回 chip — `usePopoverDismiss`
 * effect 抽到独立 hook, 让本文件主体只关心 handler 三件套。
 *
 * 行为契约：与原 ChatApp 内 inline handler 100% 等价；只换载体。
 */
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { useSessionChat } from "./useSessionChat";
import type { useWorkspace } from "./useWorkspace";

type ChatApi = ReturnType<typeof useSessionChat>;
type WsApi = ReturnType<typeof useWorkspace>;

export type UseWorkspaceActionsResult = {
  /** Picker 显示态 — CTA / chip / /workspace 三入口共用。 */
  readonly workspaceOpen: boolean;
  /**
   * 切换 picker 开 / 关。形参兼容 React `SetStateAction<boolean>` — 调用方
   * 既可传 `true` / `false`, 也可传 `(prev) => !prev` 形式做 toggle
   * (T8 chip 二次点击切换需要)。
   */
  readonly setWorkspaceOpen: Dispatch<SetStateAction<boolean>>;
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

/**
 * serve-workspace T8 + review fix M1/L1: popover 关闭三件套 effect。
 *
 *  - `open === false` → effect 直接 return, 不挂监听, 不抢焦点。
 *  - `open === true`:
 *      a. document `mousedown` 监听 — 命中 popover 之外 → close + focus trigger。
 *      b. document `keydown` 监听 — Esc → close + focus trigger。
 *
 * 与 picker 子组件内 onClick / onKeyDown 无关 — popover 自身不内嵌焦点陷阱
 * (低耦合), 仅做 dismiss 触发。focus-return 由 effect 完成 (避免 React render
 * 期间触发 focus 的 React 18 警告)。
 *
 * a11y 红线: Esc 关后焦点必须回到 trigger (chip button), 让键盘用户能继续
 * 操作页面其他部分 (spec §a11y 红线)。
 *
 * 反馈 M1 修复: 父层 inline `onClose` 是新 closure each render, 直接放 deps
 * 会让 effect 每次 render re-attach (mousedown + keydown × 2 listeners)。
 * 把 onClose 放进 ref, effect 闭包读 ref.current() — deps 收敛到
 * `[open, triggerRef, popoverRef]`, stable identity consumers 可放心 memo。
 *
 * 反馈 L1 修复: 触发器 (chip) 已被外层 wrapper (popoverRef) 包裹
 * (ChatHeader 的 `<div ref={workspacePopoverRef}>` 包整个 chip + popover 容器),
 * trigger.contains 检查完全被 popover.contains 覆盖 — 删除以减表面。
 * 前提: 调用方必须保持这个包含关系 (本 App 调用即如此)。
 */
export function usePopoverDismiss(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
  onClose: () => void
): void {
  // M1: ref 包装 onClose — 永远读到最新 closure, 但 effect 自身不依赖其
  // identity,只在 handler 内调用,避免 re-attach。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      // L1: trigger 已被 popoverRef 包含 (见 App.tsx 的 ref 拓扑), 去掉
      // triggerRef.contains 检查以减表面, 行为等价。
      if (popoverRef.current?.contains(target)) return;
      onCloseRef.current();
      // 下一帧把焦点送回 trigger, 避免与 mouseup 顺序冲突。
      queueMicrotask(() => triggerRef.current?.focus());
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCloseRef.current();
      queueMicrotask(() => triggerRef.current?.focus());
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, triggerRef, popoverRef]);
}

export function useWorkspaceActions(
  chat: ChatApi,
  ws: WsApi
): UseWorkspaceActionsResult {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [sidebarSignal, setSidebarSignal] = useState(0);
  const bumpSidebar = useCallback(() => setSidebarSignal((n) => n + 1), []);

  /**
   * T5/T9b: unbound 状态下点「新会话」→ 打开 picker 引导选根（spec §Commands 1:
   * unbound 不可发 turn）。T9a 后, serve auto-bind 让 ws.bound 默认 truthy,
   * 这条分支只在用户主动解绑后才会触发, 是少数派路径但仍有意义 — 保留。
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
