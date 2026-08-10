# Session Handoff — #343 TUI 重写回归 / 需求偏差修复（2026-08-10）

## 当前 live 状态

- **任务**: #343 TUI ink→@opentui/react 迁移已交付（12 bullets 完成、commit `9d64f6b` 已提交），但操作员真机验收发现多处视觉/交互问题，需下个会话逐一修复。
- **为什么重要**: TUI 是产品交互主入口（`iknow tui`），spec #146（交互契约）与 #321（迁移 spec）是 SSOT；当前实现与契约存在已证实的偏差，操作员已明确这些是"把我原先设计改了"的地方，必须按 spec 语义纠正。
- **operator 显式指令**: 「交接一下本次重写任务，下个会话需要修 bug，有一些地方把我原先设计改了。比如说，spec 里面本来就是说 logo 要跟着消息一起滚动的，还有输入框什么一些地方都错位了，同时 Ctrl+O 展示思考之后又折叠不回去了，再按一次回不去，等等，问题诸多。」

## 已固化工件（引用，不复制 inline）

| 类型                        | 路径 / URL                                                                   |
| --------------------------- | ---------------------------------------------------------------------------- |
| 迁移 spec（SSOT）           | `specs/321-tui-opentui-migration.md`                                         |
| 交互契约                    | `specs/146-tui.md`                                                           |
| 旧 ink 实现（对比原设计用） | `archive/tui-ink/src/`（T0 归档，git 可查）                                  |
| 上一份完成态交接            | `docs/handoff/2026-08-10-343-tui-opentui-migration.md`                       |
| 运行时约束                  | `docs/handoff/2026-08-10-343-tui-opentui-migration.md`「工作环境关键事实」节 |
| 代码行号基线                | 本文件「已定性问题」节，均为本 session 实测证据                              |

## 本 session 变更

