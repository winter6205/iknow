# 0002. web UI flip: Variant A「软光 · 圆滑」design language + Tailwind v4 styling

Date: 2026-07-31
Status: accepted

## Context

022 迁移（PR #90）完成 web 前端功能适配后，UI 仍是 020 时期「forest cockpit」暗色功能原型风格（CSS Modules + 手写 CSS 变量，7 个 `.module.css` 共 737 行）。issue #92 评审（wayfinder grilling，comment `5135170423`）决定把 web UI 从「视觉打磨」升级为「归档旧版 + 用 Tailwind 重写」，设计参照 PR #21 胜出的 Variant A 原型（分支 `worktree-web-prototype-variants` @ `5796a73`）。

`docs/design/frontend-stack-upgrade-v1.md` §3/§8 原冻结「no Tailwind」，§6/§9 原定义 dark forest cockpit——两处均需显式翻转（已在该文档 §0 Decision Flip 就地记录）。

## Decision

1. **设计语言**：退役 forest cockpit 暗色，采用 Variant A「软光 · 圆滑」——暖米白 `#f6f3ec` + 松绿 `#3e6b52` + 20px 软圆角 + 分层柔和阴影 + Outfit Variable / IBM Plex Sans / IBM Plex Mono。
2. **样式方案**：引入 **Tailwind v4**（`@tailwindcss/vite` 插件 + CSS-first `@theme`），推翻 v1 §3/§8 冻结。设计值进 `web/src/styles/tokens.css` 的 `@theme` 块（零配置文件，无 PostCSS 链）。
3. **交付边界**：组件 + 样式重写；数据管道（`useSessionChat` / `api/client.ts` / `api/types.ts`）与后端 wire 不动。
4. **G2 证据投影范围裁决**（#92 #1 vs #13-16 矛盾）：#13-16 要求渲染 `source_spans / governance_status / snapshot_id / hops_used / notes`，前提是 G2 在 wire；但 spec 022（SC6/SC8，PR #90 已合并）已退役 G2 envelope，`TurnAnswerDto = { finalText, stopReason, turnCount }`（`src/session-api/contract.ts:18-22`）。**裁决**：组件结构完整实现证据投影（忠实 #13-16，复用 Variant A），经**可选 props** 接入；数据管道与后端 wire **不改**。证据 UI 当前不触发（props undefined）——能力预留，G2 重新上 wire 由**单独 ticket** 处理（须翻转 spec 022 Q1）。先例：#19 `renderBody` 预留不实现。

**Why not alternatives:**

- _保持 CSS Modules + 手写变量_：零新依赖，但 Variant A 的 color/radius/shadow/spacing token 用 Tailwind `@theme` 表达更紧凑，工具类消除 7 个 `.module.css` 重复；回退成本已被 #92 评审接受。
- _Tailwind v3（postcss + autoprefixer）_：需 postcss.config + tailwind.config + content glob；v4 零配置、自动 content 扫描、与 Vite 6 / React 19 同期，故选 v4。
- _shadcn/ui 组件库_：template-risk（#92 与 v1 一致排除），只取 Tailwind 样式层。
- _Next.js（prototype-cli-integration 方案 A）_：不采，UI 栈仍 Vite（方案 B 路线）。

**A8 精神评估（新 dev 依赖）**：Tailwind 是 dev dependency（`tailwindcss` + `@tailwindcss/vite`），非 runtime，不进产品 bundle 运行时。A8 措辞限定 #51（022），但其精神「tech stack 变更需新假设门」是项目级 Iron Law——本 ADR 即该评估门。build 链影响 = 单 Vite 插件注入；不违反 A10（非测试框架）。

## Consequences

- (+) 消除 7 个 `.module.css`，设计 token 单点（`@theme`），视觉统一。
- (+) Variant A 设计值与 Tailwind 工具类天然映射。
- (−) 新增 2 个 dev 依赖 + 根 lockfile 变更。
- (−) 证据投影组件当前无 wire 数据驱动（预留态），需未来 ticket 闭合。
- 回退 = 再重写一遍样式层（难逆转，故立此 ADR）。

**Evidence pointers**: issue #92 comment `5135170423`（20 条决策）· PR #21 @ `5796a73`（Variant A 一手资料）· `src/session-api/contract.ts:18-22`（wire 真相）· `docs/design/frontend-stack-upgrade-v1.md` §0 + §3/§6/§8/§9（就地翻转）· `plans/092-web-tailwind-rewrite.md`。
