# 0037. 可选 worktree 隔离门禁：拦写 → 模型调 ACI 工具建树改绑 → 模型自己再写（默认 OFF）

Date: 2026-08-29

Status: accepted (amended 2026-08-30: 建树职责由 host 自动建树改为模型调用「创建工作树 ACI 工具」)

> **Amendment 2026-08-30**（issue #836 / 地图 #829）：ON 时门禁**只拦写、不自动 `git worktree add`**——建 task worktree 与会话根改绑由**模型调用「创建工作树 ACI 工具」**完成（成功 = 树在且会话根已切到该路径）；Host 不同波重放被拦的写，被拦的写由模型在新根上自己再调。原文 Decision 1 中「首次 mutate 被拦截 → host `git worktree add` 建树改绑」的读法 **superseded**。同批修订：说明书（rules）改为按需读——父会话不整段灌 rules、缺目录视为空，见 ADR-0009 D2 的 amended 说明与 `docs/CONTEXT.md` 术语「说明书读法」。

## Context

ADR-0023 裁决 4 曾锁定「v1 = 单根 + recents + 三锚合一；worktree/多根只读推迟」。当时推迟的对象是 **product workspace 多根**（serve 主根的多个绑定），而不是多会话共写同一目录的物理隔离问题。操作员后来提出的诉求是另一件事：多个会话（或会话与人在同一检出目录）并行改动会互相踩踏——解法是 git worktree，不是给 serve 再开几个主根。本 ADR 因此 **reopen ADR-0023 推迟面中一个窄例外**：会话级 git worktree 隔离，由全局开关控制、默认关闭；ADR-0023 的 serve 单根 + recents + 三锚合一语义原样保留，不被本 ADR 覆盖或静默修改。

边界先钉死：**git worktree ≠ product workspace 多根**。worktree 是 git 层的物理检出，服务「隔离写冲突」这一个目的；`workspace` / `workspaceRoot`（ADR-0019 / ADR-0023）是产品层的主根与 per-root 状态锚语义，本 ADR 不移动它们。

## Decision

新增全局开关 `settings.isolation.worktreeOnMutate`（boolean-only，**默认 OFF**；缺失或非 `true` 一律按 OFF，与 `settings.memory.autoExtract` 同款 fail-closed 值域纪律）。精确的字段接线与类型落点由实施 bullet 落在 `src/config`，本 ADR 锁的是语义合同。

### 1. 开关两态（硬要求 1）

- **OFF（默认）**：会话行为与今日完全一致——读、写、permission、目录全部现状，不新增任何拦截点。
- **ON**：会话可**只读**主仓（read / grep / glob / 只读 bash 等读路径放行，可留在主仓；项目相对读路径不改写到主仓绝对路径）。一旦出现**写路径**（write_file / edit_file / 会改工作区的 bash 等 mutate），门禁把该写**拦住**——host **不自动** `git worktree add`，而是由**模型调用「创建工作树 ACI 工具」**完成建 task worktree（含 task 分支）与**当前会话**根锚改绑；工具成功 = 树已在且会话根已切到该路径，此后本会话 mutate 只进该根。工具成功后 Host 只保证路径已切：**不同波重放**被拦的写、不偷偷代执行，被拦的写由模型在下一回合于新根上**自己再调**；也不要求操作员 `/continue`。已绑定本会话 task worktree 时写路径直接放行，不建第二棵树。

### 2. 改绑只影响本会话（硬要求 2–5）

创建 worktree 必须改绑本会话——只建树不绑定 = 不合格。改绑不 checkout 其它会话 / 其它 worktree 的 HEAD；在 task worktree 内 push / 开 PR 不得拖动主仓或其它 worktree 的当前分支。主仓并行共写不是目标形态：本功能是**可选隔离**，不是替操作员猜「是否开任务」。子代理 spawn 自父会话，跟随父会话改绑后的同一棵树，不触发第二棵树（装配面由实施 bullet 落实）。

### 3. task worktree / task 分支名已存在时的确定性策略（硬要求 8）

按 fail-closed 处理：创建工作树 ACI 工具向模型返回**可见 typed 错误，不静默覆盖、不复用归属不明的树、不 checkout 其它会话的 HEAD**。同会话内的并发首次 mutate（硬要求 7）不在此列——建树幂等，多条写路径在建树完成前同时到达也只产生一个 worktree / 一个 task 分支，不双写主仓。

### 4. `workspaceRoot` 边界（与 ADR-0019 / ADR-0023 的关系）

`workspaceRoot`（ADR-0019 D1.1，per-root 状态锚，默认 `process.cwd()`）与 serve 主根（ADR-0023，显式选定 + unbound 语义）的规则都不变。改绑动作 = 把**本会话生效**的根锚（cwd / workspaceRoot 取值）切到 task worktree 路径，遵循既有锚的解析与校验规则（含 `WorkspaceRootError` 惯例）；它不是 serve 主根重绑，不触碰 recents / trust，也不是把 git worktree 提升为 product workspace 多根。主仓的物理路径不切——主仓检出保持只读原位，被切的只有本会话生效根。

### 5. 配置读取合同（硬要求 9）

开关只在**启动加载点**读取一次；config 层只承载 boolean 值域语义——**不读 git、不持会话状态**。会话根改绑**不隐式重载** project settings：settings 来源在会话生命周期内保持启动时的装配结果；如未来需要「改绑后重载 settings」语义，必须显式另立决定，不允许静默切换 settings 来源。

### 6. 失败语义 fail-closed（硬要求 6）

主仓不是 git 仓库 / git 不可用 / 创建工作树 ACI 工具失败（`git worktree add` 或改绑失败）：mutate 一律被拦下并给出**typed、非空、可见**的错误（对齐 harness fault-class 与 session-api `WorkspaceRootError` 的类型化错误惯例），**不静默放行写主仓**——建树/绑定失败后的主仓零写入是验收项，不是隐含假设。开关本身缺失或非法回落 OFF，即回落至今日行为，同一 fail-closed 来源。

## Consequences

### Positive

- 多会话并行不再互踩：ON 时首个 mutate 后会话获得物理隔离的写目录，主仓保持只读。
- 默认 OFF 保证零回归路径；操作员显式 opt-in 才改变行为。
- git worktree ≠ workspace 多根的边界写死，避免把本开关与 serve 主根 / `workspaceRoot` 语义搅在一起。

### Negative / Trade-offs

- ON 时首次 mutate 引入建树成本与会话根切换，操作员需要能看出当前绑在哪棵树上（展示面由实施 bullet 落实）。
- 同名 task worktree / 分支已存在时 fail-closed 报错——残留的孤儿树需要人工清理后才可继续同名任务。
- 「提交 → push → PR」的产品向导与 GitHub / `gh` 鉴权不在本 ADR 范围，另轨处理。

### Reversibility

- 开关 OFF 即完整还原今日行为；已建的 task worktree 是独立目录，删除即回收，不影响主仓与其它 worktree。

## Evidence

- `plans/worktree-isolation-on-mutate.md` ACR 5/5 PASS（2026-08-29；bounded-context-guardian / defensive-contract-validator / error-handling-enforcer / complexity-anti-drift / minimal-change-verifier 全 yes）。
- `plans/worktree-isolation-model-provision.md` ACR 5/5 PASS（2026-08-30）——amendment 来源（issue #836，地图 #829）。
- 实施证据由后续 bullets（settings 面 → mutate 门禁 + 改绑 → passthrough → 操作员可见状态）各单 commit 提供，本 ADR 为 decision record，不含运行时代码。
