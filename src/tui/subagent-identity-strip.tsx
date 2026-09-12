/** @jsxImportSource @opentui/react */
/**
 * src/tui/subagent-identity-strip.tsx
 *
 * plans/tui-chrome-interaction.md T7 + spec Slice D / SC14
 * （`specs/agent-control-surface.md`）—— 子代理身份条（immediately above the
 * prompt，会话消息区内）。每个 live 子代理（starting / running）**两行**：
 * 第 1 行 `{role} running...`（catalog id，如 `general-purpose running...`），
 * 第 2 行 dim 为最新内容（`taskPreview`）。多 live 子代理按块顺序下排。
 * Completed / failed 子代理不出现在该条（终态窗口语义归 SubagentPanel）。
 *
 * 投影纯函数在 `src/tui/subagent-message-lines.ts`（本文件只挂 JSX ——
 * 渲染与投影分层，与 SubagentPanel 同纪律）。role 解析沿用 T7 的
 * `resolveIdentityRole` 单源（缺 role → catalog fallback
 * `general-purpose`，永不输出「子代理」字面值）。
 * 行数**入 chrome 行账**：app 用 `subagentMessageRowCount`（每 live 子代理
 * 2 行）喂 `chromeReserveRows.subagentRows` —— 入账 SSOT 在投影模块，
 * 本文件不再另挂一个 passthrough 行账口。
 *
 * 边界决策（SC14 叠加 T7）：
 *
 *   - empty：无 live 子代理 → 渲染 null（0 行）；
 *   - negative：缺 role → catalog fallback（见 subagent-message-lines.ts）；
 *     缺 / 空 taskPreview → 第 2 行渲染单空格占位，块恒为 2 行（不塌陷）；
 *   - overflow：两行各自按 cols 视觉宽度截断（CJK-safe），永不换行；
 *   - concurrent：active 会话切换时按当前入参重投影，无历史残留；
 *   - exception：缺 taskPreview / 非法 ISO 不影响本投影（不读时间字段）。
 *
 * 字形纪律：spec #146:86 无 emoji UI 字形。本条只用 ASCII（`·` U+00B7 已
 * 随单行形态退役，`…` U+2026 保留）。无几何字形 —— 与 SubagentPanel
 * `● ○ ✗ ✓` 对齐但本条不需要状态指示（live = 始终 `running`）。
 */
import type { ReactNode } from "react";
import type { SubagentInfo } from "../harness/subagent/manager.js";
import { visualWidth } from "./tool-summary.js";
import { projectSubagentMessageLines } from "./subagent-message-lines.js";
import { tuiPalette } from "./theme.js";

export interface SubagentIdentityStripProps {
  readonly subagents: ReadonlyArray<SubagentInfo>;
  readonly cols: number;
}

export function SubagentIdentityStrip(
  props: SubagentIdentityStripProps
): ReactNode {
  const lines = projectSubagentMessageLines(props.subagents, props.cols);
  if (lines.length === 0) return null;
  return (
    <box flexDirection="column">
      {lines.map((line, i) => (
        <box key={i} flexDirection="column">
          <text wrapMode="none">{line.roleLine}</text>
          <text fg={tuiPalette.dim} wrapMode="none">
            {line.detailLine === "" ? " " : line.detailLine}
          </text>
        </box>
      ))}
    </box>
  );
}

/** Identity strip 视觉宽度便捷测（单测使用，避免 visualWidth 重复 import
 *  路径混乱）。 */
export function identityStripVisualWidth(text: string): number {
  return visualWidth(text);
}
