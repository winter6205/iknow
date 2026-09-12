/**
 * src/tui/subagent-message-lines.ts
 *
 * spec Slice D / SC14（`specs/agent-control-surface.md`）/ plan task 8：
 * **会话消息内**每个活子代理两行 —— 第 1 行 `{role} running...`，
 * 第 2 行 dim 为最新内容（taskPreview）。
 *
 * Host：投影由 `SubagentIdentityStrip`（输入框正上方的会话消息区 chrome，
 * `src/tui/subagent-identity-strip.tsx`）渲染 —— 原单行身份条扩展为
 * 「每活子代理两行」。不做进 `TranscriptTail`：那条路要把 `subagents`
 * 穿过 ChatView → ChatScrollbox → TranscriptTail 三层 props 并进滚动区布局
 * （滚动高度账 / 消息挂载窗口都会被尾部新增行扰动）。本模块保持**纯函数**
 * （不 touch OpenTUI / React），可单测直驱。
 *
 * 与 `SubagentPanel` 的信息分工（spec 要求「不得与面板逐字重复」）：
 *   - 面板（输入框**下**）：`● {name} {preview} · {elapsed}` —— 状态字形 +
 *     截断 preview + 运行时长 + `> ` 聚焦前缀；
 *   - 本条（输入框**上**，会话消息区）：`{role} running...` + dim 最新内容
 *     —— 无字形、无时长、无聚焦前缀（聚焦词汇只属于面板）。
 *
 * 可见性：只看 starting / running（failed / completed 不清账 —— 终态窗口
 * 语义归面板）。live === 0 → 0 行。
 *
 * 边界：
 *   - empty：`[]` / 仅终态 → `[]`（host 不渲染任何东西）；
 *   - negative：缺 role → `SUBAGENT_ROLE_FALLBACK`（catalog fallback，永不
 *     输出「子代理」字面值）；taskPreview 为空 / 纯空白 → detail 行折叠为空串
 *     （host 渲染成空行占位，两行账不变）；
 *   - overflow：两行各自按 cols 视觉宽度截断（CJK-safe），永不换行；
 *   - concurrent：纯函数，每次投影取调用时刻入参，无历史残留；
 *   - exception：不读 startedAt / endedAt / summary / reason（非法 ISO 不
 *     影响本投影）。
 */
import type { SubagentInfo } from "../harness/subagent/manager.js";
import { clipOneLineVisual } from "./tool-summary.js";
import { SUBAGENT_ROLE_FALLBACK } from "../shared/tool-line.js";

/**
 * 缺 role 时的 catalog fallback。与 `resolveSubagentRoleFromInput`
 * （`src/shared/tool-line.ts:119`）的 `SUBAGENT_ROLE_FALLBACK` 同值同源 ——
 * 工具卡与身份条对同一子代理不得各印一个角色名。
 */
export const IDENTITY_FALLBACK_ROLE = SUBAGENT_ROLE_FALLBACK;

/** 第 1 行固定后缀（spec 原文 `running...`，三个点）。 */
const RUNNING_SUFFIX = " running...";

/**
 * live 子代理的**唯一判据**：`starting` + `running`（SC14 / SC15 行序合同）。
 *
 * 面板的 live 行序（`projectSubagentLines`）、会话消息两行投影、Ctrl+X 强杀
 * 分派（`subagent-kill.ts`）与 app 的 focus 计数 / 行账共用本谓词 —— 判据在
 * 三处各写一遍字面量时，任何一处漂移都会让「聚焦行 ↔ 杀谁」错位。终态
 * （completed / failed）不算 live：终态窗口语义归面板。
 *
 * 放在本模块（React / OpenTUI 无关的纯函数层）而不是面板 .tsx：kill 分派与
 * 投影都能 import 它而不把 OpenTUI 拖进各自的依赖图。
 */
export function isLiveSubagent(info: SubagentInfo): boolean {
  return info.state === "starting" || info.state === "running";
}

/**
 * 单活子代理的 role 投影（钉死 negative 决策；与 identity strip 同源规则）：
 *   - role 存在且非空（trim 后长度 > 0）→ role.trim()；
 *   - role 缺席 / 空串 / 纯空白 → `IDENTITY_FALLBACK_ROLE`；永不输出
 *     「子代理」字面值。
 */
export function resolveIdentityRole(info: SubagentInfo): string {
  const role = info.role;
  if (role === undefined) return IDENTITY_FALLBACK_ROLE;
  const trimmed = role.trim();
  return trimmed.length > 0 ? trimmed : IDENTITY_FALLBACK_ROLE;
}

export interface SubagentMessageLine {
  /** 第 1 行：`{role} running...`。 */
  readonly roleLine: string;
  /** 第 2 行：dim 最新内容（空串 = 无非空 taskPreview，host 渲染空行占位）。 */
  readonly detailLine: string;
}

/**
 * 会话消息内的两行投影。每个 live 子代理产出**恰好两行**（顺序 = 入参
 * 顺序 = manager.listSubagents 顺序）。
 */
export function projectSubagentMessageLines(
  subagents: ReadonlyArray<SubagentInfo>,
  cols: number
): ReadonlyArray<SubagentMessageLine> {
  const budget = Math.max(1, cols);
  const out: SubagentMessageLine[] = [];
  for (const s of subagents) {
    if (!isLiveSubagent(s)) continue;
    out.push({
      roleLine: clipOneLineVisual(
        `${resolveIdentityRole(s)}${RUNNING_SUFFIX}`,
        budget
      ),
      detailLine: clipOneLineVisual(s.taskPreview, budget),
    });
  }
  return out;
}

/** 会话消息内两行投影的行账：每个 live 子代理 2 行，无 live → 0 行。 */
export function subagentMessageRowCount(
  subagents: ReadonlyArray<SubagentInfo>
): number {
  let live = 0;
  for (const s of subagents) {
    if (isLiveSubagent(s)) live += 1;
  }
  return live * 2;
}
