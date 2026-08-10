# Spec: TUI 渲染后端迁移 ink → @opentui/react（#321）

> 来源：`wayfinder:map` #321 + 已关闭决策 issue #322（布局 API）/ #323（输入协议）/ #324（测试基建）/ #325（Markdown 渲染 + 滚动窗口，合并 #326）。
> 上游 spec：`specs/146-tui.md`（交互骨架契约，本 spec 只换渲染后端，交互语义不变）。
> 前置票：#327（安装 @opentui 依赖 + 验证 Zig 构建链）——实施第一步。
> 交付形态：**一次性大 PR**，无双轨过渡期（操作员已裁决）。

## Objective

将 `src/tui/` 渲染后端从 ink 替换为 `@opentui/react`，保留 React 组件写法，一次性收口全部 4 个已知渲染问题：

1. **scrollback 污染**（ink 每帧重绘泄漏到终端历史）→ OpenTUI alternate-screen + Zig 双缓冲 dirty-cell diff，架构层面消除。
2. **行计数漂移**（`markdown-lines.ts` 镜像渲染树行数估算与实际渲染不一致）→ 删除整条行计数路径，滚动交给 `<scrollbox>`（布局位置 ref 直查 `.screenY`/`.height`）。
3. **ANSI 着色测试失败**（ink `lastFrame()` ANSI 断言脆弱，5 个用例 skip）→ skip 用例删除（操作员裁决，测试逻辑不同），着色断言用 `captureSpans()` 结构化重写。
4. **keyboard probe 吞键**（自实现 Kitty 协议解析 + `run.tsx` 禁用逻辑）→ 切 OpenTUI 内置 Kitty keyboard 解析器。

用户 = iknow 开发者（TUI 唯一用户群）。成功 = 四大问题各有二元验收通过 + 全测试绿 + `ask`/`serve`/管道路径零影响。

## Glossary（CONTEXT.md 原样引用）

- **chat REPL / product CLI**：TTY interactive `iknow chat`（或裸 TTY invoke）的人类视图；管道模式为串行非终端 turn。本 spec 的渲染后端即此视图的承载层。
- **oneshot / ask**：脚本/CI 路径，单次问题 → JSON on stdout。**不经过 TUI 渲染，零影响**。
- **iknow serve**：CLI host，Session API + 静态产品 UI（`web/dist`）。**不经过 `src/tui/`，零影响**。
- **streaming arm**：LLM 默认流式臂，host 侧只见 `HarnessStreamEvent`。TUI 流式并发模型（`useDeferredValue` + `startTransition`）**直接沿用**，不改流式架构（#322 Resolution：OpenTUI ConcurrentRoot + react-reconciler 0.33 完整支持）。
- **context usage (display)**：TUI `ContextBar` 消费 `RunResult.lastUsage`（ADR-0008 D5）。迁移**只换渲染组件，数据路径不变**。
- **observability side-channel**：工具 `meta` 经 `PostToolUseHook.payload` → `TuiToolEvent.payload` → `LiveToolRun` 供 TUI diff 预览。事件契约不变，只换消费端组件。

**迁移术语**（外部库 API，出典 #322–#325 Resolution，非 iknow 领域词、不入 CONTEXT.md）：

| 术语                                    | 出典      | 含义                                                                  |
| --------------------------------------- | --------- | --------------------------------------------------------------------- |
| `<scrollbox>`                           | #322      | OpenTUI 内置滚动容器：`scrollTop` / `stickyScroll` / viewport culling |
| `<text selectable>`                     | #323/#325 | OpenTUI 内置文本选择（`Selection` 类，per-renderable hooks）          |
| `captureSpans()` / `captureCharFrame()` | #324      | 结构化样式捕获 / 纯字符帧捕获（测试断言）                             |
| `mockInput` / `mockMouse`               | #324      | 键盘（完整键码 + Kitty 协议）/ 鼠标模拟                               |
| `waitForVisualIdle()`                   | #324      | 异步渲染稳定等待（流式测试原生解法）                                  |
| `TextAttributes` bitmask                | #325      | OpenTUI 文本样式位掩码（bold/em/strikethrough 等）                    |
| `getNativeStats()`                      | #324      | 原生渲染统计（性能探针数据源）                                        |

