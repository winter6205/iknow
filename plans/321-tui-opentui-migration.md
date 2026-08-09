# Plan: TUI 渲染后端迁移 ink → @opentui/react（#321）

> **Spec**: `specs/321-tui-opentui-migration.md`（ACR 五裁决 5/5 PASS，2026-08-09）
> **Map**: wayfinder:map #321；决策出典 #322（布局）/ #323（输入）/ #324（测试）/ #325（markdown + scrollbox）
> **落地形态**: 一次性大 PR（操作员裁决）= 单分支堆叠提交，每 bullet 1 commit，PR 合并即完成替换。
> **Tracker**: GitHub issue #343（`ready-for-agent` 标签，单 issue 承载全部 12 bullets——操作员裁决不拆票）；D1 = 既有 #327。

## 归档先行策略（操作员裁决：不落旁路）

**T0 归档弹**：`src/tui/` 整体 + `tests/tui/` 整体移入 `archive/tui-ink/`（`src/tui-ink/` + `tests/tui-ink/`），同步排除出编译与测试；`package.json` 移除 ink 入口依赖（依赖项在 D1 最终清理）。此后所有新实现**直接写回原位** `src/tui/` / `tests/tui/`——产品目录从第一刻起只有 OpenTUI 一套，无双组件、无旁路。

中间态纪律（每弹必须满足，husky pre-commit 跑全量 typecheck + vitest）：

```
typecheck 零错误 + npm test 全绿（归档后基线）+ 新弹测试只断言新 src/tui/ 实现
```

T0 归档后到 T7 收口前，`iknow chat` TUI 功能在分支上是坏的（归档即断）——这是一次性大 PR 的既定代价，中间提交不要求 TUI 可运行，只要求编译 + 测试绿。

## 依赖图

```
D1 (#327 已 open) ── T0（归档）
 ├─ D2 ──┐
 ├─ D3 ──┼──────────────┐
 └─ T1 ──┼── T2 ── T3 ──┼── T5 ──┐
         │    │     │   │        ├── T6 ── T7 ── T8
         └── T4 ────┴───┘(∥ T2/T3)┘
```

- `[parallel]`：T2 ∥ T4（T1 之后）；D2 ∥ D3（T0 之后）
- D1 阻塞一切（依赖不就位无法归档 ink 也无法写新件）

---

## Tracer Bullets

### D1. `[decision]` @opentui 依赖安装 + Zig 构建链验证（= GitHub #327，已 open）`[blocks: 全部]`

- **Affects**: `package.json`, `package-lock.json`
- **Acceptance**:
  1. `npm i @opentui/react@<exact> @opentui/core@<exact>` 成功，lockfile 更新，两包均精确锁版（无 `^`/`~`）
  2. Zig 原生二进制 smoke：`node -e` 动态 import `@opentui/core` 构造渲染器并产出一帧，exit 0
  3. 记录实际版本号 + 原生二进制体积入本 plan D1 裁决区（体积 >50MB 停下汇报，spec OQ5）

#### T0. `[implementation]` 归档旧 TUI + 测试，清编译/测试范围

- **Affects**:
  - 移动：`src/tui/*` → `archive/tui-ink/src/`；`tests/tui/*` → `archive/tui-ink/tests/`（git mv 保留历史）
  - 配置：`tsconfig.json` 排除 `archive/`；`vitest` 配置排除 `archive/`（或确认默认 include 不含）
  - `src/cli.ts` / `src/cli/parse-args.ts` 中 TUI 入口临时 stub：chat TTY 路径打印「TUI 迁移中」并以非零码退出（入口判定逻辑保留，spec E3）；`ask` / 管道 / `serve` 路径不动
  - `package.json`：移除 `ink`（此时起全仓无 ink）
- **Acceptance**:
  1. `npm run typecheck` 零错误；`npm test` 全绿（tests/tui 已不在测试范围）
  2. `rg "from \"ink\"|from 'ink'" src/ tests/` 零命中；`package.json` 无 ink
  3. `archive/tui-ink/` 内文件数与原 `src/tui/` + `tests/tui/` 一致（`git mv` diff 核对）
  4. `tests/cli/` / `tests/session-api/` / `standalone.test.ts` 全绿且零改动（spec SC7）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### D2. `[decision]` 测试运行器裁决（vitest 单运行器 vs tests/tui 切 bun:test）

- **Affects**: `tests/tui/runner-spike.test.tsx`（一次性 spike，裁决后删）, `package.json`（仅切 bun:test 时动 scripts）
- **Acceptance**: spike 在 vitest 下跑通 `testRender()` + `mockInput` 各一次；裁决二选一写入本 plan D2 裁决区：
  - A = vitest 兼容 → 保持单运行器，无 scripts 改动
  - B = 不兼容 → `tests/tui/` 切 bun:test，`npm test` 聚合两运行器，聚合命令实测 exit 0

