/**
 * serve-workspace T8/T9 review fix (M5) — ChatApp popover concern 抽离。
 *
 * 历史: ChatApp 主管线 ≤ 200 行 (T7a 目标),但 T8 popover 接入把 chip refs +
 * usePopoverDismiss + activeWorkspaceRoot memo + workspacePopover 插槽四件
 * 套硬塞进 ChatApp,推回 306 行 (T7a docstring 上限 200 行)。本 hook 把这
 * 四件套封装成 `useWorkspacePopover`,ChatApp 只消费返回字段。
 *
 * 行为契约: 与原 ChatApp inline 100% 等价 — 同 chip refs、同 popover ref、
 * 同 dismiss 监听 (M1 + L1 已在 usePopoverDismiss 内修复)、同 active
 * session lookup、同 JSX 插槽。仅换容器。
 *
 * 不要扩展 ChatHeader prop 接口 — T8 已加 5 个 prop,本 hook 不引入新
 * prop,只是把 ChatApp 内的桥接逻辑挪出来。
 */
import { useMemo, useRef } from "react";
import type { useSessionChat } from "./useSessionChat";
import type { useWorkspace } from "./useWorkspace";
import { useSessionList } from "./use-session-list";
import {
  usePopoverDismiss,
  type UseWorkspaceActionsResult,
} from "./use-workspace-actions";
import { WorkspacePicker } from "../components/WorkspacePicker";

type ChatApi = ReturnType<typeof useSessionChat>;
type WsApi = ReturnType<typeof useWorkspace>;

export type WorkspacePopoverResult = {
  /** chip button ref — 透传给 ChatHeader / WorkspaceChip。 */
  readonly chipButtonRef: React.RefObject<HTMLButtonElement | null>;
  /** popover wrapper ref — 透传给 ChatHeader,供 outside-click hit-testing。 */
  readonly popoverWrapperRef: React.RefObject<HTMLDivElement | null>;
  /** popover 显示态 (受控) — 透传给 ChatHeader 控制插槽渲染。 */
  readonly open: boolean;
  /** Chip 二次点击 toggle 用 — 父层 onOpenWorkspacePicker 透传。 */
  readonly onToggleOpen: () => void;
  /** 当前 active session 的 workspaceRoot — 喂给 WorkspaceChip 上下文感知。 */
  readonly activeWorkspaceRoot: string | null;
  /** 渲染好的 WorkspacePicker 节点 — ChatHeader 用作 workspacePopover 插槽。 */
  readonly workspacePopover: React.ReactNode;
};

/**
 * 把 popover 一族的 state / refs / memo / 插槽 JSX 封到一处。
 *  - `workspaceState`: T7a 的 useWorkspaceActions 出口 (workspaceOpen / set)。
 *  - `chat`:           T8 加的 — 用来 push notice (picker bind 失败提示)。
 *  - `ws`:             useWorkspace 出口 — recents / root / bind / browseSubdirs。
 *
 * 调用方依然是 ChatApp: `<ChatHeader workspacePopover={r.workspacePopover} ... />`
 * —— props 与 T8 完全一致,零扩展。
 */
export function useWorkspacePopover(
  workspaceState: Pick<
    UseWorkspaceActionsResult,
    "workspaceOpen" | "setWorkspaceOpen" | "sidebarSignal"
  >,
  chat: ChatApi,
  ws: WsApi
): WorkspacePopoverResult {
  const { workspaceOpen, setWorkspaceOpen, sidebarSignal } = workspaceState;
  const chipButtonRef = useRef<HTMLButtonElement | null>(null);
  const popoverWrapperRef = useRef<HTMLDivElement | null>(null);

  // M1 + L1 修复: usePopoverDismiss 内部用 onCloseRef 包装,父层 inline
  // onClose (=> setWorkspaceOpen(false)) 每次 render 是新 closure,但 effect
  // 不会因为 onClose 变化而 re-attach (见 use-workspace-actions.ts)。
  usePopoverDismiss(workspaceOpen, chipButtonRef, popoverWrapperRef, () =>
    setWorkspaceOpen(false)
  );

  // T8: lookup active session 的 workspaceRoot — chip 显示优先级 active 优先。
  const sessionList = useSessionList(sidebarSignal);
  const activeConversationId = chat.session?.conversation_id ?? null;
  const activeWorkspaceRoot = useMemo(() => {
    if (!activeConversationId) return null;
    const found = sessionList.sessions.find(
      (s) => s.conversation_id === activeConversationId
    );
    return found?.workspaceRoot ?? null;
  }, [activeConversationId, sessionList.sessions]);

  // T8: popover 插槽 — WorkspacePicker 节点,视觉定位 (absolute top-full
  // right-0 mt-1 z-50) 由 ChatHeader 内 wrapper 负责。
  const workspacePopover = workspaceOpen ? (
    <WorkspacePicker
      recents={ws.recents}
      currentRoot={ws.root}
      onBind={ws.bind}
      onClose={() => setWorkspaceOpen(false)}
      onNotice={chat.pushNotice}
      onBrowseSubdirs={ws.browseSubdirs}
    />
  ) : null;

  // Chip 二次点击切换用 — 父层把此函数作为 `onOpenWorkspacePicker` 透传
  // 给 ChatHeader / WorkspaceChip。setWorkspaceOpen((prev) => !prev) 是
  // React 标准 toggle pattern,接受函数式更新。
  const onToggleOpen = () => setWorkspaceOpen((prev) => !prev);

  return {
    chipButtonRef,
    popoverWrapperRef,
    open: workspaceOpen,
    onToggleOpen,
    activeWorkspaceRoot,
    workspacePopover,
  };
}
