# Plan: optional worktree isolation on mutate

**Goal:** 全局开关打开后，会话可只读主仓；一旦要改文件则拦住、建 task worktree，并把**当前会话**绑到该 worktree，避免多会话共写同一目录。
**Approach:** 先落开关与合同（默认 OFF），再做 mutate 门禁 + `git worktree add` + 会话根改绑；已在本会话 task worktree 内则放行。GitHub/`gh` 鉴权与「提交→推 PR」产品闭环另轨，本计划不阻塞、也不假装已具备。本文件不跟踪 GitHub issue。
**Spec link:** none yet — 合同来自操作员对齐（2026-08-29）；可建造 spec 后续补。
**Tracker:** 本计划不创建、不嵌入 issue 边表；由外部将本文件链到讨论 issue。
**ACR:** PASS（2026-08-29，verdict block 见下文「ACR」节；计划经修订补齐边界与错误路径后全 yes）。
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
6. 主仓不是 git 仓库 / git 不可用时：门禁 **fail-closed** —— mutate 被拦下并给出可见错误，不静默放行写主仓（与 T1 fail-closed 语义同一来源）。
7. 同会话并发首次 mutate（多条写路径在建树完成前同时到达）：建树**幂等** —— 只产生一个 worktree / 一个 task 分支，不重复建树、不双写主仓。
8. 目标 task worktree / task 分支名已存在：按 T1 合同声明的确定性策略处理（复用该树，或报可见错误），不静默覆盖、不 checkout 其它会话的 HEAD（与硬要求 3 衔接）。
9. settings 开关只在**启动加载点**读取一次（config 层只承载 boolean 值域语义，不读 git、不持会话状态）；会话根改绑后**不隐式重载** project settings——如需重载语义，必须在 T1 合同中显式写明，不允许静默切换 settings 来源。

**明确非本计划**

- 完整 commit → push → PR 产品向导（可另开）
- 云端多 VM 编排、自动合主 PR
- 把 product `workspace` 多根与 git worktree 混成同一开关

## ACR

ACR pre-implementation review 完成于 2026-08-29（计划经上表修订——补硬要求 6–9 与 T3 typed 错误/边界验收——后全 yes）。

```
bounded-context-guardian: yes — config 只承载开关值域（不读 git、不持会话状态）；mutate 门禁留在 harness permission，会话根改绑留在 session-api host 缝，展示走 TUI env pane 既有投影；各层不越界，settings 源语义由硬要求 9 钉死。
defensive-contract-validator: yes — 开关缺失/非 true/非法 → OFF（fail-closed 至今日行为）；非 git 仓库、建树失败、分支/worktree 已存在、并发首次 mutate 四类边界均已补入硬要求 6–8 与 T3 验收，全部不静默放行写主仓。
error-handling-enforcer: yes — 建树/改绑失败要求 typed、非空、可见错误出口（对齐 harness fault-class / session-api WorkspaceRootError 惯例），「主仓零写入」是 T3 验收项而非隐含假设。
complexity-anti-drift: yes — 声明结构是单层流水线（gate → create → rebind，已绑树则 passthrough 短路，T5 只读投影），每 bullet 单一抽象层级、无深嵌套意图，未引入新抽象层。
minimal-change-verifier: yes — 单一逻辑任务（可选 mutate 隔离）按依赖拆 T1–T5 各单 commit；PR 向导 / 云编排 / workspace 多根显式列为非目标，无 scope creep。
OVERALL: yes — 全 5 项 verdict 通过，可进入 T1 实施；后续 bullet 仍受 per-ticket loop 约束。
```

## Tasks (ordered by dependency)

1. **Record isolation contract (settings + ADR/CONTEXT)** — tag: `[decision]`
   - **Inherits:** 上文「合同流程」与硬要求 1–5；开关默认 OFF；建树必绑会话
   - **Surface:** `docs/adr/` + `docs/CONTEXT.md`（及 settings 契约叙述）
   - **Acceptance:** ADR/CONTEXT 写明开关语义、与 ADR-0023/`workspaceRoot` 边界、失败时 fail-closed（不静默写主仓）；本 bullet 可不含运行时代码
   - Status: [x] done

2. **Ship default-OFF setting surface** — tag: `[implementation]`
   - **Inherits:** T1；缺失或非 true → 隔离门禁不启用
   - **Surface:** `src/config`（settings 加载）
   - **Acceptance:** 默认关闭时全套 mutate 路径与今日一致；设为开启后可被运行时读到（门禁可仍为后续 bullet）
   - Status: [x] done
   - [blocks: T1]

