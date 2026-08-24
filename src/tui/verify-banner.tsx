/** @jsxImportSource @opentui/react */
/**
 * src/tui/verify-banner.tsx
 *
 * T3 (#458 包2): TUI verify 闭环终态人读 banner ——
 *   - HITL + auto 双模式都显示 passed / failed / unstable / escalated 4 终态;
 *   - 缺 verify → 静默(0 行,渲染壳 render null,无虚假提示);
 *   - wire 形状非法(runtime boundary)→ degraded「验证结果不可用」+ 渲染
 *     typed-error 详情(契约见 code-quality.md:`${kind}: ${conversation_id}`,
 *     禁用 `err instanceof Error ? err.message : String(err)` 回退);
 *   - 与 agent-status-line 同款两层结构:纯函数投影 + 渲染壳,纯函数可
 *     bun:test 单测直驱,不依赖 OpenTUI / React 渲染。
 *
 * 字形纪律:passed ✓ / failed ✗(subagent-panel 既用惯例 ✓ ✗ ▤);unstable ⚠ /
 * escalated ⤴(task 指定)。HITL 直显,auto 加 `[auto] ` 前缀(视觉标记)。
 *
 * 数据源唯一性:T3 不另建账本。banner 状态按会话 key 维护在 app.tsx
 * (`verifySlots`),数据来自 bridge.postMessage 返回的 `verify` DTO
 * (T2 已把 passed 加进 wire 联合);resume hydrate 时 transcript 无
 * VerifyAnswerView → 静默(empty slot),不试图从 <agent_status> / verify
 * 信封恢复,避免复刻第二份账本(与 agent-status 一致)。
 */
import type { ReactNode } from "react";
import type { VerifyAnswerView } from "../session-api/contract.js";
import { clipOneLineVisual } from "./tool-summary.js";
import { tuiPalette } from "./theme.js";

/** TUI 视角的 verify 模式:HITL = 默认交互式;auto = full_auto 模式
 *  (banner 额外加 `[auto] ` 视觉标记,见 src/tui/run.tsx --auto-mode flag)。 */
export type VerifyBannerMode = "hitl" | "auto";

/** 投影失败原因(code-quality.md typed-error 渲染契约):把判别联合的
 *  `kind` 提到主键,exhaustiveness 不强制(reason 后续可继续演化)。
 *  Render 侧按 `${kind}: ${conversation_id ?? — 缺则跳过 —}` 输出。 */
export interface VerifyProjectionError {
  readonly kind: string;
  readonly conversation_id?: string;
}

/** app.tsx 状态槽的判别联合(数据 slot 与渲染投影在投影函数里收口)。
 *  none = 缺 verify(合法态,静默不渲染);ok = 正常 4 终态;
 *  unavailable = 投影失败(degraded 「验证结果不可用」)。 */
export type VerifySlot =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly verify: VerifyAnswerView }
  | {
      readonly kind: "unavailable";
      readonly reason: VerifyProjectionError;
    };

export interface VerifyBannerLine {
  readonly fg: string;
  readonly text: string;
}

// ===== outcome → glyph + label + fg (4 状态映射) =============================
//
// 色彩口径:passed 绿(palette.add,与 add diff 行同源);failed / escalated
// 红(palette.error,与 del/error 同源);unstable 琥珀(palette.running,
// 介于 [运行] 与 [错误] 之间的提示态)。
//
// 文案短形式 — 对应 cli/format.ts formatVerifyReport 的 label,但不带
// 「[验证] ... —— 未判完成」警示后缀(banner 是终点状态反馈,不是报告)。
const VERIFY_OUTCOME_PRESENTATION = {
  passed: { glyph: "✓", label: "验证通过", fg: tuiPalette.add },
  failed: { glyph: "✗", label: "验证未通过", fg: tuiPalette.error },
  unstable: {
    glyph: "⚠",
    label: "验证不稳定",
    fg: tuiPalette.running,
  },
  escalated: {
    glyph: "⤴",
    label: "验证耗尽（升级后仍未通过）",
    fg: tuiPalette.error,
  },
} as const;

