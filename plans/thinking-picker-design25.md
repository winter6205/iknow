# thinking-picker design-25 落盘计划

> **Tracker**: local markdown (fallback) — 无 GitHub remote 操作授权；tracer-bullet 以本文件 + 独立分支呈现。
> **来源**: `docs/design/thinking-picker.md`（已定案，双面板版） + `src/tui/designs/design-25-flow-edge.tsx`（终稿视觉，用户确认"完美了，直接确定终稿"）。
> **视觉基线**: design-25 = design-5 圆角流光框 + 5 段等宽紫渐变进度条 + 当前档边界流动水线。用户要求"思考开关面板也可以参考这种风格，统一风格"。

## 目标

把 `/thinking` + `/effort` 从「立即生效 + notice」改为「弹出 thinking-picker 浮层面板（design-25 风格）」：**两个独立面板**，视觉风格一致，Enter 固定不退出、Esc 保存退出。

**语义红线（不许碰）**：

- `computeThinkingOverride`（thinking-gate.ts）语义不变——picker 只是 `setThinkingEnabled` / `setThinkingEffort` 的新入口。
- `/thinking` 纯开关面板：只影响 `thinkingEnabled`，不碰 `thinkingEffort`。Enter 固定当前 ON/OFF 预览、Esc 保存退出。
- `/effort` 纯档位面板：只影响 `thinkingEffort`（选档隐式 `enabled=true`）。←/→ 移档、Enter 固定、Esc 保存退出。
- **Esc = 保存退出（无 cancel 路径）**；Enter = 固定不关闭（面板保持打开，可继续调）。
- 面板触发后输入框已清空（既有行为）。

## Tracer bullets

#### T1. `[implementation]` thinking-picker 纯函数 reducer 模块

- **Affects**: `src/tui/thinking-picker.tsx`（新建）、`tests/tui/thinking-picker.test.tsx`（新建）
- **Acceptance**: `bun test tests/tui/thinking-picker.test.tsx` 全绿（≥12 用例，§7 表 #1-12）；`effortToIndex`/`indexToEffort` 往返幂等
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T2. `[implementation]` design-25 风格渲染组件 + 行账

- **Affects**: `src/tui/thinking-picker.tsx`（续）、`tests/tui/chrome-budget.test.ts`（增补）
- **Acceptance**: 渲染帧含 design-25 视觉元素（圆角流光框 / 紫渐变段 / 边界水线）；`thinkingPickerRows(cols)` 恒 5；`bun test tests/tui/chrome-budget.test.ts` 增补用例绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T3. `[implementation]` app.tsx 集成：picker 状态 + 键路由短路 + 渲染槽 + 行账

- **Affects**: `src/tui/app.tsx`、`tests/tui/app.test.tsx`（增补）、`tests/tui/thinking-picker.test.tsx`（增补集成用例 #13-20）
- **Acceptance**: `/thinking` `/effort` 打开面板；←/→/Tab/Space/Enter/Esc 正确路由；Esc 不写 state；Ctrl 组合不吞；`bun test tests/tui/app.test.tsx` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

## 依赖

T1 < T2 < T3（T2 依赖 T1 的 reducer/SSOT 映射；T3 依赖 T2 的渲染组件 + 行账）。

## 完成标准

`cat plans/thinking-picker-design25.md | grep -E "^\s*[0-9]+\."` → 3 个 bullet；`git log` 3 个 commit；`bun test tests/tui/` 全绿。
