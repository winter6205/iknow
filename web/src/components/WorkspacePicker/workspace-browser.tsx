/**
 * WorkspacePicker's embedded subdir browser (with
 * Breadcrumbs / SubdirList subcomponents).
 *
 * Splits the long `WorkspaceBrowser()` method into:
 *  - `WorkspaceBrowser`: top-level composition (expand/collapse + browse side effect).
 *  - `Breadcrumbs`: breadcrumb path rendering (click switches browseRoot).
 *  - `SubdirList`: subdir list rendering (click switches browseRoot + replaces input).
 *
 * The `input` field was deleted from props — a dead prop no
 * consumer read. Parent `path-picker-panel.tsx` stopped passing it in sync.
 *
 * BrowserBody shell `rounded-pill` → `rounded-md`, aligning
 * with recents / subdir list-item visuals.
 *
 * Behavior contract: 100% equivalent to the original WorkspaceBrowser — same
 * useState managing entries / loading, same AbortController cancelling
 * in-flight requests, same deps pinning closures.
 */
import { useEffect, useState } from "react";
import type { WorkspaceSubdirEntry } from "../../api/client";
import {
  breadcrumbs,
  entryToInputPath,
  type BreadcrumbSegment,
} from "../../lib/workspace-browser";

export type WorkspaceBrowserProps = {
  /** base at mount (currentRoot or WSL_DEFAULT_BASE) — sets the initial expand position. */
  readonly initialBase: string;
  /** User picks a subdir → replace input. */
  readonly onPickSubdir: (path: string) => void;
  readonly onNotice: (text: string) => void;
  readonly onBrowseSubdirs: (
    root: string,
    signal?: AbortSignal
  ) => Promise<ReadonlyArray<WorkspaceSubdirEntry>>;
};

/** Breadcrumb path: each segment is a button; clicking only switches browseRoot (never touches input). */
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

/** Subdir list: each entry is a button; clicking replaces browseRoot and the input. */
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
 * Content area while the browser is expanded: breadcrumbs + list (loading / empty / entries).
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
 * 「浏览子目录」("browse subdirectories") collapsed CTA — toggles BrowserBody visibility.
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
 * WorkspaceBrowser — the subdir prober embedded in the picker.
 *
 * A single useState manages entries + loading, no caching — a user click
 * immediately triggers re-browse. The AbortController is rebuilt per browse so
 * a previous slow response cannot overwrite the current view with stale entries.
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
 * Browse side-effect hook for the expanded browser state.
 * Browse fires when expanded / browseRoot change; expanded=false skips the
 * request entirely; the AbortController is rebuilt each time to prevent stale overwrites.
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
