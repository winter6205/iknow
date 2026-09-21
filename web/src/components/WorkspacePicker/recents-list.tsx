/**
 * WorkspacePicker's 「已存在工作空间」 ("existing
 * workspaces") recents list.
 *
 * Moves recents rendering out of the
 * WorkspacePicker main file so the parent composition converges to ≤ 30 lines.
 *
 * Recents come from `GET /api/v1/workspaces`, all trusted
 * roots; click triggers onBind(path, { confirmTrust: false }).
 *
 *  - recents onClick appends `onClose()`, matching the submit path
 *    (clicking a recent auto-closes the picker, no manual dismissal).
 *  - basename span gets an explicit color: active inherits the button's
 *    `text-accent`; non-active adds `text-ink-2` for label clarity (previously
 *    relied on body default color, which layered badly on hover). The spec literally
 *    asks "top-level label = basename(root)(accent)" — chose active-only accent
 *    (clearer active/inactive distinction); this note records the tradeoff.
 *
 * The first recents item carries `data-ws-picker-autofocus="true"` — after
 * the popover mounts the parent's useEffect focuses that anchor (a11y: after
 * auto-open, focus enters the popover).
 */
import { basename } from "../WorkspaceChip";
import { pickRecentForBind } from "../WorkspacePicker";

export function RecentsList({
  recents,
  currentRoot,
  onBind,
  onClose,
}: {
  readonly recents: ReadonlyArray<string>;
  readonly currentRoot: string | null;
  readonly onBind: (
    path: string,
    opts?: { confirmTrust?: boolean }
  ) => Promise<void>;
  readonly onClose: () => void;
}) {
  if (recents.length === 0) return null;
  return (
    <>
      <p className="mb-1 text-ink-3">已存在工作空间</p>
      <ul
        className="flex max-h-32 flex-col gap-0.5 overflow-y-auto"
        aria-label="已存在工作空间列表"
      >
        {recents.map((r, idx) => {
          const payload = pickRecentForBind(r);
          const name = basename(r);
          const isActive = r === currentRoot;
          return (
            <li key={r}>
              <button
                type="button"
                aria-label={`选择工作空间 ${name}`}
                data-workspace-path={r}
                data-ws-picker-autofocus={idx === 0 ? "true" : undefined}
                className={`flex w-full flex-col items-start gap-0.5 truncate rounded-md px-2 py-1 text-left ${
                  isActive
                    ? "bg-accent-soft text-accent"
                    : "hover:bg-accent-soft/50 text-ink-2"
                }`}
                onClick={() => {
                  void onBind(payload.path, {
                    confirmTrust: payload.confirmTrust,
                  }).then(() => {
                    // Same as the submit path — auto-close the picker
                    // after a successful bind. On failure onBind rejects, .then
                    // never runs, and the picker stays open for the user to adjust
                    // (symmetric with submit's onNotice error path).
                    onClose();
                  });
                }}
              >
                <span className="font-mono text-[11px]">{name}</span>
                <span className="truncate font-mono text-[10px] text-ink-3">
                  {r}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
