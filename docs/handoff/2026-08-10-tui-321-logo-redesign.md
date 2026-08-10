# Session Handoff — TUI banner logo 重设计（2026-08-10）

## 当前 live 状态

- **任务**: #343 TUI 回归修复（5 项诉求）已全部完成并 commit（`2107554` / `7e5b281` / `efd68ff` / `21ee699` / `8c96503`）。操作员验收下一阶段诉求：**logo 部分想再调整**——具体两项：(a) logo 部分的"框没有了"（**外圆角框 + 顶框内嵌居中 title `◆ iknow` 未实现**）；(b) **logo 颜色想重新画**（配色 / 眼字形细节调整）。
- **为什么重要**: 操作员明确「下个会话想要再调整一些东西……具体下个会话再探讨」——本次仅做交接，不动实现。下个 agent 第一动作是**和操作员对话确认具体调整方向**（配色？是墨绿换色 / 金棕换色 / 双眼色比例 / 还是全换？眼字形是要换源图、改尺寸、还是局部调整？框是要恢复 V7 单线外框还是 #146 spec 的 `borderStyle="round"`？），再开工。
- **operator 显式指令**: 「简答交代一下进度，我下个会话想要再调整一些东西，比如说 logo 部分的框没有了，还有 logo 的颜色，我想重新画一下，具体下个会话再探讨，写完你退出工作数树」

## 已固化工件（引用，不复制 inline）

| 类型                         | 路径 / URL                                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Banner 设计稿（设计期定案）  | `docs/design/DESIGN-BANNER.md`                                                                                                                                                                                             |
| Banner 实现                  | `src/tui/banner.ts` + `src/tui/banner-art.ts`（眼字形 32×13 braille 常量）                                                                                                                                                 |
| 配套视觉工具                 | `src/tui/visual.ts`（`padEndVisual` 共享）                                                                                                                                                                                 |
| 渲染入口（banner 接线点）    | `src/tui/chat-view.tsx:128-142`（scrollbox 内 bannerLines）、`src/tui/app.tsx:991-1038`（`<Banner>` 外部渲染，**#343 fix-session 之前双源；fix-session 已删 scrollbox 外层 `<Banner>` 渲染**，仅 ChatView 内 bannerLines） |
| 配色主题                     | `src/tui/theme.ts`（`logoInk` 墨绿、`logoGold` 金棕，与归档 truecolor 同源）                                                                                                                                               |
| 点阵生成脚本（设计期一次性） | `scripts/gen-banner-art.py`（按 §4 公式裁主体 + FACTOR=2.2 补偿）                                                                                                                                                          |
| 迁移 spec                    | `specs/321-tui-opentui-migration.md`（§3 §4 布局与降级 §4.5 字体调优）                                                                                                                                                     |
| 设计 issue                   | GitHub #154 OPEN = `[wayfinder:prototype] TUI 设计稿 · 视觉验证`                                                                                                                                                           |
| 上一份交接                   | `docs/handoff/2026-08-10-tui-321-regression-fixes.md`                                                                                                                                                                      |

## 本 session 变更

> **本 session 无业务代码变更**——按操作员指令只做交接 + 退出 worktree。仅新增本交接文件。

| 变更（文件路径）                                   | 一行效果   |
| -------------------------------------------------- | ---------- |
| `docs/handoff/2026-08-10-tui-321-logo-redesign.md` | 本交接文件 |

## 已验证状态

> 本 session 不涉及代码改动；以下为上一 session 残留基线，供下个 agent 起步对照：

```
npx tsc --noEmit                              => 0 错误
~/.bun/bin/bun test tests/tui/                => 284 pass / 1 fail（run-errors.test.ts 既有基线，非本次）
npx vitest run                                => 1948 pass / 0 fail
npm run dev:tui（$HOME/.bun/bin/bun）           => TUI 真实渲染 exit=0
git status                                     => clean
git log（worktree-tui-321-guarded）             => ahead of origin 6 commits（未 push，无操作员授权）
```

## logo 重设计要点（下个 session 对照）

### 操作员原话要点

