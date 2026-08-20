/**
 * serve-workspace T7a — WorkspacePicker 「已存在工作空间」recents 列表。
 *
 * review fix H3 / M4 抽出来的子组件：把 recents 列表的渲染逻辑从
 * WorkspacePicker 主文件里挪出，让父组件 composition 收敛到 ≤ 30 行。
 *
 * 行为契约：recents 来自 `GET /api/v1/workspaces`，全部为已信任根；
 * 点击触发 onBind(path, { confirmTrust: false })。
 */
import { basename } from "../WorkspaceChip";
import { pickRecentForBind } from "../WorkspacePicker";

export function RecentsList({
  recents,
  currentRoot,
  onBind,
}: {
  readonly recents: ReadonlyArray<string>;
  readonly currentRoot: string | null;
  readonly onBind: (
    path: string,
    opts?: { confirmTrust?: boolean }
  ) => Promise<void>;
}) {
  if (recents.length === 0) return null;
  return (
    <>
      <p className="mb-1 text-ink-3">已存在工作空间</p>
      <ul
        className="flex max-h-32 flex-col gap-0.5 overflow-y-auto"
        aria-label="已存在工作空间列表"
      >
        {recents.map((r) => {
          const payload = pickRecentForBind(r);
          const name = basename(r);
          const isActive = r === currentRoot;
          return (
            <li key={r}>
              <button
                type="button"
                aria-label={`选择工作空间 ${name}`}
                data-workspace-path={r}
                className={`flex w-full flex-col items-start gap-0.5 truncate rounded-md px-2 py-1 text-left ${
                  isActive
                    ? "bg-accent-soft text-accent"
                    : "hover:bg-accent-soft/50"
                }`}
                onClick={() => {
                  void onBind(payload.path, {
                    confirmTrust: payload.confirmTrust,
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
