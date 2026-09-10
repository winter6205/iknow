/** @jsxImportSource @opentui/react */
/**
 * src/tui/environment-pane.tsx
 *
 * #653 G1 T5 / DESIGN-ENVIRONMENT-PRESENT:TUI 人读 chrome 条的独立槽位。
 * 组件名钉死 `EnvironmentPane`(T1 二选一;`EnvPresenceStrip` 未采用)。
 *
 *   - 数据唯一来源:harness 在回合边界发出的 `env_snapshot` 流事件
 *     (loop-engine 在现势栏追加之后的同一回合边界计算点 emit;永不进
 *     messages / verify / ADR-0028 栏)。`envSnapshotFromEvent` 投影:
 *     env_snapshot 事件 → 冻结 EnvSnapshot;其余事件 → null。
 *   - replace-on-event:事件到达时整体替换单 state 槽(envSnapshot),无历史、
 *     无合并。与模型向状态栏投影(ADR-0028)不同:环境现势不属于会话 ——
 *     全局共享单 state 槽,不按 conversationId 分键。
 *   - 渲染:正常态 → cwd + branch + dirtyCount + diffPreview(diffPreview
 *     经 truncateByCodepoints 兜底再截,上限 MAX_ENV_DIFF_CHARS = 2000 cp);
 *     EXIT 退化态按 `degradeReason` 投影 DESIGN 占位:
 *     `(cwd unavailable)` / `(not a git repo)` / `(git unavailable)`;
 *     null(尚无事件)→ 组件返 null,行数 0。
 *   - 行账:envSnapshotLines 行数 → chromeReserveRows.envPaneRows(SSOT,
 *     与 ADR-0028 状态栏行账同款 linkage;基线 7 不变)。
 *   - 字形纪律:几何字形 ⌂ / Δ(项目惯例,spec #146:86 无 emoji)。
 *   - D7 / SC6 追加投影:sessionLocationLines —— 会话位置行(session
 *     location chrome)。底栏**常驻**一行 `路径 · 分支`,绑任务树只把同一
 *     行的路径换成树上根(活 taskRoot 优先,否则会话 workspaceRoot 只读
 *     透传),不决定显隐、不带 dirty/diff。app.tsx 挂在 chat chrome 的
 *     envPaneRows 槽位。
 *   - 反向契约:本文件零引用模型向状态栏的事件类型 / 快照结构 / 账本读取器
 *     —— 与 ADR-0028 投影平行独立流(grep 守卫由 tests/tui/
 *     environment-pane.test.tsx 钉死)。
 */
import type { ReactNode } from "react";
import type { EnvDegradeReason, EnvSnapshot } from "../harness/env-snapshot.js";
import {
  MAX_ENV_DIFF_CHARS,
  truncateByCodepoints,
} from "../harness/env-snapshot.js";
import type { HarnessStreamEvent } from "../harness/stream.js";
// Review Medium-2 (2026-08-29):显示条件锚定 task worktree 语义 —— 复用
// session-api 的路径判定纯函数(同源 SSOT,判定与 T3/T4 所有权锚一致)。
import { isTaskWorktreePath } from "../session-api/worktree-rebind.js";
import { clipOneLineVisual, visualWidth } from "./tool-summary.js";
import { tuiPalette } from "./theme.js";

// 几何字形(项目惯例,无 emoji):⌂ = 房(U+2302),Δ = delta(U+0394)。
const HEADER_PREFIX = "⌂ ";
const DIFF_PREFIX = "Δ ";

/** DESIGN-ENVIRONMENT-PRESENT EXIT 占位(字面钉死,勿改中文化)。 */
const EXIT_PLACEHOLDER: Record<EnvDegradeReason, string> = {
  cwd_unavailable: "(cwd unavailable)",
  not_a_git_repo: "(not a git repo)",
  git_unavailable: "(git unavailable)",
};

// ---------------------------------------------------------------------------
// 投影:事件 → EnvSnapshot(replace-on-event 构造性保证)
// ---------------------------------------------------------------------------

