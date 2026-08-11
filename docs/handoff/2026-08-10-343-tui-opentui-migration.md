# Session Handoff — #343 TUI ink→@opentui/react 12-bullet 迁移（2026-08-10，完成态）

## 当前 live 状态

- **任务**: 按 issue #343 计划完成 TUI 渲染后端 ink → @opentui/react 迁移（12 tracer bullets，单分支堆叠提交，一次性大 PR）。**全部 12 bullets 已完成并验证**，pending：最终 code review + push + PR。
- **角色进度**: leader = 主会话（编排 + 部分 T8 实施）；T5/T6-A/T6-B/T6-C/T7/T8 由子代理实施（T7/T8 部分因 API 429 由 leader 接管）；T8 探针/eval/文档由 leader 直接实施。
- **分支变化**: 工作从 `.qoder/worktrees/321-tui-opentui-migration`（分支 `worktree-321-tui-opentui-migration`）**迁移到 `.claude/worktrees/tui-321-guarded`（分支 `worktree-tui-321-guarded`）**——bg session 的 worktree guard 要求 EnterWorktree 隔离标记；新分支是原分支后代，含全部 commits。原 worktree 保留未动。

## 最终验证状态（T8 完成后基线）

```
~/.bun/bin/bun test tests/tui/    => 261 pass / 0 fail / 0 skip（25 files）
npx vitest run                    => 144 files / 1948 pass
npm run typecheck                 => 0 错误
bash .evals/run.sh --task 321     => 1/1 passed
~/.bun/bin/bun scripts/otui-perf-probe.ts => 3×yes（帧统计/scrollbox/突发批处理）
SC1: ink 全仓零命中；SC3: 行计数模块仅 archive；SC7: src/cli harness session-api 零改动
```

## 本 session 全部 commits（分支 worktree-tui-321-guarded）

| commit    | 一行效果                                                             |
| --------- | -------------------------------------------------------------------- |
| `0623038` | D1：@opentui/react+core 0.5.1 精确锁版                               |
| `d5567df` | D1 裁决回填                                                          |
| `6134dd7` | T0：68 文件 git mv 入 archive/tui-ink/ + ink 移除                    |
| `cec95f4` | D2：tests/tui 切 bun:test 聚合双运行器                               |
| `59c6407` | D3：能力探针 3×yes                                                   |
| `688f844` | T1：渲染入口 + 基础原语 + banner + E1/E2 单 catch                    |
| `a7c888e` | T2：markdown.tsx 重写（marked.lexer + OpenTUI 元素树）               |
| `463897d` | T4：9 外围组件迁移                                                   |
| `8332d17` | T3：chat-view scrollbox sticky 滚动 + ref 直查                       |
| `0508ac3` | T5：输入协议 + selection 替换（clipboard OSC52 接线 + 测试）         |
| `4796ad2` | T6-A：session-state/slash/hub-bridge/deps 迁移                       |
| `aaba5a3` | T6-A：对应测试切 bun:test                                            |
| `59faa02` | T6-B：message-blocks 重写（去 Clipped）+ ChatView 扩展               |
| `25f31d1` | T6-C：app 端到端接线（状态机/slash/hub/流式/权限/退出）+ PromptInput |
| `3d925a0` | T6-C：app 端到端测试（7 cases）                                      |
| `d8d20e6` | T6-C：stream-draft/max-turns/input-history/slash-hint/cross-entry    |
| `4c55ce5` | T6-C：stream-draft-integration 流式端到端                            |
| `d056250` | T7：清理过时行账引用注释 + makeDeps delayMs 扩展                     |
| `e65d44b` | T7：修复 tool_call_start → [运行中] 时序 skip（内联 adapter）        |
| `eb8b273` | T8：性能探针 getNativeStats + 321 eval task                          |
| `b023bf2` | T8：CHANGELOG + 平台声明                                             |

## 工作环境关键事实（运维知识，供后续 agent）

- **bun**: 只有 `~/.bun/bin/bun`（Linux 1.3.14）能驱动 OpenTUI FFI；tests/tui 跑法 `~/.bun/bin/bun test tests/tui/`（尾斜杠必须）。性能探针同 bun 跑。
- **husky pre-commit**: 每 commit 跑 lint-staged + typecheck + 全量 npm test（约 1 分钟）。
- **worktree guard**: bg session 下子代理写文件需父 session 有 EnterWorktree 隔离标记（否则 PreToolUse guard 拒绝）。在 `.claude/worktrees/` 下新建 worktree 需 `worktree.baseRef=head`（local git config）。
- **API 429**: MiniMax-M3 Token Plan 用量上限会终止子代理（T7/T8 各一次）。后续若派子代理留意。
- **string-width**: 非孤儿（banner/markdown/tool-summary 3 处使用，视觉宽度 CJK 计算）。@opentui/core 内置 7.2.0，项目 8.2.2，版本并存未收敛。
- master 本地领先 origin/master 3 commits（spec/plan/tracker）未推；PR 前需先推 master 或接受 PR diff 含这 3 个 docs commit。

## Open blockers + next steps

**[NEXT] 最终收口（本 session 正做）**:

1. arthurpower:code-review 全 diff 双轴审（Standards + Spec）。
2. push 分支 `worktree-tui-321-guarded`（或合并回原分支后 push `worktree-321-tui-opentui-migration`）。
3. 推 master 3 docs commits（spec/plan/tracker）或 PR 正文说明。
4. gh pr create --draft base master，PR 正文含裁决摘要 + 人工验收清单。
5. 可选善后：关闭 #327（D1 已实质完成）。

## 人工验收清单（操作员真终端 golden path，spec SC2/SC9b——agent 不可代验）

- [ ] 真实 TTY `iknow chat` 启动：banner（眼形 + 版本行）完整渲染。
- [ ] markdown 渲染：bold/em/code/strikethrough 着色正确。
- [ ] 工具 diff 预览：write_file/edit_file 红绿 diff。
- [ ] 权限弹窗：y/a/n + ↑↓ + Enter + Esc 行为正确。
- [ ] Ctrl+C 打断前台 turn；/quit 退出（含 running-bg 二次确认）。
- [ ] 退出后终端 scrollback 无 TUI 中间帧残留（alternate-screen 收口）。
- [ ] 流式会话无明显卡顿（性能感知）。

## 脱敏

- 无 API key / token / password / credential 值；gh 认证走本机 gh CLI 既有凭据。
