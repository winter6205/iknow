import { useEffect, useState } from "react";
import { basename } from "./WorkspaceChip";
import {
  breadcrumbs,
  entryToInputPath,
  resolveBrowserRoot,
  type BreadcrumbSegment,
} from "../lib/workspace-browser";
import type { WorkspaceSubdirEntry } from "../api/client";

export type WorkspacePickerProps = {
  readonly recents: ReadonlyArray<string>;
  readonly currentRoot: string | null;
  readonly onBind: (
    path: string,
    opts?: { confirmTrust?: boolean }
  ) => Promise<void>;
  readonly onClose: () => void;
  readonly onNotice: (text: string) => void;
  /**
   * serve-workspace T3: 子目录探测器。注入而非 import api, 让 Picker
   * 在测试里能用 vi.stubGlobal("fetch") 顶替。browse 失败 (422 / network)
   * 按 `SessionApiError` 通道抛出, 此处 catch → onNotice, 不阻塞 bind。
   */
  readonly onBrowseSubdirs: (
    root: string,
    signal?: AbortSignal
  ) => Promise<ReadonlyArray<WorkspaceSubdirEntry>>;
};

/**
 * 绑定请求载荷构造（空/纯空白输入 → null；供单测与组件共享）。把这条
 * 决策从组件里拆出来是为了在 renderToStaticMarkup（无 DOM）测试场景下
 * 也能直接断言"onBind 调用带 confirmTrust 参数"的契约。
 */
export function buildBindPayload(
  input: string,
  confirming: boolean
): { path: string; confirmTrust: boolean } | null {
  const path = input.trim();
  if (!path) return null;
  return { path, confirmTrust: confirming };
}

/**
 * serve-workspace T5: 顶部分区内联 panel（镜像 McpPanel 位置——消息流上方）。
 * 绝对路径输入 + 信任确认 toggle + 已信任根列表（点击填入输入框）。
 * 绑定失败不关闭，错误走 onNotice（消息流 notice 通道）。
 */