## Architectural Constraints（按编号引用）

- **ADR-0008**：token 用量显示契约。`ContextBar` 必须继续只读 `RunResult.lastUsage`，禁止迁移中引入第二份 token 账本或改 `lastUsage` wire 形状。
- **specs/146-tui.md**：交互骨架契约全部保留——三态状态机（idle / running-fg / running-bg）、slash 词表、lazy create、无 emoji UI 字形（banner braille 例外）、SessionHub 唯一保存路径、`ReadonlyArray` + `Object.freeze` 消息纪律。**本 spec 只替换渲染层，不改任何交互语义**。
- **specs/security-guardrails.md**：权限确认（ask-user / modal）与中断超时行为不变；渲染后端替换不得改变权限提示的阻塞语义。
- **#322 Resolution**：reconciler 整体替换；双缓冲 + alternate-screen 为默认。
- **#323 Resolution**：鼠标/键盘/选择全切 OpenTUI 内置；**剪贴板读取保留自实现**（OpenTUI 无读取能力，OSC 52 仅写）。
- **#324 Resolution**：测试基于 `@opentui/react/test-utils`（真实 `CliRenderer` 引擎，非 mock）；运行器决策见 Tech Stack。
- **#325 Resolution**：markdown 重写规则（`<text>` + bitmask inline / `<box title>` 代码块语言标签 / 表格自适应列宽）+ 单 `<scrollbox stickyScroll>` 全内容布局 + 智能 sticky 滚动。

## Tech Stack

- **新增**：`@opentui/react` + `@opentui/core`，**精确锁版本（无 `^`/`~`）**——年轻依赖 + Zig 原生二进制，升级走显式决策。具体版本由 #327 安装验证确定。
- **移除**：`ink@^7.1.1` 及全部 ink 测试装配。
- **保留**：`react@^19.2.8`（满足 OpenTUI ≥19.2 要求，不升不降）、`marked`（`lexer` tokenization 保留，两处调用合并一处）、`clipboard.ts` 原生剪贴板集成。
- **接受**：Zig 构建链 / 原生二进制依赖（操作员已裁决接受；#327 前置验证）。
- **测试运行器（操作员裁决：可分开）**：主套件保持 vitest；`tests/tui/` **先验证 vitest 下 test-utils 可用性**，不可用则切 bun:test 单独跑，`npm test` 聚合两个运行器（`vitest run` + tui 运行器）。风险限制在 tui 目录内。

## Commands

```
Build:      npm run build
Typecheck:  npm run typecheck
Test:       npm test                 # vitest 全量；若 tui 切 bun:test 则聚合
Test(tui):  npm run test -- tests/tui  # 迁移期局部跑
Dev:        npm run dev -- chat      # TTY REPL（TUI 主验收路径）
前置验证:    #327 — npm i @opentui/react @opentui/core 后跑 Zig 构建链 smoke
```

## Project Structure

```
src/tui/                     — 迁移范围全部在此
  run.tsx                    — 渲染入口重写：ink render → OpenTUI 渲染器；删 Kitty 禁用逻辑
  app.tsx                    — 根组件迁移；删 chatScroll 状态 + onWindow 回调
  chat-view.tsx              — 单 <scrollbox stickyScroll>（banner + messages + tail）
  markdown.tsx               — 保留 marked.lexer；映射改 OpenTUI 组件（#325 规则）
  clipboard.ts               — 保留（读取逻辑；OSC 52 写入缺口）
  其余组件（components / context-bar / diff-view / list-view / modal /
          live-tool-preview / banner / theme / session-state / slash / deps / hub-bridge）
                             — 逐个迁移：ink 原语 → OpenTUI 原语，逻辑不变

删除（#325 Resolution 清单）:
  src/tui/markdown-lines.ts          — 整文件（行计数镜像树）
  src/tui/chat-flow.ts               — computeWindow / computeMeasured / tailSlot / flatContentLines
  src/tui/message-rows.ts            — 行计数 SSOT
  src/tui/row-window.ts              — RowSlice / ContentWindow 类型
  src/tui/selection.ts               — 自定义 selection 系统
  src/tui/selection-render.tsx       — selection 渲染
  src/tui/mouse.ts                   — 自实现 SGR 鼠标协议
  src/tui/message-blocks.tsx         — MessageBlocksClipped 组件（其余保留）
  src/tui/text.ts                    — 视觉宽度工具简化（CJK 切 OpenTUI stringWidth）

tests/tui/                   — 37 个测试文件迁移；删除文件对应测试
                               （markdown-lines / message-rows / selection / mouse）
specs/321-tui-opentui-migration.md — 本 spec
```

