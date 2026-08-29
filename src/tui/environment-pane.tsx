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
 *   - ADR-0037 T5 追加投影:worktreeIsolationLines —— 会话 worktree 隔离
 *     现势行(数据源是会话文件的 workspaceRoot 只读透传,非 env_snapshot;
 *     见该函数注释)。app.tsx 挂在 chat chrome 的 envPaneRows 槽位。
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
// 投影:会话 worktree 隔离现势(ADR-0037 T5 只读投影)
// ---------------------------------------------------------------------------

/**
 * ADR-0037 / plans/worktree-isolation-on-mutate.md T5 — 会话 worktree 隔离
 * 现势行。与 T3 门禁的一次性 `[worktree_isolation]` 拦截消息互补:那条消息
 * 只在改绑当场出现一次,本投影是**持久现势** —— 只要会话根仍绑在 task
 * worktree 上,chrome 就显示绑定根,操作员无需猜路径。
 *
 *   - 数据唯一来源:TuiSessionState.workspaceRoot(session-state.ts 从会话
 *     文件的 workspaceRoot 字段只读透传;T3 改绑落盘的唯一写方是 session-api
 *     worktree-rebind)。本投影纯函数、零 git import、零 git 操作 —— TUI 只
 *     做展示(ACR bounded-context-guardian 边界)。
 *   - 未绑定(undefined / null / 空串;开关 OFF / 尚未 mutate / 改绑失败)→
 *     0 行,与今日一致,不出现多余状态,也绝不显示「已绑定」。
 *   - 复用环境现势的字形纪律(⌂)与 dim 调色,单行按 cols 视觉宽度截断。
 */
export function worktreeIsolationLines(
  root: string | null | undefined,
  cols: number
): ReadonlyArray<EnvSnapshotLine> {
  if (root === null || root === undefined || root.trim().length === 0) {
    return [];
  }
  const text = clipOneLineVisual(
    `${HEADER_PREFIX}worktree: ${root}`,
    Math.max(0, cols)
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
}

export function EnvironmentPane(props: EnvironmentPaneProps): ReactNode {
  const lines = envSnapshotLines(props.snapshot, props.cols);
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