| 变更（文件路径）                                                                       | 一行效果                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tui/run.tsx`（commit `9d64f6b`）                                                  | RENDERER_CONFIG 去 Object.freeze：OpenTUI CliRenderer 在 Linux 写 config.useThread 默认值，冻结对象抛 not extensible                                                                                                                                                 |
| `src/cli.ts`（commit `9d64f6b`）                                                       | runTui 加运行时守卫：非 Bun 环境提前拦截，指引 `npm run dev:tui`                                                                                                                                                                                                     |
| `package.json`（commit `9d64f6b`）                                                     | 新增 `dev:tui` 脚本（`$HOME/.bun/bin/bun run src/cli.ts tui`）                                                                                                                                                                                                       |
| `docs/handoff/2026-08-10-tui-321-regression-fixes.md`                                  | 本交接文件                                                                                                                                                                                                                                                           |
| `src/tui/banner.ts`（fix-session）                                                     | renderBannerLines 改图案居左 + info 居右并排（DESIGN-BANNER.md「图案居左 + info 居右垂直居中」回归）：13 行每行 = 眼睛 + GAP(3) + info 栏（info 三行垂直居中于眼睛中部第 5/6/7 行），删除末行分隔线输出                                                              |
| `src/tui/prompt-input.tsx`（fix-session）                                              | 输入框原生化为 OpenTUI `<input>` 组件（onInput 全量字符串 + onKeyDown 路由功能键），修复「首字被吃」竞态                                                                                                                                                             |
| `src/tui/app.tsx`（fix-session）                                                       | copy-flow 改 **B1 方案**：右键 down+up 复制（down preventDefault 保留选区、up 复制 + clearSelection）；**删除 Ctrl+Y 重复制键位 + `useSelectionHandler` 自动复制**；**ContextBar 改左对齐 supersede 2026-08-08 右对齐决策 commit `33c2f17`（操作员「最新的为准」）** |
| `tests/tui/{banner-lines,context-bar,copy-flow,keyboard}.test.{ts,tsx}`（fix-session） | 测试同步：banner 13 行 info 居右断言、ContextBar 组件首行 `│` 左对齐断言、copy-flow 切右键复制（拖选不再自动复制）+ 删 Ctrl+Y 用例、输入框快速连发两字 + bracketed paste 不双写（原生 `<input>` 回归）                                                               |

> 注：commit `9d64f6b` 前有 `fd2c2e9` 等 #343 全部 12-bullet commits（见完成态交接的 commit 表）。本 session 未 push。

## 已验证状态

```
npm run dev:tui（$HOME/.bun/bin/bun）    => TUI 真实渲染，alternate screen 进入，EXIT=0
npm run dev tui（Node）                   => 清晰指引（非 FFI 报错），EXIT=1
npm run dev -- chat（Node）               => 正常启动，EXIT=0
npm run typecheck                         => 0 错误
npx prettier --check 3 改动文件            => 通过
~/.bun/bin/bun test tests/tui/           => 259 pass / 2 fail（偶发时序，基线即有）
npx vitest run tests/cli/trace.test.ts   => 3 fail（既有 flaky，基线同，与本次改动无关）
```

> 以上失败均为既有 flaky（spawn tsx 子进程超 5s 默认超时 / 测试间资源竞争），**基线同样失败**，非本 session 引入。操作员已授权「其他测试问题单独跑一下过了就行，husky=0」。

## 已定性问题（下个 session 修复清单）

按严重度排序。每项含 **spec 契约**、**当前实现证据**、**根因**、**建议修复方向**。**未在真终端 TTY 复现**——操作员报告的可见症状需下个 agent 起 `npm run dev:tui` 目视确认。

### P0-1 banner/logo 不随消息滚动 + 重复渲染（确定违反 spec）

- **spec 契约**: #321:75 `chat-view.tsx — 单 <scrollbox stickyScroll>（banner + messages + tail）`；#321:102-112 示例 scrollbox 内含 banner；#321:48「单 scrollbox 全内容布局」。
- **当前实现**: `src/tui/chat-view.tsx:129-142` bannerLines 已正确放 scrollbox 内；**但** `src/tui/app.tsx:829-835` 又在 scrollbox 外单独渲染完整 `<Banner info={...}/>`（实现见同文件 `:991-1038`），同时把 `bannerLines` 传给 ChatView（`:836-861`）。app 注释 `:991-993` 自认「固定区块；与 ChatView scrollbox 内 bannerLines 共存」。
- **根因**: banner **双源**——外部固定 Banner（操作员看见的主 logo，不滚动）+ scrollbox 内 bannerLines（滚动的副本）。
- **建议**: 删 app.tsx:829-835 外部 `<Banner>` 渲染，主 logo 只走 ChatView scrollbox 内 bannerLines（方案 B 本来就是 spec 定案）。同时核对 banner.ts 的 `BANNER_MIN_COLS` 降级是否被正确透传。

> **标注（2026-08-10 code-review Standards Low 项）**: DESIGN-BANNER.md §1 的「占满整行宽度的圆角外框 + 顶框内嵌居中 title `◆ iknow`」**仍未实现**——当前实现只把 bannerLines 当 `<text>` 渲染内容，无圆角 box / 无居中 title（`◆ iknow` 只出现在窄终端单行降级 `bannerShortLine`）。待 #154 设计稿定型后再补。

### P0-2 输入框错位（窄终端 / hint 高度未计入）

- **spec 契约**: #146:79 `ChatView 输入框 + 历史消息渲染`；#321:131 空会话 = banner + 输入框。
- **当前实现**: `src/tui/app.tsx:808-812` `viewportRows = Math.max(5, rows - 12)`（**硬编码 12 行 chrome 预算**）；`:818` 根 column 普通 flow，ChatView 在 Banner 后、输入框前；`:897-923` PromptInput 是根 column 后续子项，非 overlay。
- **根因**: (a) `rows - 12` 固定预算，candidate hint 行数未动态计入——窄终端或 hint 弹出时输入框被挤出/溢出；(b) 输入框、状态行、ContextBar 都不在 scrollbox 内，与「全内容滚动」目标冲突。
- **建议**: 用 flex 布局让输入框固定在底部（`marginTop: auto` 或固定高度分配），或把 viewportRows 改为动态扣除 chrome 高度。PromptInput 自身 `src/tui/prompt-input.tsx:189-219` 无硬编码宽高，错位来自父布局。

### P1-3 Ctrl+O 折叠不回（**需求变更，非回归**）

- **重要事实**: `archive/tui-ink/src/app.tsx:1203-1208` 原 ink 实现就是 `setThinkingExpanded(true)`（只展开），注释「切换只归 /thinking；Ctrl+O 是展示思考（只展开）」；#321:43 明确「本 spec 只替换渲染层，不改任何交互语义」。**所以当前「Ctrl+O 只展开、折叠归 /thinking」是 2026-08-08 操作员自己定的语义，不是 #343 改坏的。**
- **当前实现**: `src/tui/app.tsx:780-784` Ctrl+O → `setThinkingExpanded(true)`；`toggleThinking()`（`:600`）是 `!prev` 但只被 `/thinking`（`:665-666`）调。
- **操作员现在期待**: Ctrl+O 再按一次要能折叠回去（= toggle）。
- **建议**: 与操作员确认后把 Ctrl+O 改为 `toggleThinking()`（`setThinkingExpanded(prev => !prev)`），或保留「只展开」但补一个可折叠键位。**这是语义决策，改前先确认，别自作主张。**

### P1-4 ListView 第二输入框 / 搜索（明确违反 #146 纯导航）

- **spec 契约**: #146:86 `列表纯导航（↑↓ + Enter，无第二输入框/focus系统）`；#146:94 仅 ↑↓/Enter/Esc。
- **当前实现**: `src/tui/list-view.tsx:96-98` 引入搜索状态（注释自认「本视图内第二输入框」）；`:124-196` 可打印键过滤 + PgUp/PgDn/Home/End + 自定义窗口；`:235-247` 渲染 `❯ 搜索会话`。
- **根因**: #343 重写给列表视图加了搜索能力，超出 #146 纯导航契约。
- **建议**: 与操作员确认是否保留搜索（可能是需求增强而非 bug）。若按 #146 严格执行则删除搜索输入。

### P2-5 后台状态栏缺 summary（可见契约差异）

- **spec 契约**: #146:96 要求 running-bg 全局状态栏 `后台运行中 · <summary>`。
- **当前实现**: `src/tui/app.tsx:935-938` 只显示 `后台运行中`，**无 summary**。
- **建议**: 接 summary（如 stopSummary / 当前 turn 标题）到后台状态栏。

### P2-6 `⚙` 工具指示符（emoji 约束审查）

- **spec 契约**: #146:86「无 emoji UI 字形（banner 是明确例外）」。
- **当前实现**: `src/tui/context-bar.tsx:79-94` `PREFIX = "⚙ "`（Unicode symbol / emoji-presentation）；`src/tui/prompt-input.tsx:193` `❯ `（符号，通常不算 emoji）。
- **建议**: 审查 ⚙ 是否违反「无 emoji UI 字形」；若要严格合规换文本前缀（如 `[tool]`）。

## Open blockers + next steps

**[NEXT] 起真实终端 `npm run dev:tui` 目视复现 P0-1 / P0-2（banner 双源 + 输入框错位），确认后先修 P0-1：删 `src/tui/app.tsx:829-835` 外部 `<Banner>` 渲染，让主 logo 只走 ChatView scrollbox 内 bannerLines（方案 B，spec #321:75/102-112）。** 修完跑 `~/.bun/bin/bun test tests/tui/` 验证无回归。

- 修 P0-2 输入框错位：把 viewportRows（app.tsx:811 `rows-12`）改为动态 chrome 预算，或输入框固定底部（flex marginTop:auto）。
- P1-3 Ctrl+O 折叠：**先和操作员确认**要 toggle 还是保留只展开；确认后改 `src/tui/app.tsx:782`。
- P1-4 ListView 搜索：**先和操作员确认**保留 or 按 #146 删。
- P2-5 后台 summary：接 summary 到 app.tsx:935-938 后台行。
- P2-6 ⚙ emoji：审查 context-bar.tsx:79 前缀。
- 全部修完：`npm run dev:tui` 真终端 golden path 走一遍（操作员验收清单见完成态交接），再决定 push/PR。

## Suggested skills（下个 agent 建议 invoke）

- `arthurpower:frontend-ui-engineering` — P0-1/P0-2 是布局/视觉回归，该 skill 专门防「AI-aesthetic 前端失败模式」
- `arthurpower:test-driven-development` — 每项修复前先写失败测试（bun:test，tests/tui/）
- `arthurpower:verification-before-completion` — 声称修完前必须真终端实测

## 脱敏

- 无 API key / token / password / credential 值出现
- 凭据一律用环境变量名（`GITHUB_TOKEN`、`MINIMAX_API_KEY`），不写值
