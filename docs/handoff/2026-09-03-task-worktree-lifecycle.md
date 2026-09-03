# Session Handoff — task worktree lifecycle (2026-09-03)

## 当前 live 状态

- **任务**: 按 `plans/task-worktree-lifecycle.md` 完成 task worktree 的命名、创建、发现、进入、回收、include 拷贝，以及改绑后的身份根只读访问。
- **Worktree**: `/home/winner/projects/iknow/.claude/worktrees/task-worktree-lifecycle`
- **分支**: `worktree-task-worktree-lifecycle`
- **为什么重要**: 隔离开启后首个写入必须由模型建树并落入 task worktree；主仓保持只读，项目身份文件仍可读，回收过程可审计。
- **operator 指令**: 按 plan 实施，完成后 commit、push 并创建 PR。

## 已固化工件（引用）

| 类型     | 路径 / URL                                       |
| -------- | ------------------------------------------------ |
| 领域词汇 | `docs/CONTEXT.md`                                |
| 决策记录 | `docs/adr/0037-worktree-isolation-on-mutate.md`  |
| 计划     | `plans/task-worktree-lifecycle.md`               |
| spec     | `specs/task-worktree-lifecycle.md`               |
| issue    | `https://github.com/winter6205/iknow/issues/869` |

## 当前变更

全部仍未 commit、push 或创建 PR。当前 worktree 中已有实现与补充：

- `src/harness/isolation/worktree-gate.ts`：label slug、路径/分支/owner SSOT、list/remove 类型、Git spawn 异常 typed error。
- `src/session-api/worktree-rebind.ts`：label provision、并发 coalesce、worktreeinclude、按 label enter、list/remove 安全检查、stale branch 与 unpublished commit 判定。
- `src/harness/aci/tools/{create,list,remove,enter,exit}-task-worktree.ts`：ACI 工具面；list 为 `read-only`，remove 为 `write`，但二者不进入 workspace mutate/root-flip 分类。
- `src/harness/aci/tools/registry.ts`、`src/harness/build-engine.ts`、`src/session-api/hub.ts`：44 件 append-only 工具名单、独立 host seam、ON/OFF 与 live taskRoot 接线。
- `src/harness/aci/tools/read-file.ts`、`grep.ts`、`glob.ts`：ON + live task worktree 时的 projectIdentityRoot 只读通道；主仓/OFF 不获得额外根，write_file 仍 task-root-scoped。
- `scripts/task-worktree-gc.ts` + `package.json`：operator-only `worktree:gc`，默认 report-only，只有 `--apply` 删除无活且安全的 `iknow/task*` 分支。
- `docs/adr/0037-worktree-isolation-on-mutate.md`：2026-09-03 accepted amendment；`docs/CONTEXT.md`、`specs/README.md`、plan/spec 任务文档已更新。
- 测试已扩展：`tests/session-api/worktree-rebind.test.ts`、`tests/harness/isolation/worktree-gate.test.ts`、ACI lifecycle/identity tests、registry/D9/bash/graph downstream count tests、`tests/scripts/task-worktree-gc.test.ts`。

## 已验证状态

```text
bun x tsc -p tsconfig.json --noEmit
=> 最近一次 exit 0（动态 identity-root 接线之后）

bun x vitest run tests/session-api/worktree-rebind.test.ts tests/harness/isolation/worktree-gate.test.ts tests/harness/aci/tools/worktree-lifecycle.test.ts tests/harness/aci/tools/worktree-identity-read.test.ts tests/scripts/task-worktree-gc.test.ts
=> 最近一次专项运行 exit 0；rebind 29、gate 31、ACI identity/lifecycle、GC 均通过

bun x vitest run tests/harness/aci/tools/registry.test.ts tests/harness/aci/tools/d9-description-guard.test.ts tests/harness/aci/bash-output-stop.test.ts tests/harness/graph/run-graph-assembly.test.ts tests/harness/aci/tools/worktree-identity-read.test.ts
=> 最近一次 exit 0；registry/D9/44-tool append-only/identity downstream 均通过

bun x prettier --check <本任务涉及的文件>
=> 最近一次 exit 0
```

完整 `bun x vitest run` 在本次 Windows→WSL 代理环境中还出现了既有环境问题，不能当作本任务全绿证据：`hub-worktree-isolation.test.ts` 多条在装配前缺少 `settings.llm.apiKey`，`aci/lsp.test.ts` 与 worker/rules、memory-gc、interrupt-routing 等另有环境/基线失败。下一会话应先在真实 WSL 环境重跑目标 suite，确认哪些仍可复现；不要把这些失败静默归因给本任务。

## Open blockers + next steps

**[NEXT] 下一会话请直接进入 `/home/winner/projects/iknow/.claude/worktrees/task-worktree-lifecycle`，先审阅未提交 diff，再验证、commit、push、PR。**

1. `git status --short --branch`、`git diff --check`、`git diff --stat`，并逐一审阅未跟踪的 plan/spec、两个 ACI 工具、GC script/test、handoff。
2. 在真实 WSL 环境重跑：
   - `bun x tsc -p tsconfig.json --noEmit`
   - lifecycle/rebind/gate/identity/registry/D9/graph/GC 目标 tests
   - `bun x vitest run tests/session-api/hub-worktree-isolation.test.ts`
   - `bun x prettier --check` 与仓库可用的 lint/format 命令。
3. 若 hub suite 仍因 test settings source 缺少 key 失败，先修正测试装配环境或记录确切环境 blocker；不要跳过 ON/OFF、worker surface、same-run identity-read 验收。
4. 复核实现边界：Git porcelain 与 NUL 文件名解析、label ambiguity、dirty/unpublished/current-root/foreign fail-closed、默认不删分支、include 仅拷匹配且 gitignored 文件、GC report-only，以及 OFF/worker 不出现 list/remove。
5. 对照 `specs/task-worktree-lifecycle.md` 的 9 条 Success Criteria 做 verification-before-completion；确认 `git diff` 不含 secrets。然后按用户原指令：
   - `git add` 所有本任务文件；
   - 提交一个清晰 commit；
   - `git push -u origin worktree-task-worktree-lifecycle`；
   - 用 `gh pr create` 创建 PR（正文引用 issue `#869`，写 Summary/Test plan），最后回传 PR 链接。

## Suggested skills

- `session-handoff` — 下一会话读取本文件并从 `[NEXT]` 接续。
- `defensive-contract-validator` — 覆盖 Git 异常、并发和 fail-closed 边界。
- `verification-before-completion` — commit/PR 前逐条对照 plan/spec。
- `code-review` — commit 前固定 diff ref 后做 Standards/Spec review；若当前环境无 Agent 入口，至少记录无法派发并保留本地审阅证据。

## 脱敏

- 未记录 API key、token、password 或 credential 值。
