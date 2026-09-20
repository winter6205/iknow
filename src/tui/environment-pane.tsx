/** @jsxImportSource @opentui/react */
/**
 * src/tui/environment-pane.tsx
 *
 * A dedicated slot for the human-readable chrome bar in the TUI. Component
 * name is fixed to `EnvironmentPane`.
 *
 *   - Single data source: the `env_snapshot` stream event emitted by the
 *     harness at turn boundaries (computed and emitted by loop-engine right
 *     after the model-facing status bar; never enters messages / verify /
 *     the ADR-0028 bar). `envSnapshotFromEvent` projects: env_snapshot event
 *     → frozen EnvSnapshot; any other event → null.
 *   - Replace-on-event: each arriving event wholesale-replaces the single
 *     state slot (envSnapshot); no history, no merge. Unlike the
 *     model-facing status-bar projection (ADR-0028), environment presence is
 *     not session-scoped — one globally shared state slot, not keyed by
 *     conversationId.
 *   - Rendering: normal → cwd + branch + dirtyCount + diffPreview
 *     (diffPreview re-truncated via truncateByCodepoints, cap
 *     MAX_ENV_DIFF_CHARS = 2000 cp); EXIT-degraded → placeholders keyed by
 *     `degradeReason`: `(cwd unavailable)` / `(not a git repo)` /
 *     `(git unavailable)`; null (no event yet) → component returns null,
 *     0 rows.
 *   - Row budget: envSnapshotLines row count → chromeReserveRows.envPaneRows
 *     (SSOT, same linkage style as the ADR-0028 status-bar budget; baseline
 *     7 unchanged).
 *   - Glyph discipline: geometric glyphs ⌂ / Δ (project convention, no
 *     emoji).
 *   - Session location line: the bottom bar keeps a **permanent** row
 *     `path · branch`; being bound to a task tree only swaps the path on the
 *     same row for the tree root (live taskRoot first, else the read-only
 *     session workspaceRoot passthrough) — it never toggles visibility and
 *     carries no dirty/diff. Mounted by app.tsx into the envPaneRows slot of
 *     the chat chrome.
 *   - Reverse contract: this file references nothing from the model-facing
 *     status bar (event types / snapshot shape / ledger reader) — it runs as
 *     an independent parallel stream beside the ADR-0028 projection (a grep
 *     guard is pinned by tests/tui/environment-pane.test.tsx).
 */
import type { ReactNode } from "react";
import type { EnvDegradeReason, EnvSnapshot } from "../harness/env-snapshot.js";
import {
  MAX_ENV_DIFF_CHARS,
  truncateByCodepoints,
} from "../harness/env-snapshot.js";
import type { HarnessStreamEvent } from "../harness/stream.js";
// Display condition is anchored to task-worktree semantics — reuse the
// session-api path predicate (same-source SSOT; the judgment matches the
// ownership anchor used by the worktree rebind path).
import { isTaskWorktreePath } from "../session-api/worktree-rebind.js";
import { clipOneLineVisual, visualWidth } from "./tool-summary.js";
import { tuiPalette } from "./theme.js";

// Geometric glyphs (project convention, no emoji): ⌂ = house (U+2302), Δ = delta (U+0394).
const HEADER_PREFIX = "⌂ ";
const DIFF_PREFIX = "Δ ";

/** EXIT placeholders (literal-fixed, do not localize). */
const EXIT_PLACEHOLDER: Record<EnvDegradeReason, string> = {
  cwd_unavailable: "(cwd unavailable)",
  not_a_git_repo: "(not a git repo)",
  git_unavailable: "(git unavailable)",
};

// ---------------------------------------------------------------------------
// Projection: event → EnvSnapshot (replace-on-event by construction)
// ---------------------------------------------------------------------------

/**
 * Event → EnvSnapshot projection (env_snapshot only; any other event → null).
 * Returns a fully independent frozen snapshot — same shape as
 * replace-on-event: reads and retains no prior state, so
 * setEnvSnapshot(thisProjection) on the app's single state slot is a
 * wholesale replace and can never mix old and new.
 *
 * Note on the null arm: the app call site (app.tsx onStream) already calls
 * inside the `event.type === "env_snapshot"` branch, so null is type-
 * unreachable there; the full signature is kept (not narrowed for the call
 * site) to drive unit tests directly and for defensive narrowing.
 */