3. **Mutate gate: block → worktree → rebind session** — tag: `[implementation]`
   - **Inherits:** 合同流程；创建必须改绑；只影响本会话；硬要求 6–9（fail-closed / 幂等建树 / 分支冲突策略 / 开关单次读取）
   - **Surface:** harness ACI / permission 与 session-api（或持有会话根的 host 缝）
   - **Acceptance:** 开关 ON 且会话尚在主仓时，第一次 mutate 不落盘到主仓；成功后该会话后续 mutate 落在新 worktree；失败则错误可见且主仓未被改写。失败出口必须 **typed、非空、可见**（对齐 `harness/errors.ts` fault-class 与 session-api `WorkspaceRootError` 的类型化错误惯例，不返回空值、不静默吞）；边界类至少覆盖：非 git 仓库、`git worktree add` 失败、task 分支/worktree 已存在、同会话并发首次 mutate——四类均 fail-closed 且有测试钉死。
   - Status: [x] done（2026-08-29 T3 完成；开工前曾发现本项被误标 done——当时仅 T2 落地，已先改回 pending 再实施）
   - [blocks: T2]

4. **Passthrough when already on session task worktree** — tag: `[implementation]`
   - **Inherits:** 「已绑定则放行」；不建第二棵树
   - **Surface:** 与 T3 同一隔离缝
   - **Acceptance:** 会话根已是本会话 task worktree 时，mutate 直接成功且不新增 worktree
   - Status: [x] done（2026-08-29 T4 完成。passthrough 锚定落在 provisioner：
     deterministic naming `<repo>/.iknow/worktrees/<conversationId>` 即所有权锚，
     本会话自己的树 → 同根 no-op 放行（零 git 调用、零改绑写、重启后仍成立）；
     别会话的 task tree / 无关 linked worktree → typed `foreign_worktree`
     fail-closed（ADR-0037 未裁决面，按 §6 同源 fail-closed 取舍）。hub /
     build-engine 不再传 conversation-agnostic 的 `initiallyBound`（per-root
     引擎可服务多会话，引擎级 bound 标记会误放行别会话的 mutate）；harness
     gate 的 `initiallyBound` opt 保留给单会话 embedding。）
   - [blocks: T3]

5. **Operator-visible isolation state** — tag: `[implementation]`
   - **Inherits:** 人要能看出「当前绑在哪棵树上」
   - **Surface:** TUI 环境现势（chat chrome 的 envPaneRows 槽位：`worktreeIsolationLines` 只读投影会话文件的 `workspaceRoot`，改绑后显示绑定根；未绑定 → 0 行）
   - **Acceptance:** 改绑后操作员无需猜路径即可看到当前会话工作根（或等价明确提示）
   - Status: [x] done（2026-08-29 T5 完成；TUI 侧经 session-state 的 `workspaceRoot` 只读透传直接拿到会话根，session-api / config 零改动）
   - [blocks: T3]

## Code review phase (end of round)

全部 implementation bullet 落地后：一轮 `code-review`（Standards + Spec）→ `verification-before-completion`，再合入。

## Review remediation (2026-08-29)

一轮 blocking review 产出 2 High + 2 Medium，全部修复（1 commit「remediate review findings」），TDD：每项先补失败测试再修。不触碰 spec/ADR 合同（硬要求 1–9 原样）。

- **High-1 — TUI / CLI chat 入口未接 isolation 门禁**（`src/tui/deps.ts`、`src/tui/hub-bridge.ts`、`src/cli.ts` 经 `cli/runtime.ts` 另一套 buildHarnessEngine；且 hub-bridge 的 injectedDeps 分支短路 ensureDeps，mutate 零拦截直写主仓）
  修复：TUI（`buildTuiDeps`）与 CLI chat 入口接同一 host 缝 —— `worktreeIsolation.provision`（session-api `worktree-rebind` SSOT provisioner）+ 启动 settings 透传进 buildHarnessEngine；hub 新增 `injectedEngineRoot` opt，`ensureDeps` 在会话根离开注入引擎根（rebind）时落到 per-root 引擎重建（TUI 经 hub-bridge 新转发的 `buildEngine` 缝 = 同一 depsOpts 重跑 `buildTuiDeps`；chat 经 `chat-session` 新增的 `rebuildDeps`/`engineRoot` 缝重跑 `buildHarnessEngine`），与 hub.ts 两条生产装配路径行为一致；rebind 后 passthrough 仍由 provision 按会话锚定。失败路径（chat 重建失败）可见降级、保持旧 deps、mutate 仍 fail-closed。
  测试：`tests/tui/deps-isolation.test.ts`（ON 拦截 + OFF 零变化）、`tests/tui/hub-bridge.test.ts`（engineRoot/buildEngine 转发）、`tests/session-api/hub-worktree-isolation.test.ts`（injected deps rebuild at rebound root）、`tests/cli/chat-session-rebind.test.ts`（重建 / 不重建 / 失败可见降级）。
