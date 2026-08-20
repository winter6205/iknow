/**
 * serve-workspace T7a — WorkspacePicker 「已存在工作空间」recents 列表 (T7b 修)。
 *
 * review fix H3 / M4 抽出来的子组件：把 recents 列表的渲染逻辑从
 * WorkspacePicker 主文件里挪出，让父组件 composition 收敛到 ≤ 30 行。
 *
 * 行为契约：recents 来自 `GET /api/v1/workspaces`，全部为已信任根；
 * 点击触发 onBind(path, { confirmTrust: false })。
 *
 * T7b review fix:
 *  - #2: recents onClick 末尾追加 `onClose()`，与 T3 submit 路径行为一致
 *    （点完 recents 自动关 picker，无需手动关）。
 *  - #3: basename span 显式色：active 继承 button 的 `text-accent`；非 active
 *    加 `text-ink-2` 让标签清晰（之前依赖 body 默认色，hover 时层级混乱）。
 *    AC 字面要求 "顶层 label = basename(root)(accent)" — 选择 active-only
 *    accent 方案（更清晰的 active / 非 active 区分），注释里说明权衡。
 *
 * T8: 第一个 recents 项打 `data-ws-picker-autofocus="true"` — popover 挂载后
 * 父组件 useEffect 找该锚点 focus (a11y: auto-open 后焦点进 popover)。
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
                    // T7b #2: 与 T3 submit 路径一致 — bind 成功后自动关
                    // picker。失败时 onBind reject, .then 不触发, picker
                    // 保留供用户调整（与 submit 的 onNotice 错误路径行为
                    // 对称）。
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
