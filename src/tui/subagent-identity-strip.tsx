/** @jsxImportSource @opentui/react */
/**
 * src/tui/subagent-identity-strip.tsx
 *
 * plans/tui-chrome-interaction.md T7 —— 子代理身份条（immediately above the
 * prompt）。每条 live 子代理（starting / running）一行 `{role} running...`
 * （catalog id，如 `general-purpose running...`；多个用 `·` 连接；dim 色，无
 * task 文本）。Completed 子代理不出现在该条（仅 failed 短窗口 —— 现有
 * SubagentPanel failed 分支继续处理，本条只看 starting/running）。
 *
 * 边界决策（与 SubagentPanel 同源，但视觉不同 —— identity strip 不显示
 * taskPreview / elapsed；它只告诉操作员「现在有谁正在跑」）：
 *
 *   - empty：无 live 子代理 → 0 行（不渲染任何东西）；
 *   - negative：缺 `role`（info.role 缺席或空串）→ catalog fallback
 *     `general-purpose`，永远不在 identity strip 上印 `子代理`（钉死）。
 *     T7 验收规则要求「implementer picks one」—— 本实现选 catalog fallback，
 *     行为可测、可断言（tests/tui/subagent-identity-strip.test.tsx）；
 *   - overflow：多 live 子代理 → 同一行用 `· ` 连接，按 cols 视觉宽度截断，
 *     永远单行（不换行）。行账 = 1（live 子代理 ≥1 时）或 0；
 *   - concurrent：active 会话切换时，identity strip 由 active 会话的
 *     subagents 数组投影（与 SubagentPanel 同款 keyed 模型）；不存在跨会话
 *     串态 —— props 改变即重投影，无历史残留；
 *   - exception：缺 taskPreview / 非法 ISO 不影响本投影（identity strip
 *     不读 taskPreview / startedAt / endedAt，仅读 role + state）。
 *
 * 字形纪律：spec #146:86 无 emoji UI 字形。本条只用 ASCII（`·` U+00B7，
 * `…` U+2026）保持窄列 / ASCII-only 终端兼容。无几何字形 —— 与 SubagentPanel
 * `● ○ ✗ ✓` 几何字形对齐但 identity strip 不需要状态指示（live = 始终
 * `running`，completed / failed 不进本条）。
 */
import type { ReactNode } from "react";
import type { SubagentInfo } from "../harness/subagent/manager.js";
import { clipOneLineVisual, visualWidth } from "./tool-summary.js";
import { tuiPalette } from "./theme.js";

/** 缺 role 时的 catalog fallback（钉死，见 T7 验收 negative 分支）。 */
export const IDENTITY_FALLBACK_ROLE = "general-purpose";

/** 行尾固定串（`...` 三个点）。英文（spec 锚钉英语 chip，slide 全产品英语
 *  化的渐进路径）；不读 cols 收缩。 */
const RUNNING_SUFFIX = " running...";

/** `· ` 分隔符（live 子代理之间）。U+00B7。 */
const SEP = " · ";

/**
 * 单活子代理的 role 投影（钉死 negative 决策）：
 *   - role 存在且非空（trim 后长度 > 0）→ role.trim()；
 *   - role 缺席 / 空串 / 纯空白 → `IDENTITY_FALLBACK_ROLE`（catalog fallback
 *     `general-purpose`）；永不输出 `子代理` 字面值（plan T7 acceptance
 *     「不要打印 子代理」 钉死）。
 */
export function resolveIdentityRole(info: SubagentInfo): string {
  const role = info.role;
  if (role === undefined) return IDENTITY_FALLBACK_ROLE;
  const trimmed = role.trim();
  return trimmed.length > 0 ? trimmed : IDENTITY_FALLBACK_ROLE;
}

/**
 * Identity strip 单行文本（多 live 用 `·` 连接），按 cols 视觉宽度截断。
 * 永不返回 null —— caller 自己用 `lines.length === 0` 判定空（empty 边界）。
 *
 *   - 0 live 子代理 → ""（不渲染 strip）；
 *   - 1 个 live → `"{role} running..."`（按 cols 截断）；
 *   - N 个 live → `"{role1} running... · {role2} running... · ..."`（按 cols 截断）；
 *
 * 行账：live ≥ 1 → 1 行；live === 0 → 0 行。永远单行 —— 不换行（受 cols 截断）。
 */
export function projectIdentityStripLine(
  subagents: ReadonlyArray<SubagentInfo>,
  cols: number
): string {
  const live = subagents.filter(
    (s) => s.state === "starting" || s.state === "running"
  );
  if (live.length === 0) return "";
  const parts: string[] = [];
  for (const s of live) {
    parts.push(`${resolveIdentityRole(s)}${RUNNING_SUFFIX}`);
  }
  // 折叠空白防御：内部用 U+00B7 分隔符（无空白），但极端窄列下仍按视觉
  // 宽度截断（CJK-safe via clipOneLineVisual）。
  const joined = parts.join(SEP);
  return clipOneLineVisual(joined, Math.max(1, cols));
}

export interface SubagentIdentityStripProps {
  readonly subagents: ReadonlyArray<SubagentInfo>;
  readonly cols: number;
}

export function SubagentIdentityStrip(
  props: SubagentIdentityStripProps
): ReactNode {
  const text = projectIdentityStripLine(props.subagents, props.cols);
  if (text.length === 0) return null;
  return (
    <text fg={tuiPalette.dim} wrapMode="none">
      {text}
    </text>
  );
}

/** Identity strip 行账：live ≥ 1 → 1 行；live === 0 → 0 行（产品路径供调用
 *  方选择性入账 —— 当前 plan T7 未把 identity strip 入 chrome 行账
 *  （绘制在输入框上方，且无换行），保留入账口以防未来变宽。）。 */
export function subagentIdentityStripRows(
  subagents: ReadonlyArray<SubagentInfo>
): number {
  return subagents.some((s) => s.state === "starting" || s.state === "running")
    ? 1
    : 0;
}

/** Identity strip 视觉宽度便捷测（单测使用，避免 visualWidth 重复 import
 *  路径混乱）。 */
export function identityStripVisualWidth(text: string): number {
  return visualWidth(text);
}