## Code Style

```tsx
// OpenTUI 小写内置元素；样式走属性，不走嵌套 <Text bold>（#325 决策 2）
<scrollbox stickyScroll width="100%" height="100%">
  <box flexDirection="column">
    <text fg={theme.text}>{plain}</text>
    <text>
      <strong>{boldSegment}</strong> <em>{emSegment}</em>
    </text>
    <box borderStyle="single" title={lang} titleColor={theme.dim}>
      <text>{code}</text>
    </box>
  </box>
</scrollbox>;

// 布局位置 ref 直查，禁止再建镜像渲染树数行（#322）
const ref = useRef<ScrollBoxRenderable>(null);
ref.current?.scrollTop; // / .screenY / .height

// 消息纪律不变（specs/146-tui.md）
state.messages = Object.freeze([...result.messages]);
```

命名沿用现有 TUI 模块风格（kebab-case 文件名、函数组件）；格式化走 prettier 既有配置。

## Testing Strategy

- **迁移范围**：`tests/tui/` 37 个文件（#324 确认全部可迁移）；交互模拟切 `mockInput`/`mockMouse`，异步等待切 `waitForVisualIdle()`。
- **skip 用例**：现有 5 个 skip 用例**直接删除**（操作员明确授权：测试逻辑已不同）。commit 正文说明原因（遵守 `.qoder/rules/test.md` 删除测试授权条款）。后续着色断言在新测试里用 `captureSpans()` 表达，不恢复旧断言形态。
- **删除文件对应测试**：`markdown-lines.test.tsx` / `message-rows.test.ts` / `selection.test.ts` / `mouse.test.ts` 随实现删除（被测对象消失）。
- **新增测试重点**：`<scrollbox>` sticky 滚动行为（上滚暂停 / 回底恢复 / 用户发消息与 turn 完成强制滚底）；`<text selectable>` 复制流（替代 `copy-flow.test.tsx` 的 selection 路径）；`captureSpans()` 着色断言（bold / em / code / strikethrough）；表格超宽压缩 + `clipOneLine`。
- **五类边界覆盖（defensive contract）**：
  - **empty**：空会话（零消息）ChatView 渲染 = banner + 输入框，无崩溃；空 markdown 内容（空字符串 / 纯空白 token）渲染为空，不留空行残影；空流式 delta 序列（首 token 前中断）渲染收敛。
  - **negative**：畸形 markdown（`marked.lexer` 对未闭合 fence / 嵌套非法 table / 超长无换行单行 token 的输出）渲染不崩、不溢出 `<scrollbox>`；超长单行 CJK 文本截断正确。
  - **overflow**：表格超宽压缩 + `clipOneLine`（上条）；长代码块在 `<scrollbox>` 内横向滚动 / 截断不破坏外层布局。
  - **concurrent**：流式并发（`stream-draft-integration` + `waitForVisualIdle`，上条）；快速连续 turn（前 turn 未完即发新消息）状态机不撕裂。
  - **exception**：渲染器初始化失败时进程以非零退出码退出并打印类型化错误（见 Error Paths E2）；流式渲染中途抛错不挂死进程（错误经既有 TUI 错误显示路径呈现或干净退出）。