export function envSnapshotFromEvent(
  event: HarnessStreamEvent
): EnvSnapshot | null {
  if (event.type !== "env_snapshot") return null;
  return Object.freeze({
    cwd: event.snapshot.cwd,
    gitBranch: event.snapshot.gitBranch,
    gitStatus: event.snapshot.gitStatus,
    dirtyCount: event.snapshot.dirtyCount,
    diffPreview: event.snapshot.diffPreview,
    degradeReason: event.snapshot.degradeReason,
  });
}

// ---------------------------------------------------------------------------
// Projection: EnvSnapshot → display lines
// ---------------------------------------------------------------------------

export interface EnvSnapshotLine {
  readonly fg: string;
  readonly text: string;
}

/**
 * Pure projection: snapshot → display lines (touches no OpenTUI, drivable by
 * unit tests directly). null → empty array (component renders null, 0 rows
 * accounted).
 *
 * Row counts (display-side cap):
 *   - null → 0 rows
 *   - EXIT-degraded → 1 row (placeholder)
 *   - normal (cwd + branch + dirty) → 1 row; diffPreview present adds 1
 *     (collapsed into a single line so the chrome never explodes in rows)
 */
export function envSnapshotLines(
  snapshot: EnvSnapshot | null,
  cols: number
): ReadonlyArray<EnvSnapshotLine> {
  if (snapshot === null) return [];
  // EXIT: degradeReason non-null → typed placeholder (harness must set it).
  if (snapshot.degradeReason !== null) {
    const placeholder = EXIT_PLACEHOLDER[snapshot.degradeReason];
    const text =
      snapshot.degradeReason === "cwd_unavailable"
        ? `${HEADER_PREFIX}${placeholder}`
        : `${HEADER_PREFIX}${snapshot.cwd} · ${placeholder}`;
    return [
      {
        fg: tuiPalette.dim,
        text: clipOneLineVisual(text, Math.max(0, cols)),
      },
    ];
  }
  // Normal: header row (⌂ cwd · branch · uncommitted n). The uncommitted
  // labels below are user-visible UI text.
  const branchLabel = snapshot.gitBranch ?? "(no branch)";
  const dirtyLabel =
    snapshot.dirtyCount === null
      ? "未提交 ?"
      : snapshot.dirtyCount === 0
        ? "clean"
        : `未提交 ${snapshot.dirtyCount}`;
  const header: EnvSnapshotLine = {
    fg: tuiPalette.dim,
    text: clipOneLineVisual(
      `${HEADER_PREFIX}${snapshot.cwd} · ${branchLabel} · ${dirtyLabel}`,
      Math.max(0, cols)
    ),
  };
  if (snapshot.diffPreview === null) return [header];
  // Diff row: collapse multi-line whitespace into one line → safety
  // re-truncate (contract cap MAX_ENV_DIFF_CHARS; the producer already
  // guarantees ≤ cap, this is the belt-and-braces cut; the UI-layer cap is
  // non-cancellable) → clipOneLineVisual to cols as one line; CJK-safe (same
  // visualWidth standard).
  const collapsed = snapshot.diffPreview.replace(/\s+/g, " ").trim();
  const bounded = truncateByCodepoints(collapsed, MAX_ENV_DIFF_CHARS);
  const budget = Math.max(0, cols - visualWidth(DIFF_PREFIX));
  const diffLine: EnvSnapshotLine = {
    fg: tuiPalette.dim,
    text: clipOneLineVisual(
      `${DIFF_PREFIX}${bounded}`,
      budget + visualWidth(DIFF_PREFIX)
    ),
  };
  return [header, diffLine];
}

// ---------------------------------------------------------------------------
// Bound-root resolution: data source for swapping the session-location path (ADR-0037, read-only)
// ---------------------------------------------------------------------------

/**
 * Prefer the live taskRoot of the bound root (readable within the very turn
 * of a rebind), otherwise the session file's workspaceRoot. Still the
 * "is this a task tree" decision seam (`isTaskWorktreePath`, reusing the
 * session-api deterministic naming) — but this predicate **no longer decides
 * the location row's visibility**; it only picks, on the same row, whether
 * the path comes from the bound root or the project root. Data sources =
 * read-only session workspaceRoot passthrough + the live cell; this function
 * has zero git imports and performs zero git operations.
 */
