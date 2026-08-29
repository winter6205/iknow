# Plan: optional worktree isolation on mutate

**Goal:** 全局开关打开后，会话可只读主仓；一旦要改文件则拦住、建 task worktree，并把**当前会话**绑到该 worktree，避免多会话共写同一目录。
**Approach:** 先落开关与合同（默认 OFF），再做 mutate 门禁 + `git worktree add` + 会话根改绑；已在本会话 task worktree 内则放行。GitHub/`gh` 鉴权与「提交→推 PR」产品闭环另轨，本计划不阻塞、也不假装已具备。本文件不跟踪 GitHub issue。
**Spec link:** none yet — 合同来自操作员对齐（2026-08-29）；可建造 spec 后续补。
**Tracker:** 本计划不创建、不嵌入 issue 边表；由外部将本文件链到讨论 issue。
**ACR:** N/A — 本提交仅为计划工件；**实施前**须跑 `architecture-change-reviewer` 得 all-yes（或 N/A-with-reason）后再动代码。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

> Contradicts ADR-0023（v1「worktree/多根只读推迟」）— worth reopening because 操作员要可选的 mutate 门禁 + 会话绑 worktree；由 T1 记录 reopen / 例外面，不在本计划静默覆盖。

## 待写入（由 T1 落盘，本计划提交不刷 CONTEXT/ADR）

- 重开或例外说明 ADR-0023 与 worktree 隔离开关的关系
- 候选术语：worktree isolation mode（开关）；session worktree rebind（建树后绑定会话根）
- 与 `workspace` / `workspaceRoot`（ADR-0019/0023）边界：git worktree ≠ product workspace 多根

## 合同流程（开关 ON）

```text
读路径（read / grep / glob / 只读 bash…）
  → 放行（可留在主仓 / 当前根）

写路径（write_file / edit_file / 会改工作区的 bash…）
  → 已绑定本会话 task worktree？ → 放行
  → 否则拦住落盘
       → git worktree add（+ task 分支）
       → 把【当前会话】workspace/cwd 改绑到该 worktree
       → 此后本会话 mutate 只进该根
```

**硬要求**

1. 开关默认 **OFF**；OFF 时行为与今日一致。
2. **创建 worktree 必须改绑本会话**；只建树不绑定 = 不合格。
3. 改绑只影响**本会话**；不得去 checkout 其它会话 / 其它 worktree 的 HEAD。
4. 在 task worktree 内 push / 开 PR **不得**拖动主仓或其它 worktree 的当前分支。
5. 主仓并行共写不是目标形态；本功能是可选隔离，不是猜「是否开任务」。

**明确非本计划**

- 完整 commit → push → PR 产品向导（可另开）
- 云端多 VM 编排、自动合主 PR
- 把 product `workspace` 多根与 git worktree 混成同一开关

## ACR（实施前补全）

```
bounded-context-guardian: (pending ACR)
defensive-contract-validator: (pending ACR)
error-handling-enforcer: (pending ACR)
complexity-anti-drift: (pending ACR)
minimal-change-verifier: (pending ACR)
OVERALL: N/A — plan-only; block code until ACR PASS
```

## Tasks (ordered by dependency)

1. **Record isolation contract (settings + ADR/CONTEXT)** — tag: `[decision]`
   - **Inherits:** 上文「合同流程」与硬要求 1–5；开关默认 OFF；建树必绑会话
   - **Surface:** `docs/adr/` + `docs/CONTEXT.md`（及 settings 契约叙述）
   - **Acceptance:** ADR/CONTEXT 写明开关语义、与 ADR-0023/`workspaceRoot` 边界、失败时 fail-closed（不静默写主仓）；本 bullet 可不含运行时代码
   - Status: [ ] pending

2. **Ship default-OFF setting surface** — tag: `[implementation]`
   - **Inherits:** T1；缺失或非 true → 隔离门禁不启用
   - **Surface:** `src/config`（settings 加载）
   - **Acceptance:** 默认关闭时全套 mutate 路径与今日一致；设为开启后可被运行时读到（门禁可仍为后续 bullet）
   - Status: [ ] pending
   - [blocks: T1]

3. **Mutate gate: block → worktree → rebind session** — tag: `[implementation]`
   - **Inherits:** 合同流程；创建必须改绑；只影响本会话
   - **Surface:** harness ACI / permission 与 session-api（或持有会话根的 host 缝）
   - **Acceptance:** 开关 ON 且会话尚在主仓时，第一次 mutate 不落盘到主仓；成功后该会话后续 mutate 落在新 worktree；失败则错误可见且主仓未被改写
   - Status: [ ] pending
   - [blocks: T2]

4. **Passthrough when already on session task worktree** — tag: `[implementation]`
   - **Inherits:** 「已绑定则放行」；不建第二棵树
   - **Surface:** 与 T3 同一隔离缝
   - **Acceptance:** 会话根已是本会话 task worktree 时，mutate 直接成功且不新增 worktree
   - Status: [ ] pending
   - [blocks: T3]

5. **Operator-visible isolation state** — tag: `[implementation]`
   - **Inherits:** 人要能看出「当前绑在哪棵树上」
   - **Surface:** TUI 环境现势 和/或 chat/serve 等价提示（选一处可演示即可）
   - **Acceptance:** 改绑后操作员无需猜路径即可看到当前会话工作根（或等价明确提示）
   - Status: [ ] pending
   - [blocks: T3]

## Code review phase (end of round)

全部 implementation bullet 落地后：一轮 `code-review`（Standards + Spec）→ `verification-before-completion`，再合入。