### D3. `[decision]` OpenTUI 能力验证（回填 spec Open Questions 1–3）

- **Affects**: `scripts/otui-capability-probe.ts`（探针脚本，验证后保留作回归）
- **Acceptance**: 探针 exit 0 并输出三条结论（每条 yes/no + 证据帧/输出），写入本 plan D3 裁决区：
  1. `stickyScroll` 是否默认智能模式（用户上滚暂停 auto-scroll）
  2. `<text selectable>` CJK 双宽选择是否正确（不通过 → selection 验收降级 ASCII-only 并记录）
  3. 内置 selection 的剪贴板复制行为（OSC 52 自动 / 需接 `clipboard.ts`）

#### T1. `[implementation]` 渲染入口 + 基础原语 + banner + smoke

- **Affects**: `src/tui/run.tsx`（OpenTUI 渲染器构造 + Error Paths E1/E2 单一 catch）, `src/tui/app.tsx`（根骨架）, `src/tui/banner.ts`, `src/tui/theme.ts`, `src/tui/components.tsx`, `src/cli.ts`（撤销 T0 stub，接回 run.tsx）, `tests/tui/{render-smoke,logo-persists}.test.tsx`
- **Acceptance**:
  1. `npm test -- tests/tui/` 绿；`captureCharFrame()` 帧含 banner 眼字形 + 版本行
  2. 空会话帧 = banner + 输入框，无崩溃（empty 边界）
  3. 渲染器初始化抛错 → 类型化错误消息 + 退出码 1（spec E1/E2 测试）；`run.tsx` 有且仅有一个 catch 点
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T2. `[implementation]` Markdown 渲染重写（#325 规则）`[parallel with T4]`

- **Affects**: `src/tui/markdown.tsx`（保留 `marked.lexer`）, `tests/tui/markdown.test.tsx`
- **Acceptance**:
  1. `captureSpans()` 着色断言绿：bold / em / inline code / strikethrough 各至少一条（spec SC4）
  2. 表格超宽压缩 + `clipOneLine` 测试绿（overflow 边界）
  3. 畸形 markdown（未闭合 fence / 超长无换行单行 / 非法 table）渲染不崩不溢出（negative 边界）
  4. 代码块 `<box title>` 语言标签在边框线上（captureCharFrame 断言）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T3. `[implementation]` `<scrollbox>` 滚动窗口 `[blocks: T5, T6]`

- **Affects**: `src/tui/chat-view.tsx`, `tests/tui/chat-view-scroll.test.tsx`
- **Acceptance**:
  1. sticky 滚动测试绿：用户上滚暂停 auto-scroll；滚回底部恢复；用户发消息 / turn 完成强制滚底（D3 结论 1 决定实现方式）
  2. 长会话（>3 屏）viewport culling 下渲染不崩；布局位置经 ref 直查（`.scrollTop`/`.screenY`）；`rg markdown-lines|message-rows|row-window src/` 零命中（无行计数复发，spec SC3）
  3. 空会话渲染收敛（empty 边界）；`waitForVisualIdle()` 作为异步等待唯一入口
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T4. `[implementation]` 外围组件迁移 `[parallel with T2]`

- **Affects**: `src/tui/{modal,list-view,diff-view,diff-unified,live-tool-preview,live-tool-state,context-bar,ask-user,tool-summary}.tsx?/ts`, `tests/tui/{modal,list-view-scroll,diff-view,live-tool-preview,context-bar,ask-modal,tool-summary}.test.tsx`
- **Acceptance**:
  1. 迁移组件测试全绿（modal 行账不变式 / ListView 搜索翻页 / diff 预览 / ContextBar 只读 `RunResult.lastUsage`——ADR-0008）
  2. 权限 ask modal y/n/a + ↑↓Enter + Esc 行为不变（security-guardrails 契约）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T5. `[implementation]` 输入协议切换 + selection 系统替换

- **Affects**: `src/tui/` 输入接线（OpenTUI 键盘/鼠标事件）, `src/tui/clipboard.ts`（保留读取）, `tests/tui/{copy-flow,keyboard}.test.tsx`
- **Acceptance**:
  1. `mockMouse` 拖选 → `<text selectable>` 选区 → 剪贴板写入成功（D3 结论 2/3 决定 CJK 范围与写入通道）
  2. `mockInput` 修饰键 / 组合键 / bracketed paste 测试绿（Kitty 协议走 OpenTUI 解析器；无自实现 mouse.ts / selection.ts 复发）
  3. Ctrl+Y 重复制 + 无选区提示行为保持（copy-flow 语义不变）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T6. `[implementation]` 流式并发 + message-blocks + session/slash/hub 接线

