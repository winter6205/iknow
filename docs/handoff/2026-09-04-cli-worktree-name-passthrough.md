# Session Handoff — CLI worktree isolation provision `name` passthrough (2026-09-04)

## 当前 live 状态

- **任务**: 修复 iknow trace 自查发现的 `name` 静默丢字段 bug，并随 PR #869 落地后同步把 4 个陈旧测试对齐到新 SSOT。
- **Worktree**: `/home/winner/projects/iknow/.claude/worktrees/fix-cli-provision-name-passthrough`
- **分支**: `worktree-fix-cli-provision-name-passthrough`
- **为什么重要**: PR #869 在 hub 侧把 `name` label 透传到 `createTaskWorktreeProvisioner.provision`，但 cli.ts main() 内联的手工解构 wrapper 把 `name` 静默丢弃——CLI 入口因此退化为 UUID-only leaf（编译仍绿，无运行时信号）。修复点在装配层（不是 provisioner）。
- **operator 指令**: 按本任务分 2 个 commit 提交；不 push；不在 main checkout 改文件。

## 已固化工件（引用）

| 类型     | 路径 / URL                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------- |
| 领域词汇 | `docs/CONTEXT.md`                                                                                  |
| 决策记录 | `docs/adr/0037-worktree-isolation-on-mutate.md`                                                    |
| 计划     | `plans/task-worktree-lifecycle.md` + `plans/worktree-live-task-root.md`（T3 model-provision 契约） |
| 根因     | `src/cli.ts:316-321`（修复前）→ `src/cli/worktree-host.ts`（修复后）                               |

## 当前变更（已 commit，未 push）

两 commit 全部在工作分支 `worktree-fix-cli-provision-name-passthrough`，未 push：

```
d1761ba6 test: realign stale registry-order and worktree-gate assertions with #869
1f79f91d fix(cli): pass `name` through the worktree isolation provision seam
```

### commit 1 — `fix(cli): pass name through the worktree isolation provision seam`

- `src/cli/worktree-host.ts`（新增）：`createWorktreeIsolationHost` 工厂，纯透传 `WorktreeProvisionContext` → `worktreeProvisioner.provision`。docstring 写明 PR #869 漏改点（手工解构静默丢字段、编译仍绿）。
- `src/cli.ts:67`：新增 `import { createWorktreeIsolationHost } from "./cli/worktree-host.js"`。
- `src/cli.ts:316-321`：`runChat()` 内的内联 wrapper `provision: ({ conversationId, root: sessionRoot }) => worktreeProvisioner.provision({ conversationId, root: sessionRoot })` 替换为 `createWorktreeIsolationHost({ worktreeProvisioner })`。整 ctx 透传。
- `tests/cli/worktree-host.test.ts`（新增）：接真 `SessionStore`（`mkdtempSync`）+ 真 `createTaskWorktreeProvisioner({ store })` + 真 git repo（`git init` + 初始 commit）+ fresh `conversationId`("conv-cli-a"/"conv-cli-b")。两条用例：① `name: "fix-648"` → leaf 收尾 `fix-648--conv-cli-a`；② 无名 → UUID-only leaf `conv-cli-b`。`taskWorktreeOwnerOf(root)` 闭环断言。

### commit 2 — `test: realign stale registry-order and worktree-gate assertions with #869`

PR #869 把 `ACI_TOOLSET_NAMES` 从 30 件扩到 44 件（追加 `list-task-worktrees` + `remove-task-worktree`，并随 symbol-primary-aci + trace-read-side 已有的 append 累计），并把 T3 model-provision 契约落地（gate 不再自动 provision，建树是模型经 `create-task-worktree` 工具的职责）。本次按 2026-09-04 review 评估结论逐文件重写或 SSOT 化：

