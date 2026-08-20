/**
 * serve-workspace T7a — WorkspacePicker 内嵌子目录浏览器（含 Breadcrumbs /
 * SubdirList 子组件）。
 *
 * review fix H3 / M4：把 `WorkspaceBrowser()` 长方法拆为：
 *  - `WorkspaceBrowser`: 顶层 composition（展开/折叠 + browse 副作用）。
 *  - `Breadcrumbs`: 面包屑路径渲染（点击切换 browseRoot）。
 *  - `SubdirList`: 子目录列表渲染（点击切换 browseRoot + 替换 input）。
 *
 * T7b review fix L1: `input` 字段从 props 中删除 — 该字段从未被任何消费者
 * 读取（dead prop）。父端 `path-picker-panel.tsx` 同步停止传入。
 *
 * T7b review fix #4: BrowserBody 外壳 `rounded-pill` → `rounded-md`，与
 * recents / subdir 列表项视觉对齐。
 *
 * 行为契约：与原 WorkspaceBrowser 100% 等价 — 同样的 useState 管 entries /
 * loading，同样的 AbortController 取消在途请求，同样的 deps 锁闭包。
 */
import { useEffect, useState } from "react";
import type { WorkspaceSubdirEntry } from "../../api/client";
import {
  breadcrumbs,
  entryToInputPath,
  type BreadcrumbSegment,
} from "../../lib/workspace-browser";

export type WorkspaceBrowserProps = {
  /** mount 时的 base (currentRoot 或 WSL_DEFAULT_BASE) — 决定首次展开位置。 */
  readonly initialBase: string;
  /** 用户点选子目录 → 替换 input。 */
  readonly onPickSubdir: (path: string) => void;
  readonly onNotice: (text: string) => void;
  readonly onBrowseSubdirs: (
    root: string,
    signal?: AbortSignal
  ) => Promise<ReadonlyArray<WorkspaceSubdirEntry>>;
};

/** 面包屑路径：每段是一个 button，点击仅切 browseRoot（不动 input）。 */
function Breadcrumbs({
  segs,
  onPickCrumb,
}: {
  segs: ReadonlyArray<BreadcrumbSegment>;
  onPickCrumb: (s: BreadcrumbSegment) => void;
}) {
  return (
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
  );
}

/** 子目录列表：每条是一个 button，点击替换 browseRoot + 替换 input。 */
function SubdirList({
  entries,
  onPickSubdir,
  setBrowseRoot,
}: {
  entries: ReadonlyArray<WorkspaceSubdirEntry>;
  onPickSubdir: (path: string) => void;
  setBrowseRoot: (path: string) => void;
}) {
  if (entries.length === 0) {
    return <p className="mt-1 text-[11px] text-ink-3">无子目录</p>;
  }
  return (
    <ul className="mt-1 flex max-h-32 flex-col gap-0.5 overflow-y-auto">
      {entries.map((e) => (
        <li key={e.path}>
          <button
            type="button"
            aria-label={`进入子目录 ${e.name}`}
            onClick={() => {
              const next = entryToInputPath(e);
              setBrowseRoot(next);
              onPickSubdir(next);
            }}
            className="w-full truncate rounded-md px-2 py-1 text-left font-mono text-[11px] hover:bg-accent-soft/50"
          >
            {e.name} <span className="text-ink-3">· {e.path}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * 浏览器展开态下的内容区: breadcrumbs + 列表 (loading / empty / entries)。
 */
function BrowserBody({
  browseRoot,
  entries,
  loading,
  onPickCrumb,
  onPickSubdir,
  setBrowseRoot,
}: {
  browseRoot: string;
  entries: ReadonlyArray<WorkspaceSubdirEntry>;
  loading: boolean;
  onPickCrumb: (s: BreadcrumbSegment) => void;
  onPickSubdir: (path: string) => void;
  setBrowseRoot: (path: string) => void;
}) {
  return (
    <div className="mt-1 rounded-md border border-ink-3/30 px-2 py-1.5">
      <Breadcrumbs segs={breadcrumbs(browseRoot)} onPickCrumb={onPickCrumb} />
      {loading ? (
        <p className="mt-1 text-[11px] text-ink-3">浏览中…</p>
      ) : (
        <SubdirList
          entries={entries}
          onPickSubdir={onPickSubdir}
          setBrowseRoot={setBrowseRoot}
        />
      )}
    </div>
  );
}

/**
 * 「浏览子目录」折叠 CTA — 触发 BrowserBody 显隐。
 */
function BrowserToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label="浏览子目录"
      onClick={onToggle}
      className="flex items-center gap-1 text-ink-3 hover:text-ink"
    >
      <span aria-hidden="true">{expanded ? "▼" : "▶"}</span>
      <span>浏览子目录</span>
    </button>
  );
}

/**
 * WorkspaceBrowser — picker 内嵌的子目录探测器 (T3)。
 *
 * 单一 useState 管 entries + loading, 不缓存 — 用户点选立即触发
 * re-browse。AbortController 随每次 browse 重建, 避免上一次慢响应被
 * stale-entry 覆盖当前视图。
 */
export function WorkspaceBrowser(props: WorkspaceBrowserProps) {
  const [expanded, setExpanded] = useState(false);
  const [browseRoot, setBrowseRoot] = useState(props.initialBase);
  const { entries, loading } = useBrowseEntries({
    expanded,
    browseRoot,
    onBrowseSubdirs: props.onBrowseSubdirs,
    onNotice: props.onNotice,
  });
  return (
    <div className="mt-2">
      <BrowserToggle
        expanded={expanded}
        onToggle={() => setExpanded((e) => !e)}
      />
      {expanded ? (
        <BrowserBody
          browseRoot={browseRoot}
          entries={entries}
          loading={loading}
          onPickCrumb={(s) => setBrowseRoot(s.path)}
          onPickSubdir={props.onPickSubdir}
          setBrowseRoot={setBrowseRoot}
        />
      ) : null}
    </div>
  );
}

/**
 * 浏览器展开态下的 browse 副作用 hook（T7a 抽出）。
 * expanded / browseRoot 变化时触发 browse；expanded=false 直接跳过不发请求，
 * AbortController 每次重建防止 stale 覆盖。
 */
function useBrowseEntries({
  expanded,
  browseRoot,
  onBrowseSubdirs,
  onNotice,
}: {
  expanded: boolean;
  browseRoot: string;
  onBrowseSubdirs: (
    root: string,
    signal?: AbortSignal
  ) => Promise<ReadonlyArray<WorkspaceSubdirEntry>>;
  onNotice: (text: string) => void;
}): {
  entries: ReadonlyArray<WorkspaceSubdirEntry>;
  loading: boolean;
} {
  const [entries, setEntries] = useState<ReadonlyArray<WorkspaceSubdirEntry>>(
    []
  );
  const [loading, setLoading] = useState(false);
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
  return { entries, loading };
}
