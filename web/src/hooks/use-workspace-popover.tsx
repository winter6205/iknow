/**
 * Extract the ChatApp popover concern.
 *
 * History: ChatApp's main pipeline was kept ≤ 200 lines, but wiring the
 * popover forced four things (chip refs + usePopoverDismiss +
 * activeWorkspaceRoot memo + workspacePopover slot) back into ChatApp,
 * pushing it to 306 lines. This hook encapsulates them; ChatApp only consumes
 * the returned fields.
 *
 * Behavioral contract: 100% equivalent to the original inline code — same chip
 * refs, same popover ref, same dismiss listeners (already fixed in
 * usePopoverDismiss), same active-session lookup, same JSX slot. Only the
 * container changed.
 *
 * Do not widen the ChatHeader prop interface — it already got 5 props; this
 * hook introduces none, it only relocates ChatApp's bridging logic.
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
  /** chip button ref — passed through to ChatHeader / WorkspaceChip. */
  readonly chipButtonRef: React.RefObject<HTMLButtonElement | null>;
  /** popover wrapper ref — passed to ChatHeader for outside-click hit-testing. */
  readonly popoverWrapperRef: React.RefObject<HTMLDivElement | null>;
  /** popover visibility (controlled) — passed to ChatHeader to gate slot rendering. */
  readonly open: boolean;
  /** Chip second-click toggle — passed through by the parent's onOpenWorkspacePicker. */
  readonly onToggleOpen: () => void;
  /** workspaceRoot of the currently active session — feeds WorkspaceChip context awareness. */
  readonly activeWorkspaceRoot: string | null;
  /** Pre-rendered WorkspacePicker node — used by ChatHeader as the workspacePopover slot. */
  readonly workspacePopover: React.ReactNode;
};

/**
 * Bundle the popover family's state / refs / memo / slot JSX in one place.
 *  - `workspaceState`: the useWorkspaceActions output (workspaceOpen / setter).
 *  - `chat`:           used to push a notice (picker bind failure).
 *  - `ws`:             useWorkspace output — recents / root / bind / browseSubdirs.
 *
 * The caller is still ChatApp: `<ChatHeader workspacePopover={r.workspacePopover} ... />`
 * — identical props, zero extension.
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

  // usePopoverDismiss wraps onClose in a ref, so the
  // parent-inline onClose (=> setWorkspaceOpen(false)) being a fresh closure
  // each render never re-attaches the effect (see use-workspace-actions.ts).
  usePopoverDismiss(workspaceOpen, chipButtonRef, popoverWrapperRef, () =>
    setWorkspaceOpen(false)
  );

  // Look up the active session's workspaceRoot — chip display prefers the active root.
  const sessionList = useSessionList(sidebarSignal);
  const activeConversationId = chat.session?.conversation_id ?? null;
  const activeWorkspaceRoot = useMemo(() => {
    if (!activeConversationId) return null;
    const found = sessionList.sessions.find(
      (s) => s.conversation_id === activeConversationId
    );
    return found?.workspaceRoot ?? null;
  }, [activeConversationId, sessionList.sessions]);

  // Popover slot — the WorkspacePicker node; visual positioning (absolute
  // top-full right-0 mt-1 z-50) is owned by the wrapper inside ChatHeader.
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

  // For the second-click chip toggle — the parent passes this as
  // `onOpenWorkspacePicker` through to ChatHeader / WorkspaceChip.
  // setWorkspaceOpen((prev) => !prev) is the standard React toggle pattern,
  // accepting functional updates.
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