/** wire 形状校验(runtime boundary):postMessage 透传的 verify 字段跨进程/
 *  future wire 漂移时需 runtime 校验。返回值 = VerifySlot。
 *  显式判定 outcome ∈ 4 状态 + rounds 是有限非负整数;其它一律 unavailable
 *  而非抛错 —— 上层既可走 degraded 渲染,也不污染 React 渲染栈。 */
export function verifyFromWire(raw: unknown): VerifySlot {
  if (raw === undefined || raw === null) {
    return { kind: "none" };
  }
  if (typeof raw !== "object") {
    return {
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    };
  }
  const obj = raw as Record<string, unknown>;
  const outcome = obj.outcome;
  if (
    outcome !== "passed" &&
    outcome !== "failed" &&
    outcome !== "unstable" &&
    outcome !== "escalated"
  ) {
    return {
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    };
  }
  const rounds = obj.rounds;
  if (typeof rounds !== "number" || !Number.isFinite(rounds) || rounds < 0) {
    return {
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    };
  }
  return {
    kind: "ok",
    verify: { outcome, rounds },
  };
}

/** typed-error 渲染契约(code-quality.md):识别 kind 字段,渲染
 *  `${kind}: ${conversation_id}` 或仅有 `${kind}`;非合法 typed-error shape
 *  → null(上层不允许 `instanceof Error ? err.message : String(err)`
 *  回退 —— 必走「验证结果不可用」无详情的安全降级)。 */
export function describeVerifyErrorDetail(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const obj = err as Record<string, unknown>;
  if (typeof obj.kind !== "string") return null;
  const convId = obj.conversation_id;
  return typeof convId === "string" ? `${obj.kind}: ${convId}` : obj.kind;
}

/** 渲染投影:slot + 模式 → 显示行数组。none → [];ok → 1 行(终态文案);
 *  unavailable → 1 行(degraded)。auto 模式统一加 `[auto] ` 前缀(4 终态
 *  与 degraded 同款,视觉标记一眼可辨)。cols 截断走 clipOneLineVisual
 *  (CJK 2 列,与 agent-status-line / subagent-panel 同款)。 */
export function projectVerifyBanner(
  slot: VerifySlot,
  mode: VerifyBannerMode,
  cols: number
): ReadonlyArray<VerifyBannerLine> {
  if (slot.kind === "none") return [];
  const autoPrefix = mode === "auto" ? "[auto] " : "";
  if (slot.kind === "ok") {
    const view = slot.verify;
    const pres = VERIFY_OUTCOME_PRESENTATION[view.outcome];
    const text = `${autoPrefix}${pres.glyph} ${pres.label}（${view.rounds} 轮）`;
    return [{ fg: pres.fg, text: clipOneLineVisual(text, cols) }];
  }
  // unavailable — auto 模式同样加 [auto] 前缀(标记与 4 终态一致)。
  const detail = describeVerifyErrorDetail(slot.reason);
  const suffix = detail === null ? "" : `（${detail}）`;
  const base = "⚠ 验证结果不可用";
  return [
    {
      fg: tuiPalette.error,
      text: clipOneLineVisual(`${autoPrefix}${base}${suffix}`, cols),
    },
  ];
}

// ===== 渲染壳(单行 status row:与 components.tsx StatusLine 同纪律) =====

export interface VerifyBannerStripProps {
  /** 来自 app.tsx verifySlots 的当前 slot;无 verify → none → 静默。 */
  readonly slot: VerifySlot;
  readonly mode: VerifyBannerMode;
  readonly cols: number;
}

/** 单行 banner 渲染壳。无 slot 行(slot.kind === "none") → 组件 return null
 *  (不渲染任何额外行,与 ChatView 自身的渲染约束统一)。
 *  注意:banner 自身没有 marginBottom / 边框 → chromeReserveRows 行账对应
 *  裸行(详见 chrome-budget.test.ts 的 verifyRows 联动用例)。 */
export function VerifyBannerStrip(props: VerifyBannerStripProps): ReactNode {
  const lines = projectVerifyBanner(props.slot, props.mode, props.cols);
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