- **运行器**：vitest 优先验证；不兼容则 `tests/tui/` 切 bun:test，`npm test` 聚合（Tech Stack 节）。
- **不测**：跨终端像素级差异（非 Linux 平台不验收）；OpenTUI 内部渲染引擎行为（上游职责）。
- **手工验证（进 handoff）**：真实 TTY `iknow chat` golden path——banner / markdown / 工具 diff 预览 / 权限弹窗 / Ctrl+C / `/quit` / 退出后 scrollback 无残留。

## Error Paths（类型化失败路径）

所有失败路径显式退出或显式呈现，禁止静默吞错、禁止无限重试。错误信息不泄露密钥 / 路径之外的敏感细节（security-boundaries 规则）。

| #   | 失败场景                                                     | 行为契约                                                                                                          | EXIT 语义                              |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| E1  | Zig 原生二进制缺失 / 加载失败（`@opentui/core` 初始化抛错）  | 捕获后打印类型化错误：`TUI 渲染后端初始化失败：<cause>。请重新安装依赖（npm ci）后重试`，不打印堆栈中的密钥类字段 | 进程退出码 1，不降级、不重试           |
| E2  | 渲染器初始化失败（终端能力不足 / alternate-screen 进入失败） | 同 E1 错误呈现路径，cause 区分来源                                                                                | 进程退出码 1                           |
| E3  | 非 TTY 环境误入 TUI 路径                                     | 维持现有管道模式判定（迁移不改入口判定逻辑）；管道走串行非终端 turn，不进 OpenTUI 渲染器                          | 不适用（非错误路径）                   |
| E4  | 流式渲染中途组件抛错                                         | 错误经既有 TUI 错误显示路径呈现（与 ink 时代错误面一致）；渲染器不可恢复时打印类型化错误后退出                    | 可恢复 = 继续运行；不可恢复 = 退出码 1 |
| E5  | `<scrollbox>` 内容高度异常（0 / NaN）                        | 渲染层兜底为最小一行高度，不抛布局异常                                                                            | 不退出（渲染兜底）                     |

实现要求：E1/E2 用单一 catch 点包裹渲染器构造（`run.tsx` 入口），错误消息常量化（禁 magic string）；E4 错误边界位置在实现计划中明确（React error boundary 或渲染器事件），不留空 catch。

## Boundaries

- **Always**：保留 `marked.lexer` 解析（只重写渲染映射）；保留 `clipboard.ts` 原生读取；`ContextBar` 数据路径不变（ADR-0008）；交互语义不变（specs/146-tui.md）；精确锁 `@opentui/*` 版本 + lockfile 更新；删除测试在 commit 正文说明原因；**copy 触发 = 右键 down+up（不再是拖选松键自动复制 + Ctrl+Y 重复制键位）——fix-session 2026-08-10 B1 决策 supersede commit `0508ac3` 原 T5 selection 自动复制 + Ctrl+Y 接线（supersede 部分为 fix-session 单独定义；其余 T5 接线保留）**。
- **Ask first**：`@opentui/*` 版本升级或换版本；测试运行器从 vitest 切 bun:test 的最终触发（先验证 vitest 可用性，实测不兼容才切并汇报）；`serve` / `ask` 出现任何连带改动的迹象（立即停下汇报）；剪贴板写入路径从原生工具切 OSC 52。
- **Never**：保留 ink 依赖或双轨渲染路径（一次性替换）；重新引入行计数 / 镜像渲染树；把 `meta`（observability side-channel）拼进 model tool_result；为迁移改动 SessionHub / session-api / harness 任何代码；在非 Linux 平台做验收承诺。

## Success Criteria（全部二元可测）

