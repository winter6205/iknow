# Session Handoff — graph 通知黄金集 + run_graph description 分工修复 (2026-09-11)

## 本轮做了什么

1. **补上 graph 通知类轨迹集**（此前每个碰 graph 文案的任务都报「仓库无 graph 通知类黄金夹具」——名册缺失导致缺口被反复重新发现，见 `docs/guides/prompt-development.md`「名册」段，本轮新增）。
   - 离线夹具：`tests/harness/graph/graph-mode-notification.fixtures.ts`（G1 有依赖拆分 → run_graph；G2 单发任务 → spawn_subagent；G3 无依赖多任务 → spawn_subagent；prompt 刻意不含工具名，防判定空转）。
   - 离线锁：`tests/harness/graph/graph-mode-notification.test.ts`（含 SSOT 分工句断言，锚定 `src/harness/graph/notification.ts` 常量而非 ADR 号——判定与注入节奏无关，ADR 重编号不破集）。
   - 真模型半边：`archive/tests-real-llm/graph-mode-notification.test.ts`（gitignore 内、`-f` 强制跟踪，与 #960 先例同形）；登记进 `vitest.real-llm.config.ts` include。
2. **真模型抓到并修复一个真实缺陷**：`run_graph` description 原写「ordered **or parallel** sub-agent work」，与通知文 SSOT「several tasks with no ordering → spawn_subagent / a graph with no edges buys nothing over parallel spawns」直接矛盾。
   - **修复前证据**：G3（三个互不依赖的查询）连续 **3 次**选中 `run_graph`（期望 `spawn_subagent`），G1/G2 绿。复跑命令：`npx vitest run --config vitest.real-llm.config.ts archive/tests-real-llm/graph-mode-notification.test.ts -t G3`。
   - **修复**：`src/harness/graph/run-graph-tool.ts` description 改为「ordered sub-agent work whose pieces depend on each other」+ 无序任务指回 `spawn_subagent`。
   - **修复后证据**：G1/G2/G3 全绿（128.6s / 复跑 89.2s，真模型 MiniMax-M3）。
   - 离线回归锁：`tests/harness/graph/run-graph-contract.test.ts` 新增断言（不得再现「or parallel sub-agent work」，须含 no ordering / no edges 分工句）。
3. **名册落地**（`docs/guides/prompt-development.md`）：15 面 × STATIC/SEAM/轨迹集 × 集路径或已登记缺口；缺口处置两条路（补集 / commit 正文登记不建）。规则一句话也进了 `CLAUDE.md` Completion 段。

## 审查结论

- Standards 轴：0 High / 2 Medium（死 manager 注入、测试注释带迭代史）→ 均已修复；Low 中名册 SSOT 范围已修。
- Spec 轴：表格列 2 个 High，实质同一问题——夹具 `basis` 字段锚定 ADR-0080（主仓已标 superseded by 0081）。修复 = 删 `basis`、判定改锚 SSOT 文本常量；0081 已合入 master（PR #989），本集无需改写。Medium/Low 已修：SEAM 锁引用补进名册行、live 集加「模型跳过委派自答」诊断。

## 未做 / 留给后续

- ADR-0081 once-per-run latch 已落地（PR #989）：`graph-mode-presence.test.ts` SC1/SC5/SC7 已按每个 `run()` 一条收紧；本集（首工具判定）无需改。
- `.claude/rules/` 不进 git（`.gitignore:127`）→ worktree 会话读不到 test.md，eval `003-rules-files` / `001-bootstrap-pass` 在 worktree 恒红。已向 operator 提请授权把 rules 纳入版本控制，未决。
- 4 条既有测试红（`~/.iknow/agents` 用户级泄漏进 subagent_type enum）与 3 条 eval 红（同因 + rules 目录缺席）均为环境问题，干净 HOME 下全绿，非本轮引入。

## 复跑入口

```bash
npm run test:real-llm   # 含新集；缺 key → skip + Not run
npx vitest run tests/harness/graph/   # 离线半边 + SEAM 锁
```