export function resolveWorktreeChromeRoot(
  sessionWorkspaceRoot: string | null | undefined,
  liveTaskRoot: string | null | undefined
): string | undefined {
  if (liveTaskRoot !== null && liveTaskRoot !== undefined) {
    const live = liveTaskRoot.trim();
    if (live.length > 0 && isTaskWorktreePath(live)) return live;
  }
  if (sessionWorkspaceRoot !== null && sessionWorkspaceRoot !== undefined) {
    const session = sessionWorkspaceRoot.trim();
    if (session.length > 0 && isTaskWorktreePath(session)) return session;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Projection: session location row (session location chrome)
// ---------------------------------------------------------------------------

/** Root-relative display path: under the project root → `~/projects/iknow`
 *  form (project-root leaf name + relative segments); otherwise the root as
 *  given (the caller already uses the project root as the display base). */
export function locationDisplayPath(
  root: string,
  projectRoot?: string
): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalizedRoot.length === 0) return "";
  if (projectRoot !== undefined && projectRoot.trim().length > 0) {
    const normalizedProject = projectRoot
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
    if (
      normalizedProject.length > 0 &&
      (normalizedRoot === normalizedProject ||
        normalizedRoot.startsWith(`${normalizedProject}/`))
    ) {
      const leaf = normalizedProject.slice(
        normalizedProject.lastIndexOf("/") + 1
      );
      const rel = normalizedRoot
        .slice(normalizedProject.length)
        .replace(/^\//, "");
      return rel.length > 0 ? `${leaf}/${rel}` : leaf;
    }
  }
  return normalizedRoot;
}

/**
 * Session location row (docs/CONTEXT.md `session location chrome`) — a
 * **permanent single line** in the bottom bar, e.g. `~/projects/iknow ·
 * master` (path · branch).
 *
 *   - Permanent: main repo / non-task paths still render it; visibility is
 *     not decided by binding (the old `worktreeIsolationLines` "task tree
 *     only" contract is void).
 *   - Bound to a task tree: the same slot **swaps the path** (live taskRoot
 *     first, else the session `workspaceRoot`; when both are missing, fall
 *     back to the unbound form) — no extra row, never from nothing to
 *     something.
 *   - No dirty / diff (the chrome says "where", not repo state; state belongs
 *     to the env_snapshot diff surface).
 *   - Branch default: unbound or unknown branch → path segment only (no
 *     placeholder).
 *   - Pure function: callers (EnvironmentPane / app.tsx) feed cols and data
 *     sources.
 */
export function sessionLocationLines(opts: {
  /** Main project root (startup cwd / workspaceRoot). */
  readonly projectRoot: string;
  /** Task tree bound to the session (live taskRoot first, else session workspaceRoot). */
  readonly worktreeRoot?: string | null;
  /** Git branch (from env_snapshot; pass undefined when unknown). */
  readonly branch?: string | null;
  readonly cols: number;
}): ReadonlyArray<EnvSnapshotLine> {
  const bound =
    opts.worktreeRoot === null || opts.worktreeRoot === undefined
      ? ""
      : opts.worktreeRoot.trim();
  const path =
    bound.length > 0
      ? locationDisplayPath(bound, opts.projectRoot)
      : locationDisplayPath(opts.projectRoot, opts.projectRoot);
  if (path.length === 0) return [];
  const branch =
    opts.branch === null || opts.branch === undefined ? "" : opts.branch.trim();
  const text = clipOneLineVisual(
    branch.length > 0 ? `${path} · ${branch}` : path,
    Math.max(0, opts.cols)
  );
  return [{ fg: tuiPalette.dim, text }];
}

// ---------------------------------------------------------------------------
// Render shell
// ---------------------------------------------------------------------------

export interface EnvironmentPaneProps {
  /** Latest environment presence snapshot (env_snapshot event projection); null = no event yet. */
  readonly snapshot: EnvSnapshot | null;
  readonly cols: number;
  /** Project root (path base for the permanent location row; absent → no location row). */
  readonly projectRoot?: string;
  /** Task-tree root bound to the session; when given, the same slot swaps to that path. */
  readonly worktreeRoot?: string | null;
}

/** Location row = path + branch (branch taken from the snapshot; absent snapshot → path segment only). */
function locationLinesForPane(
  props: EnvironmentPaneProps
): ReadonlyArray<EnvSnapshotLine> {
  return sessionLocationLines({
    projectRoot: props.projectRoot!,
    ...(props.worktreeRoot !== undefined
      ? { worktreeRoot: props.worktreeRoot }
      : {}),
    branch: props.snapshot?.gitBranch ?? null,
    cols: props.cols,
  });
}

export function EnvironmentPane(props: EnvironmentPaneProps): ReactNode {
  const lines =
    props.projectRoot === undefined
      ? envSnapshotLines(props.snapshot, props.cols)
      : locationLinesForPane(props);
  if (lines.length === 0) return null;
  return (
    <box flexDirection="column">
      {lines.map((line, idx) => (
        <text key={idx} fg={line.fg} wrapMode="none">
          {line.text}
        </text>
      ))}
    </box>
  );
}