- `tests/harness/aci/tools/get-record.test.ts:212` —— 旧断言 "is assembled last in the registry" 的「末位」前提永久失效（PR #869 又 append 2 件 host 缝条件化装配的 list/remove）。按 review rule #2 整体重写：测试名改为 "is assembled unconditionally at the trace read-side content axis tail and its bounds are enforced by ajv"，断言改 SSOT 派生（`indexOf("get_record")` + `slice(getRecordIdx+1)` + 收尾仍为 `get_record` 当无 host 缝）+ ajv bound 不变 + 新增「尾部只能 append host 缝条件化件」不变式。
- `tests/harness/aci/tools/list-sessions.test.ts:214` —— 旧断言 "is assembled unconditionally right before the content axis" 前提仍成立（list_sessions 与 get_record 在 SSOT 仍相邻）。按 review rule #3 索引改 SSOT 派生：`indexOf("list_sessions")` / `indexOf("get_record")` + `getRecordIdx - listSessionsIdx === 1`（append-only 相邻不变式）+ 新增 `query_trace` < `list_sessions` 行轴先于目录轴的不变式。
- `tests/harness/aci/tools/query-trace.test.ts:268` —— 旧断言 "registers query_trace as an append-only SSOT member (followed by … 22 件)" 前提仍成立。按 review rule #3 数字改 SSOT 派生：`indexOf("query_trace")` + `tailCount = ACI_TOOLSET_NAMES.length - queryTraceIndex - 1` + 尾部非空不变式 + 本场景无 host 缝时 `get_record` 收尾。
- `tests/tui/deps-isolation.test.ts:65` —— 旧断言 "首个 mutate 被门禁拦截且 provision 收到会话锚" 旧设计（gate 自动 provision）已废弃。按 ADR-0037 T3 model-provision 契约永久翻转：测试名加 "(T3 model-provision 契约)"，`calls === [{ conversationId: "conv-1", root }]` → `calls === []`（gate 零 provision 调用），并断言 block 文案包含 "create-task-worktree"（让模型走对的恢复路径）。
- `tests/tui/deps-tools.test.ts:115` —— 旧断言 "buildTuiDeps — 工具集必须与 buildHarnessEngine 对齐(30 件)" 前提仍成立。按 review rule #3 数字改 SSOT 派生：`EXPECTED_TUI_TOOLSET = ACI_TOOLSET_NAMES.filter(n => !EXCLUDED_FOR_TUI_NO_HOST_SEAM.includes(n))`，其中 EXCLUDED 显式列出本测试 opts 不透传的 6 件 host 缝条件化件（`run_graph` + 5 件 worktree 工具）；并显式断言旧 `lsp_*` 已退役不再出现在 surface 上。

未删任何测试，未降任何 assert 强度；review 评估的所有"前提仍成立"项已用 SSOT 派生替代硬编码下标，"前提已永久消失"项（get-record "is assembled last"）已重写测试名与断言以认证仍然真实存在的不变式（unconditional + ajv-bound + append-only tail + host-seam-conditional-only 收尾规则），而非仅改下标让旧名字挂着假前提。

## 已验证状态

```text
# typecheck
npm run typecheck
=> 最近一次 exit 0

# 全量 vitest（CI 兜底面）
npx vitest run
=> 405 files passed (405), 5888 tests passed (5888), 0 failed, 141s

# 工作分支 diff 触发的窄集（pre-commit 等价）
npm run test:changed
=> 第 1 commit 后 3 files / 29 tests passed
=> 第 2 commit 后 "No test files found"（working tree = HEAD，无 diff）

# bun test tests/tui/
$HOME/.bun/bin/bun test tests/tui/
=> 1191 pass / 7 fail（7 失败与 main checkout 同名同位置，且与本任务无关——
   是 PR #879 之前 master 上既有的 TUI 时序 flaky 与 9s+ timeout 类）
```

7 个 TUI 失败逐项定位（对照 main checkout /home/winner/projects/iknow 同名失败）：

1. `端到端:createTuiBridge.postMessage 透传 verify DTO > verifyConfig 配置 + 验证 exit 0 → TuiPostResult.verify === {outcome:'passed', rounds:1}` [53ms] — main 同名同位置失败。本任务未触动 `src/tui/deps.ts` 或 `web/`。**已确认：main 上 pre-existing，非本任务引入**。
2. `TUI /continue slash > negative` [9.4s] — main 同名同位置失败，9s+ 时序 flaky。
3. `TUI /continue slash > pending slash` [9.3s] — main 同名同位置失败，9s+ 时序 flaky。
4. `TUI pending NL > hit` [9.6s] — main 同名同位置失败，9s+ 时序 flaky。
5. `TUI pending NL > nl_not_single_token` [9.4s] — main 同名同位置失败，9s+ 时序 flaky。
6. `TUI pending NL > nl_pending_only` [9.6s] — main 同名同位置失败，9s+ 时序 flaky。
7. `TUI pending NL > overflow` [1.9s] — main 同名同位置失败（中位时长，不是 9s 超时），疑似独立非 flaky bug，但属 master 已存状态。