export function WorkspacePicker(props: WorkspacePickerProps) {
  const initialBase = resolveBrowserRoot(props.currentRoot);
  const [input, setInput] = useState(props.currentRoot ?? "");
  const [binding, setBinding] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const submit = async () => {
    const payload = buildBindPayload(input, confirming);
    if (!payload) return;
    setBinding(true);
    try {
      await props.onBind(payload.path, { confirmTrust: payload.confirmTrust });
      props.onClose();
    } catch (e) {
      props.onNotice(`绑定失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBinding(false);
      setConfirming(false);
    }
  };

  return (
    <div className="border-b border-ink-3/30 bg-surface px-3 py-2 text-[12px]">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-ink">选择工作空间根</span>
        <button type="button" className="text-ink-3" onClick={props.onClose}>
          关闭
        </button>
      </div>
      <div className="flex gap-1">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="/abs/path/to/project"
          aria-label="工作空间绝对路径"
          className="min-w-0 flex-1 rounded-pill border border-ink-3/30 bg-surface px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={() => setConfirming((c) => !c)}
          title="首次绑定新绝对路径需先确认信任"
          aria-pressed={confirming}
          className={`rounded-pill px-2 py-1 text-[11px] ${confirming ? "bg-warn text-ink" : "text-ink-3 hover:text-ink"}`}
        >
          信任{confirming ? "✓" : ""}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={binding || !input.trim()}
          className="rounded-pill bg-accent px-3 py-1 text-[11px] font-medium text-ink disabled:opacity-50"
        >
          {binding ? "绑定中…" : "绑定"}
        </button>
      </div>
      <WorkspaceBrowser
        initialBase={initialBase}
        input={input}
        onPickSubdir={(p) => setInput(p)}
        onNotice={props.onNotice}
        onBrowseSubdirs={props.onBrowseSubdirs}
      />
      {props.recents.length > 0 ? (
        <>
          <p className="mt-2 mb-1 text-ink-3">已信任的根（点击选择）</p>
          <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
            {props.recents.map((r) => (
              <li key={r}>
                <button
                  type="button"
                  className={`w-full truncate rounded-pill px-2 py-1 text-left font-mono text-[11px] ${
                    r === props.currentRoot
                      ? "bg-accent-soft text-accent"
                      : "hover:bg-accent-soft/50"
                  }`}
                  onClick={() => setInput(r)}
                >
                  {basename(r)} <span className="text-ink-3">· {r}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * WorkspaceBrowser — picker 内嵌的子目录探测器 (T3)                  *
 * ------------------------------------------------------------------ *
 * 设计: 单一 useState 管 entries + loading + error, 不缓存 — 用户点选
 * 立即触发 re-browse, 不需要叠 useState stale 复杂度。AbortController
 * 随每次 browse 重建, 避免上一次慢响应被 stale-entry 覆盖当前视图。     */

export type WorkspaceBrowserProps = {
  /** mount 时的 base (currentRoot 或 WSL_DEFAULT_BASE) — 决定首次展开位置。 */
  readonly initialBase: string;
  /** 当前 input 值 — 决定浏览是否"贴合"用户已编辑路径。 */
  readonly input: string;
  /** 用户点选子目录 → 替换 input。 */
  readonly onPickSubdir: (path: string) => void;
  readonly onNotice: (text: string) => void;
  readonly onBrowseSubdirs: (
    root: string,
    signal?: AbortSignal
  ) => Promise<ReadonlyArray<WorkspaceSubdirEntry>>;
};

export function WorkspaceBrowser(props: WorkspaceBrowserProps) {
  const [expanded, setExpanded] = useState(false);
  const [browseRoot, setBrowseRoot] = useState(props.initialBase);
  const [entries, setEntries] = useState<ReadonlyArray<WorkspaceSubdirEntry>>(
    []
  );
  const [loading, setLoading] = useState(false);

  // 展开状态变化 / browseRoot 变化 → 触发 browse。
  // expanded=false 不发请求, 避免 mount 后立即空请求 + onNotice 噪音。
  // deps 仅含 stable 引用 (browse 函数由 useWorkspace.useCallback 锁定,
  // onNotice 由父组件锁定)。`props.onPickSubdir` 等每次 render 重新构造的
  // inline lambda 不参与 deps, 避免每次 render 都触发重 browse。
  const { onBrowseSubdirs, onNotice } = props;
  useEffect(() => {
    if (!expanded) return;
    const ctrl = new AbortController();
    setLoading(true);
    setEntries([]);
    onBrowseSubdirs(browseRoot, ctrl.signal)
      .then(
        (es) => {
          if (ctrl.signal.aborted) return;
          setEntries(es);
        },
        (e: unknown) => {
          if (ctrl.signal.aborted) return;
          onNotice(`浏览失败：${e instanceof Error ? e.message : String(e)}`);
        }
      )
      .finally(() => {
        if (ctrl.signal.aborted) return;
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [expanded, browseRoot, onBrowseSubdirs, onNotice]);

  const segs = breadcrumbs(browseRoot);
  const onPickCrumb = (s: BreadcrumbSegment) => {
    setBrowseRoot(s.path);
    // crumb 切层时只更新 browse 视图, 不替换 input — 用户可能只浏览不输入
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label="浏览子目录"
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1 text-ink-3 hover:text-ink"
      >
        <span aria-hidden="true">{expanded ? "▼" : "▶"}</span>
        <span>浏览子目录</span>
      </button>
      {expanded ? (
        <div className="mt-1 rounded-pill border border-ink-3/30 px-2 py-1.5">
          <nav
            aria-label="当前路径"
            className="flex flex-wrap gap-1 font-mono text-[11px] text-ink-3"
          >
            {segs.map((s, i) => (
              <span key={`${s.path}-${i}`} className="flex items-center gap-1">
                {i > 0 ? <span aria-hidden="true">/</span> : null}
                <button
                  type="button"
                  onClick={() => onPickCrumb(s)}
                  className="rounded-pill px-1 hover:bg-accent-soft/50 hover:text-ink"
                >
                  {s.name}
                </button>
              </span>
            ))}
          </nav>
          {loading ? (
            <p className="mt-1 text-[11px] text-ink-3">浏览中…</p>
          ) : entries.length === 0 ? (
            <p className="mt-1 text-[11px] text-ink-3">无子目录</p>
          ) : (
            <ul className="mt-1 flex max-h-32 flex-col gap-0.5 overflow-y-auto">
              {entries.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    onClick={() => {
                      const next = entryToInputPath(e);
                      setBrowseRoot(next);
                      props.onPickSubdir(next);
                    }}
                    className="w-full truncate rounded-pill px-2 py-1 text-left font-mono text-[11px] hover:bg-accent-soft/50"
                  >
                    {e.name} <span className="text-ink-3">· {e.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