1. `package.json` 无 `ink`；`rg "from \"ink\"|from 'ink'" src/ tests/` 零命中；lockfile 含精确锁定的 `@opentui/*`。
2. **scrollback 收口**：真终端跑一轮 `iknow chat` 后退出，终端 scrollback 无 TUI 中间帧残留（操作员目视验收）。
3. **行计数收口**：`markdown-lines.ts` / `message-rows.ts` / `row-window.ts` / `chat-flow.ts` 窗口函数已删除；`npm run typecheck` 零错误；滚动位置全部来自 `<scrollbox>` / ref 直查（代码审查确认无镜像渲染树）。
4. **ANSI 着色收口**：5 个 skip 用例已删除（commit 正文说明）；新测试含 `captureSpans()` 着色断言（bold / em / code 至少各一）且绿。
5. **键盘收口**：`run.tsx` Kitty 禁用逻辑删除；键盘事件全走 OpenTUI 解析器；keyboard probe 相关测试绿（`mockInput` 模拟修饰键 + 组合键）。
6. `npm test` 全绿：37 个迁移文件 + 新增测试；`tests/tui/` 外测试零修改（除 import 路径等零逻辑改动）。
7. `ask` / 管道模式 / `serve` 零影响：`tests/cli/` / `tests/session-api/` / `standalone.test.ts` 全绿且 diff 不含 `src/cli/`、`src/session-api/`、`src/harness/`。
8. **流式并发沿用**：`stream-draft-integration.test.tsx` 迁移后绿；`useDeferredValue` 仍在 streaming draft 路径（代码审查确认）。
9. **性能双层验收**：(a) 脚本化流式负载探针（stub 流式源驱动 TUI，`getNativeStats()` / 帧统计无丢帧异常）通过；(b) 操作员真实终端跑一轮流式会话，主观确认无明显卡顿。
10. **平台范围**：Linux（含 WSL2）验收通过；README / docs 声明 macOS / Windows 未验证。
11. **错误路径契约**：Error Paths E1/E2 有测试覆盖（模拟渲染器初始化抛错 → 类型化错误消息 + 退出码 1）；`run.tsx` 渲染器构造有且仅有一个 catch 点；全仓 TUI diff 无空 catch、无 magic error string（代码审查确认）。

## Open Questions

1. OpenTUI `stickyScroll` 是否默认智能模式（用户上滚暂停）——实现阶段第一步验证，结果回填 #325 待验证项。
2. `<text selectable>` 的 CJK 双宽选择是否正确——实现阶段验证；不通过则 selection 验收降级为 ASCII-only 并记录。
3. 内置 selection 的剪贴板复制行为（是否自动走 OSC 52 / 需手动接 `clipboard.ts`）——实现阶段验证。
4. 量化性能指标（帧率 / 帧耗时门槛）——本期不设，人工 + 探针双层验收；后续需要再立 issue。
5. 包体积影响（Zig 原生二进制体积）——#327 安装后记录实际体积，超预期（如 >50MB）停下汇报。
6. 测试运行器最终形态——vitest 兼容性实测后定（Tech Stack 节决策树）。

---

## ACR 5-Verdict Gate（architecture-change-reviewer）

首轮 BLOCKED（defensive-contract-validator unclear：缺 empty/negative/exception 边界；error-handling-enforcer no：无类型化失败路径）→ 回填 Testing Strategy 五类边界 + Error Paths E1–E5 + 成功标准 #11 → 复审 PASS（2026-08-09）。

```
bounded-context-guardian:     yes — 爆炸半径圈定 src/tui/ + tests/tui/；Never 条款禁触 harness/session-api/cli；成功标准 #7 二元可验
defensive-contract-validator: yes — 五类边界（empty/negative/overflow/concurrent/exception）均有具体用例，E1/E2 与 Error Paths 表交叉引用
error-handling-enforcer:      yes — E1–E5 每条有类型化消息 + cause + EXIT 语义；run.tsx 单一 catch 点；无空 catch / magic string
complexity-anti-drift:        yes — 净删除方向（9 文件整条移除），无新抽象层，Code Style 禁镜像树复发
minimal-change-verifier:      yes — 单一逻辑任务（渲染后端整体替换），一次性大 PR 为操作员明示裁决
```

**OVERALL: PASS — hand to writing-plans.**