按用户原指令：9s 超时类若是两边都挂的时序 flaky，不改产品代码；本任务范围外的 master 既存失败同样不在本轮处理。证据：每条都在 main checkout（`/home/winner/projects/iknow`）用同命令复现失败。

## Code review 收尾（已发，未阻塞）

两轴均 `OVERALL: PASS`，0 High / 0 Medium：

- Standards（`arthurpower:standards-reviewer-agent`）：6 Low（Middle Man 工厂 / Primitive Obsession 数据团 / T3 契约翻转 / SSOT 派生索引 / append-only tail 循环 / 真 git 调用）；Hard rule audit 与 Fowler 12 smell 复核均无触发。文件级证据已在 PR review 记录。
- Spec（`arthurpower:spec-reviewer-agent`）：1 Low（factory 重构比最小修复多扩 ~25 LOC，但有可测性 + future-proofing 双重正当性）；Requirement coverage 全部 PASS。Spec source = plans/task-worktree-lifecycle.md + plans/worktree-live-task-root.md T3 + plans/worktree-isolation-on-mutate.md + code-quality.md + test.md。

GATE: PASS（0 High unresolved）。

## Open blockers + next steps

**[NEXT] 下一会话请直接进入 `/home/winner/projects/iknow/.claude/worktrees/fix-cli-provision-name-passthrough`：**

1. `git log --oneline -3`、`git diff HEAD~2..HEAD --stat` 复核两个 commit。
2. 在真实 WSL 环境复跑：
   - `npm run typecheck`
   - `npx vitest run`
   - `$HOME/.bun/bin/bun test tests/tui/`
3. 若 TUI 7 失败仍与 main 一致，按本次记录判定为 master 既存，不在本任务改。如需清理，应开独立 ticket 调查 `TUI pending NL > overflow`（中位 1.9s，非 9s 超时，可能是独立 bug）。
4. PR body 草稿（用户原指令未要求 push；如要 PR，可参照 commit 文 + 本 handoff §commit 1/2）：
   - Summary: 根因（cli.ts 手工解构丢 name 的调用链：src/cli.ts:316-321 内联 wrapper → `worktreeProvisioner.provision({ conversationId, root })` 静默丢 name）+ 修复方式（factory 透传）+ 测试证据（红→绿：vitest 5888/5888、tests/cli/worktree-host.test.ts 红→绿、4 个陈旧测试由红→绿）。
   - Test plan: `npm run typecheck`、`npx vitest run`、`$HOME/.bun/bin/bun test tests/cli/worktree-host.test.ts`、`$HOME/.bun/bin/bun test tests/tui/deps-tools.test.ts`、`$HOME/.bun/bin/bun test tests/tui/deps-isolation.test.ts`、`$HOME/.bun/bin/bun test tests/harness/aci/tools/{get-record,list-sessions,query-trace}.test.ts`。

## Suggested skills

- `verification-before-completion` — 下次重新跑前对照本文件"已验证状态"段。
- `code-review` — 若开 PR，pin diff ref (HEAD~2..HEAD) 后重跑 Standards + Spec 两轴；本轮已做，结果见本文件 §Code review 收尾。
- `defensive-contract-validator` — 评估 factory 透传契约的 boundary coverage（empty / negative / overflow / concurrent / exception）；本轮 worktree-host.test.ts 已覆盖 happy + 无名降级两条轴。

## 脱敏

- 未记录 API key、token、password 或 credential 值。
- 测试 fixture 中的 `conversationId` ("conv-cli-a" / "conv-cli-b" / "conv-1") 与 label ("fix-648") 都是测试占位，不含敏感信息。
- 测试 `makeGitRepo()` 用 `user.email=t@t` / `user.name=t` 占位，无真实身份。