- **High-2 — rebind 后隐式重载 project settings（硬要求 9 违反）**：rebind 后 worktree 根构建的新引擎走 `loadIknowSettings({cwd: worktreeRoot})`，`.iknow/` 被 gitignore → project settings 静默失效。
  修复：settings 只在启动加载点装配一次 —— serve.ts 收敛单次 `loadIknowSettings()` 并经 hub 新增 `settings` opt 注入；hub 的两条引擎构建路径（`buildProductionEngine` / fallback）与 TUI（run.tsx → depsOpts.settings）、CLI chat（chatEngineOpts.settings + rebuildDeps 复用）全部复用启动装配的同一 `IknowSettings` 对象。
  测试：`hub-worktree-isolation.test.ts`「startup settings pinned across rebind」（磁盘 OFF + 注入对象 ON → 门禁在主根与重建后的 worktree 根引擎上均保持 armed）。
- **Medium-1 — conversationId 未校验即拼路径/分支名**（`worktree-rebind.ts`；store 层无现成 id 形状契约，id 原样 join 进文件路径与分支名）。
  修复：provision 入口校验 `^[A-Za-z0-9][A-Za-z0-9_-]*$`（首字符字母数字，拒绝 `..` / 路径分隔 / 前导 `-` / 空白 / shell 元字符），不匹配 → typed `rebind_failed`，零 git 调用、零 store 写。
  测试：`worktree-rebind.test.ts` 9 类非法 id + 合法 id 放行。
- **Medium-2 — T5 投影把任意非空 workspaceRoot 显示成 worktree**（serve `bindWorkspace` 在 createSession 时就写 workspaceRoot=主根，误导）。
  修复：`worktree-rebind.ts` 导出 `taskWorktreeOwnerOf` 路径判定（T4 所有权锚同源 SSOT），`environment-pane.worktreeIsolationLines` 显示条件锚定「root 命中 `<x>/.iknow/worktrees/<conversationId>` 命名」；主根 / serve 绑定根 / 任意目录 → 0 行。TUI 仍只读投影、零 git 操作。
  测试：`environment-pane.test.tsx` 主根 / `.iknow` 非叶 / worktrees 目录本身 → 0 行；task worktree 路径 → 1 行。

验证：`npx tsc --noEmit` 干净；`tests/harness`（2722）、`tests/session-api`（736）、`tests/cli`（355）全绿；`bun test tests/tui/` 1114 pass，唯一 fail 为 pre-existing（hub-bridge subagent drain，master 同挂，stash 验证非本轮引入）。

收敛修复（2026-08-29 第二轮 review，1 commit「fix(cli): rewire rebuilt engine handles on worktree rebind」）：两轴复检共指 chat rebind 重建后引擎句柄被丢弃（`rebuildDeps` 只回 deps）。修复：`rebuildDeps` 缝改为返回完整句柄 bundle（`RebuiltChatEngine`，对齐 TUI `buildEngine` 缝 / hub per-root 形状），`refreshChatDepsForRebind` 切换点**旧引擎先收口**再把重建引擎 shutdown 写入 `engineShutdown.current`（cli.ts `registerShutdown` 闭包读 current，信号路径始终收口活跃引擎，SC11/SC16），并 rewire ctx 的 `subagentManager` / `graphAssembly` / `autoMemory` / `overlayMemoryPrefetch`（drain 消费新 manager，/graph 快照随活跃装配，split-brain 消除）。顺手 Low：`refreshChatDepsForRebind` 的 catch 收窄为仅 typed `not_found` 静默，其余（io_error 等）走 `writeErr` 可见降级；slash 行跳过 rebind 检测（省每行 store.load IO）。TUI `/quit` 路径 `shutdownExtensions` 追加 `hubRef.current?.shutdown()`（hub.shutdown 幂等，补齐重建引擎收口）。
  测试：`tests/cli/chat-session-rebind.test.ts`（句柄换血 + drain 新 manager + io_error 可见降级 + slash 跳过 + cli.ts 装配钉）、`tests/tui/quit-shutdown.test.ts`（/quit hub.shutdown 接线钉）。验证：typecheck 干净；`vitest run tests/harness tests/session-api tests/cli` 3799 全绿；`bun test tests/tui/` 1116 pass，唯一 fail 仍为 pre-existing（hub-bridge subagent drain）。