1. **「logo 部分的框没有了」** —— 对应 DESIGN-BANNER.md §1 定案的「占满整行宽度的**圆角线框**」+ 顶框内嵌居中 title `◆ iknow` 未实现。当前实现只把 bannerLines 当裸 `<text>` 渲染（`chat-view.tsx:139`），无 box 包裹 / 无顶框 / 无居中 title。
   - 设计稿原意：box `borderStyle="round"`（与输入框 PromptInput 同款），外框占满 cols，左右各 1 列 padding，title 居中嵌在顶框线中间。
   - 之前 handoff `2026-08-10-tui-321-regression-fixes.md`「P0-1」已标 "DESIGN-BANNER §1 圆角外框未实现" 待 #154；本次操作员正式提为诉求。

2. **「logo 的颜色想重新画」** —— 未指明具体方向。需要下个 agent 与操作员对话确认：是要换墨绿（`#183223`）为别的色 / 换金棕（`#b97f1c`）为别的色 / 调双眼色比例 / 还是整套重新配色？是否要换源图（现 `docs/design/eyeshape.png`）？

### 可能的实现路径（供下个 agent 参考，最终以操作员决策为准）

- **框恢复**：在 `chat-view.tsx:128-142` 把 `<text>` 列表外包一个 `<box borderStyle="round" title="◆ iknow">`，13 行 text 仍保留 renderBannerLines 输出。注意 stickyStart="bottom" 在 box 内是否仍正确（实测验证）。
- **配色调整**：
  - 单色改：`src/tui/theme.ts` 改 `logoInk` / `logoGold` 常量即可（值与归档 truecolor 档一致：`#183223` / `#b97f1c`，COLORTERM=truecolor → `38;2;24;50;35` / `38;2;185;127;28`；ANSI256 退化 → 22 / 136）。
  - 眼字形重画：跑 `scripts/gen-banner-art.py`（按 §4 公式裁主体 + FACTOR=2.2 补偿），输出覆写 `src/tui/banner-art.ts`（**勿手改字形**）。若换源图（操作员可能给新 PNG），更新脚本的 `SRC` 常量后重生成。
  - 双眼色比例调整：脚本输出 `EYE_LINES`（主层）+ `EYE_GOLD_LINES`（金层），目前金层只有瞳孔 R 符文（6% 占比）；要扩大 / 缩小金层，调整 RGB mask `r>140 ∧ b<80 ∧ (r-b)>80` 的阈值或扩到眼环 / 8 符文方框等区域。
- **窄终端降级保留**：`BANNER_MIN_COLS = 80`（32 眼 + 3 GAP + 43 info + 2 框），cols < 80 → 单行 `◆ iknow <version>`，不要破降级。

## Open blockers + next steps

**[NEXT] 与操作员对话确认 logo 重设计的具体方向（外框样式 = V7 单线 box 还是 DESIGN-BANNER §1 的 `borderStyle="round"` 圆角框？配色 = 换墨绿 / 换金棕 / 调比例 / 全换？眼字形 = 换源图 / 局部调 / 保留？），然后在 `src/tui/theme.ts`（配色）或 `chat-view.tsx:128-142`（框）或 `scripts/gen-banner-art.py`（眼字形）三处定位改点，写失败测试（tests/tui/{theme,banner-lines,render-smoke}.test.{ts,tsx}）后实现，bun test 全绿再真 TTY 冒烟，最后 commit。**

- 改前先读 DESIGN-BANNER.md（设计期 5 次迭代存档，**保留防回退**）+ 上份 handoff「P0-1/P0-2」节，确认改动方向不踩设计稿否决项。
- 若配色调整影响归档 ink 版（`archive/tui-ink/src/banner.ts` ANSI paint 路径），归档版不动——归档期已封口，仅 #321 实施版生效。
- 全部修完：决定是否 push / 是否合 PR（操作员未授权 push，当前 `ahead of origin 6 commits`）。

## Suggested skills（下个 agent 建议 invoke）

- `arthurpower:frontend-ui-engineering` — logo / 框 / 配色都是视觉决策，该 skill 专门防「AI-aesthetic 前端失败模式」
- `arthurpower:test-driven-development` — 改前先写失败测试（bun:test，tests/tui/banner-lines.test.ts + render-smoke.test.tsx）
- `arthurpower:verification-before-completion` — 声称修完前必须真终端 `npm run dev:tui` 实测视觉（不只是断言）

## 脱敏

- 无 API key / token / password / credential 值出现
- 凭据一律用环境变量名（`GITHUB_TOKEN`、`MINIMAX_API_KEY`），不写值