/**
 * 事件 → EnvSnapshot 投影(env_snapshot 专用;其余事件 → null)。
 * 返回完整独立的冻结快照 —— replace-on-event 同形态:不读、不保留
 * 任何先前状态,app 单 state 槽 setEnvSnapshot(本投影) 即整体替换,不可能
 * 出现新旧混合。
 *
 * null 臂注:app 调用点(app.tsx onStream)已在 `event.type === "env_snapshot"`
 * 分支内调用,类型上不可能走 null;保留全量签名(不为调用点 narrow 成非空)
 * 是为了直接单测直驱与防御性收窄。
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
// 投影:EnvSnapshot → 显示行
// ---------------------------------------------------------------------------

export interface EnvSnapshotLine {
  readonly fg: string;
  readonly text: string;
}

/**
 * 纯函数投影:快照 → 显示行(不 touch OpenTUI,可单测直驱)。
 * null → 空数组(组件渲染 null,行数 0 入账)。
 *
 * 行数(显示侧封顶):
 *   - null → 0 行
 *   - EXIT 退化 → 1 行(DESIGN 占位)
 *   - 正常态(cwd + branch + dirty) → 1 行;diffPreview 在场再 +1
 *     (单行折叠展示,避免 chrome 行数爆)
 */
export function envSnapshotLines(
  snapshot: EnvSnapshot | null,
  cols: number
): ReadonlyArray<EnvSnapshotLine> {
  if (snapshot === null) return [];
  // EXIT: degradeReason 非 null → DESIGN 分型占位(harness 必填该字段)。
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
  // 正常态:header 行(⌂ cwd · branch · 未提交 n)
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
  // diff 行:折叠多行空白为单行空格 → 兜底截断(spec 上限 MAX_ENV_DIFF_CHARS,
  // 这里兜底再截,T4 已保证实际数据 ≤ 上限;UI 层 spec 锁 = 不可取消上限) →
  // clipOneLineVisual 按 cols 单行展示;CJK 安全(visualWidth 同款口径)。
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
// 绑定根解析:会话位置行换路径用的数据源(ADR-0037 T5 只读)
// ---------------------------------------------------------------------------

/**
 * 绑定根优先活 taskRoot（改绑当回合即可读），否则会话文件 workspaceRoot。
 * 仍是「是不是任务树」的判定缝（`isTaskWorktreePath`，复用 session-api
 * 的确定性命名）—— 但自 spec D7 / SC6 起，这个判定**不再决定位置行的
 * 显隐**，只决定同一行上的路径取绑定根还是项目根。数据源 = 会话
 * workspaceRoot 只读透传 + 活 cell；本函数零 git import、零 git 操作。
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
// 投影:会话位置行(session location chrome,spec D7 / SC6)
// ---------------------------------------------------------------------------

/** 项目根到根的显示路径:在项目根下 → `~/projects/iknow` 形态(项目根名 +
 *  相对段),否则原样根(调用方已把项目根本身当作显示基准)。 */
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
 * 会话位置行(spec D7 / docs/CONTEXT.md `session location chrome`) ——
 * 底栏**常驻一行**,形如 `~/projects/iknow · master`(路径 · 分支)。
 *
 *   - 常驻:主仓 / 非 task 路径照样画,显隐不由绑定决定(旧
 *     `worktreeIsolationLines` 的「仅 task 树才显示」合同作废)。
 *   - 绑任务树:同一槽**换路径**(活 taskRoot 优先,否则会话
 *     `workspaceRoot`;都缺时回落未绑形态),不另起一行、不从无到有。
 *   - 无 dirty / diff(chrome 只给「在哪」,不给仓库状态;状态另属
 *     env_snapshot 的 diff 面)。
 *   - 分支缺省:未绑或分支未知 → 只画路径段(不写占位符)。
 *   - 纯函数:调用方(EnvironmentPane / app.tsx)负责把 cols 与数据源喂进来。
 */
export function sessionLocationLines(opts: {
  /** 主项目根(启动 cwd / workspaceRoot)。 */
  readonly projectRoot: string;
  /** 会话已绑的任务树(活 taskRoot 优先,否则会话 workspaceRoot)。 */
  readonly worktreeRoot?: string | null;
  /** git 分支(env_snapshot 提供;未知传 undefined)。 */
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
// 渲染壳
// ---------------------------------------------------------------------------

export interface EnvironmentPaneProps {
  /** 最新一份环境现势快照(env_snapshot 事件投影);null = 尚未有事件。 */
  readonly snapshot: EnvSnapshot | null;
  readonly cols: number;
  /** D7:项目根(常驻位置行的路径基准;缺省 → 不画位置行)。 */
  readonly projectRoot?: string;
  /** D7:会话已绑任务树根;给定则同一槽换该路径。 */
  readonly worktreeRoot?: string | null;
}

/** 位置行 = 路径 + 分支(分支取快照;快照缺席 → 只画路径段)。 */
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