- **Affects**: `src/tui/{message-blocks,session-state,slash,hub-bridge,deps}.ts(x)`, `tests/tui/{stream-draft-integration,app,input-history,max-turns,slash,session-state,hub-bridge}.test.tsx`
- **Acceptance**:
  1. stream-draft-integration 绿：draft 累积 / thinking 折叠 / tool 运行行 / abort 清理 / 三段一致（UI == harness context == 落盘）
  2. `rg useDeferredValue src/tui/` 有命中（流式并发沿用，spec SC8）
  3. 快速连续 turn（前 turn 未完发新消息）状态机不撕裂（concurrent 边界）；流式中途组件抛错不挂死（exception 边界，spec E4）
  4. app 端到端绿：lazy create / slash 词表 / 三态状态机（idle / running-fg / running-bg）/ `/info` `/quit`（specs/146-tui.md 契约）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T7. `[implementation]` 收口：skip 删除 + 全量绿 + 回归核对（contract）`[blocks: T8]`

- **Affects**: `tests/tui/`（删除 5 个 skip 用例——操作员授权，commit 正文说明原因）, `package.json`（清理 ink 相关残留 dev 项，如有）, `tsconfig.json` / vitest 配置核对
- **Acceptance**:
  1. `npm test` 全绿（全仓）；`npm run typecheck` 零错误
  2. `rg "from \"ink\"|from 'ink'" src/ tests/` 零命中；`package.json` 无 ink（spec SC1）
  3. spec 删除清单核对：`markdown-lines` / `message-rows` / `row-window` / `chat-flow 窗口函数` / `selection.ts` / `selection-render` / `mouse.ts` / `MessageBlocksClipped` 在 `src/tui/` 零命中（仅存于 `archive/tui-ink/`）
  4. `tests/tui/` 外测试与 master 基线零逻辑差异（git diff 核对）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T8. `[implementation]` 验收收口：性能探针 + 平台声明 + eval 闭环 + 归档处置

- **Affects**: `scripts/otui-perf-probe.ts`, `CHANGELOG.md`, `README.md`（或 `docs/STATUS.md`）平台声明, `.evals/tasks/321-tui-opentui-migration.yaml`, `archive/tui-ink/`（PR 内保留为参考；合并后处置另议）
- **Acceptance**:
  1. 性能探针 exit 0：stub 流式源驱动 TUI，`getNativeStats()` 帧统计无丢帧异常（spec SC9a）
  2. `bash .evals/run.sh` 含 321 eval task 且通过（闭环真值）
  3. 文档声明 macOS / Windows 未验证（spec SC10）；CHANGELOG 记录迁移
  4. 操作员真终端 golden path（banner / markdown / diff 预览 / 权限弹窗 / Ctrl+C / `/quit` / 退出后 scrollback 无残留 + 流式无卡顿）完成并记入 handoff（spec SC2/SC9b——人工项，agent 不可代验）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## 裁决回填区

### D1 裁决

> 待执行：@opentui/react 版本 = ___；@opentui/core 版本 = ___；原生二进制体积 = ___

### D2 裁决

> 待执行：运行器 = ___（A vitest 单运行器 / B tests/tui 切 bun:test 聚合）

### D3 裁决

> 待执行：stickyScroll 智能模式 = ___；selectable CJK = ___；selection 剪贴板通道 = ___

## ACR Cross-Check（plan 完成前核对）

| verdict                      | plan 对应                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bounded-context-guardian     | 全部 bullet 限于 `src/tui/` + `tests/tui/` + `archive/tui-ink/`（+ scripts/probes / 构建配置）；T7 核对删除清单；无 harness/session-api/cli 逻辑触碰（T0 仅入口 stub，T1 撤销） |
| defensive-contract-validator | 五类边界分布：empty（T1/T3）、negative（T2）、overflow（T2）、concurrent（T6）、exception（T1/T6）                                                                              |
| error-handling-enforcer      | E1/E2 落 T1 验收（单一 catch 点 + 类型化消息 + 退出码 1）；E4 落 T6                                                                                                             |
| complexity-anti-drift        | 归档后净重写方向，T7 核对旧路径零复发；新实现直接原位，无双套并存                                                                                                               |
| minimal-change-verifier      | 12 bullets = 12 commits，一弹一任务；skip 删除集中 T7，commit 正文说明原因                                                                                                      |
