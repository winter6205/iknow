# 活 taskRoot：让 worktree rebind 在 run 内生效

**Goal:** worktree isolation ON 时，模型调 `create-task-worktree` 成功后，**同一个 run 内**的后续 mutate 就落在新 task worktree 上——不再被同一句「尚未绑定」拦死到用户放弃，且全程不破 fail-closed。

**Approach:** 病因是「会话生效根在 engine 装配期被闭包捕获，而 rebind 只在 run 边界重解析」。既有 `src/harness/session-roots.ts` 已把 `taskRoot` 指定为「写与工具 cwd 只问它」的活根，只是实现冻结成了 `readonly string`——所以这不是新造抽象，而是把既有 SSOT 的 `taskRoot` 槽位做活并接上它已声明的消费者。按 **expand → migrate in batches → contract** 推进：先立活根与唯一 writer（零行为变化），再逐批迁移写/读/bash 围栏/LSP/子代理/展示面消费者，**最后**才翻门禁——顺序反了会出现「门禁放行但工具仍写旧根」的隔离破口（D11）。范围外：孤儿树清理、serve 多根、rebind 后重载 settings。

**Spec link:** `docs/adr/0037-worktree-isolation-on-mutate.md`（盘上为修订前 auto-provision 版，T2 负责改写）；被撤销的修订版原文 `git show 4b4fa6fe^:docs/adr/0037-worktree-isolation-on-mutate.md`；`plans/worktree-isolation-on-mutate.md`、`plans/worktree-mcp-rebind-lifecycle.md`；`docs/adr/0040-subagent-identity-and-dispatch-gate.md`（子代理根归属）。

**ACR:** **BLOCKED 5/5 no**（2026-09-02，`architecture-change-reviewer-agent`）。5 条 no 未被忽略——由 §5 的 D1–D11 钉死未定决策、由 §6 拆成 12 个单 commit bullet 来 discharge，逐条对应见 §4 表。实施方若在某个 bullet 内发现 D1–D11 与代码现实冲突，**停下重开 ACR**，不要就地放宽。

**Per-ticket loop (all bullets):** tdd → typecheck + 该 bullet Acceptance 点名的窄测试 → code-review → verification-before-completion → one commit on the ticket branch。

> **Tracker 路径：本地 markdown（fallback）。** 理由：操作员明确要求「写计划 + 给 worktree 与计划文件路径，去别的 session 实现」，未授权在共享仓库创建 GitHub issue（对外可见动作需显式授权）。需要 issue 化时，按下方 bullet 一对一建，blocking 边照 §依赖图。
>
> **每 bullet 循环（只说一次）：** 实施方按 `test-driven-development` 先写 red 测试 → 最小实现转 green → `npm run typecheck` + 该 bullet Acceptance 点名的窄测试 → `verification-before-completion` → **1 bullet = 1 commit**（Conventional Commits）。全部 bullet 落地后跑一次收尾 code review 阶段（见 §收尾）。
>
> **本计划的 headroom：** 每个 bullet 钉的是**切片形状与不变量**，不是补丁。文件名、类型名、helper 拆分、测试布局留给实施方——除已被既有代码冻结的名字（`taskRoot` / `SessionRoots` / `resolveSessionRoots` / `productRoot` / `projectIdentityRoot` / `installRoot`）。

---

## 1. 病因（已实测确认，不是假设）

**证据来源**：trace MCP 读 `conversation_id = d52e0f28-703c-439a-bce4-3a3ae1017139`，run `9b69b055`（2026-09-02 14:46:34–14:51:46，`status=error / cancelled`）。

| turn | 时间(UTC) | 工具 | 结果 |
| --- | --- | --- | --- |
| 0 | 14:46:34 | `create-task-worktree` | **ok**（4.26s，真建树） |
| 1 | 14:47:56 | `spawn_subagent` | **blocked** |
| 2 | 14:48:25 | `create-task-worktree` | ok（45ms，幂等） |
| 3 | 14:48:48 | `spawn_subagent` | **blocked** |
| 4 | 14:49:22 | `write_file` | **blocked** |
| 5 | 14:50:32 | `read_file` | not found |
| 7 | 14:51:26 | — | cancelled |

turn 0–7 的 `turn_index` 连续 ⇒ **同一个 run**。三条 blocked 的 message 逐字节相同，都是 `unboundMutateNotice()`。

**根因（一句话）**：会话生效根在 engine **装配期**被闭包捕获，而 rebind 只在 **run 边界**重解析——`create-task-worktree` 在 run 中途成功后，本 run 内后续每个 turn 仍跑在扎着主仓根的同一台 engine 上，于是所有 mutate 被同一句「尚未绑定」永久拦死；而门禁文案与工具成功文案都叫模型「下一 turn 重发」。

**支撑事实**（全部已核对）：

- 门禁 block 条件 = `taskWorktreeOwnerOf(root) === undefined`（`src/harness/isolation/worktree-gate.ts:525`），`root` 来自 `src/harness/build-engine.ts:881` 的 `root: sandboxRoot`，装配期固定。
- 重解析只发生在 run 边界：`src/cli/chat-session.ts:943`（每条 `processChatLine` 一次）、`src/session-api/hub.ts:2090`（每条 `postMessage`/`continueSession` 一次）。turn 之间无人重解析。
- **provision 本身没问题**：会话文件 `workspaceRoot` 已正确落盘为 `/home/winner/projects/iknow/.iknow/worktrees/d52e0f28-...`；worktree 目录全量建好；第二次 create 仅 45ms ⇒ 走 `src/session-api/worktree-rebind.ts:322` 幂等分支。
- turn 5 的 `read_file not_found`（`.rebind-check.txt`）**不是独立 bug**：全盘 `find` 无此文件，它是被拦 write 的后果。
- 三条 blocked 同源：`spawn_subagent` 不在 `classifyCall` 的 mutate 表里，是 `build-engine.ts:849` 的私有覆写追加的，最终都过同一个门禁。
- **实现违背 spec**：`git show 4b4fa6fe^:docs/adr/0037-worktree-isolation-on-mutate.md` 要求「被拦的写由模型在下一回合于新根上自己再调；**也不要求操作员 `/continue`**」。当前实现要求新用户消息 ⇒ 违 spec。
- **同一 bug 曾被修过又丢了**：`ba3ead79`（`WorktreeGateRebindMutator` / `setReboundRoot`）只活在 `tui-real-test-30min` 分支，`git merge-base --is-ancestor ba3ead79 HEAD` = false；master 反而把 same-turn mutator 写成「非目标」。

## 2. 附带查出的更严重缺陷：隔离 fail-**open**

原 bug 是 fail-closed（拦住不放行）。这一条是 **fail-open（绕过隔离直接写主仓）**，我已逐行亲自核实：

- 分类真值源是硬编码 2 名集合：`worktree-gate.ts:249` `ALWAYS_MUTATE_TOOLS = new Set(["write_file","edit_file"])`；`classifyCall`（`:258-271`）对其余一律返回 `"read"`；`build-engine.ts:849-872` 只追加 `spawn_subagent`。
- 5 个 symbol-mutate 工具（`rename_symbol` / `replace_symbol_body` / `insert_before_symbol` / `insert_after_symbol` / `safe_delete_symbol`）在 `src/harness/aci/tools/registry.ts:190-194` 注册，ACI 元数据是 `category: "write"`（`symbol-mutate.ts:125`），且**确实写盘**：`applyWorkspaceEdit` → `writeFile(filePath, next, "utf8")`（`symbol-mutate.ts:333`）。
- `symbol-mutate.ts` 全文 grep `resolveWithinRoot|isWithinRoot|sandboxRoot|workspaceRoot` = **0 匹配** ⇒ 写盘零路径 containment，唯一边界是 LSP NearestRoot 对 `ctx.directory`（`src/harness/lsp/server.ts:39-41`）的上界检查，而 `ctx.directory` 就是装配期那个根。
- `tests/harness/isolation/` 与 `tests/session-api/hub-worktree-isolation.test.ts` grep 这 5 个工具名 = **0 匹配** ⇒ 缺口零覆盖。

结论：隔离 ON 且会话仍在主仓时，这 5 个工具不经门禁、直接改主仓工作区。

## 3. 既有抽象：`session-roots.ts` 已经指定了活根，只是实现冻结了

`src/harness/session-roots.ts` 已是「唯一根策略点」，四角色分工写在 doc 里：

- `productRoot`（:12）首次装配钉死，跨 rebind 与重启不变；
- `projectIdentityRoot`（:16）宿主启动钉一次，跨 rebind 不变；
- **`taskRoot`（:21-23）「本会话 task worktree（create / enter 切过去，exit 切回主仓）。写与工具 cwd 只问它——写工具 / 会改工作区的 bash / git / LSP 目录 / 子代理工作目录。」**
- `installRoot`（:24）锚 `import.meta.url`。

`build-engine.ts:436` 的装配注释同样写着「`taskRoot` → 写与工具 cwd（= sandboxRoot，rebind 后是 task worktree）」。

但 `SessionRoots`（:43-48）四个字段全是 `readonly string`，`resolveSessionRoots()`（:131）是纯函数、装配期出一次快照。**即 `taskRoot` 的文档契约是活的，实现是冻结的。** 本计划因此不是新造抽象，而是**把既有 SSOT 的 `taskRoot` 槽位做成活的**，并把它已声明的消费者接上去。

补充实测：`session-roots.ts` 在 `src/` 被真实消费（`build-engine.ts:313,438,458,473,569,726,1128`，并经 `BuiltEngine.sessionRoots` 暴露），但 `tests/` 下 grep `resolveSessionRoots|session-roots` = **0 匹配** ⇒ 这个 SSOT 零测试覆盖。

## 4. ACR 前置门判定（2026-09-02，`architecture-change-reviewer-agent`）

```
bounded-context-guardian:     no — 活 cell 的唯一 writer 未定；gate 侧写与 hub 侧写各自越界
defensive-contract-validator: no — 未声明任何 test；concurrent 类承重（活 cell 可在同一 batch 内翻转）；fail-open 缺陷零覆盖
error-handling-enforcer:      no — 新增失败路径无 typed exit 声明（classify 与 execute 之间根已移动 / rebind 失败是否回滚 / category 缺失未知时 fail-closed）
complexity-anti-drift:        no — 一个变更混 4 个抽象层（状态机制 + 9 处 consumer 迁移 + bwrap argv 装配 + 类型命名/3 缝合并 + docs）
minimal-change-verifier:      no — 不是 1 logical task（fail-open 修复 / live taskRoot / 纯 refactor / docs 修订各自独立可验证）
OVERALL: BLOCKED — 5 dimension(s) failed
```

冲突排序（ACR conflict rule）：bounded-context 要求先定 writer 权属、minimal-change 要求拆 commit ⇒ **先拆，再按拆出的每份各 1 commit，不得合并**。

**5 条 no 如何被本计划 discharge：**

| ACR no | discharge 位置 |
| --- | --- |
| bounded-context（writer 未定 /  purity 契约互斥） | §5 **D1**（writer = 装配层对 host 缝的包装点；`resolveSessionRoots` 保持纯，活持有者是同模块另一个导出）+ **D3**（稳定根清单） |
| defensive-contract（无 test / concurrent / fail-open 零覆盖） | §5 **D2**（batch 快照，消掉 mid-batch 翻转这个 concurrent 类）+ 每 bullet 的 Acceptance 逐条点名测试与既有命令；fail-open 由 **T1** 独立覆盖 |
| error-handling（typed exit 缺失） | §5 **D1**（失败不写不回滚，typed error 原样冒泡）+ **D8**（元数据缺失/未知 fail-closed 判 mutate）+ **D5**（旧根 client 显式收口，不静默留） |
| complexity-anti-drift（混 4 层） | §6 拆成 12 个 bullet，每个只跨自己那层；类型命名/缝合并隔离到 **T11** 纯 refactor |
| minimal-change（非 1 logical task） | **T1**（安全）／**T2**（decision）／**T3–T10**（expand→migrate→contract）／**T11**（refactor）／**T12**（收尾）各自 1 commit、独立可回滚 |

## 5. 已钉死的决策（实施方 inherit，不得再开第二个答案）

**D1 — 活根归属与唯一 writer。**
活读取面归 `src/harness/session-roots.ts`（既有唯一根策略点，doc :21-23 已声明「写与工具 cwd 只问它」）。`resolveSessionRoots` **保持纯函数不动**——其 doc :27-31 的「不读 git、不碰文件系统、不持会话状态」只约束它自己；活持有者是同模块内**另一个**导出，包裹已校验的快照。
**唯一 writer = harness 装配层对 host `provision`/`enter`/`exit` 缝的包装点**（`build-engine.ts:881` 传 `isolationHost.provision` 处）。否决另两个候选：gate 侧写（`worktree-gate.ts:549`）会让门禁同时当裁决者与根权威，违 gate 自身 doc「holds no session state beyond the per-conversation adjudication latch」；hub 侧写会让 Hub 成第二份根权威，直接违 CONTEXT.md「Hub dirty root…不是第二份 workspaceRoot 权威」「Hub 只观察返回根」。
包装点**只在缝成功 resolve 时写**；失败不写、不回滚，typed error 原样冒泡，主仓零写入不变。Hub / CLI 仍只观察返回根做 dirty-root 持久化，语义逐字节不变。

**D2 — batch 快照语义（消掉 mid-batch 翻转）。**
一次 `executeAll` 调用（= 一波 tool calls）只在入口读**一次**活根，整波共用该快照。理由：`worktree-gate.ts:598+` 对 mixed/mutating batch 逐 call 放行，逐 call 读活根会让同一波一半写旧根一半写新根——把一次逻辑改动劈进两棵树，违 least astonishment。rebind 因此对**下一波**生效。

**D3 — 稳定根清单（严禁活化）。**
`productRoot` / `projectIdentityRoot` / `installRoot` / `mcpConfigRoot` / `stateAnchor`+`memoryDir` / `todoDir` / `traceDir` 全部保持装配期冻结。特别是 `stateAnchor`（`build-engine.ts:470-473`）：ADR-0037 §4 要求 per-root 状态**永不**落进 gitignored 的树，活 `taskRoot` 不得拖动它。

**D4 — bash 围栏 per-call 重建。**
`createFsPolicy` / `createBwrapFence` 从工厂期（`bash.ts:74-79`）移进 handler，按 D2 的波快照根重建。**argv 形状与顺序逐字节不变**（`.qoder/rules/security-boundaries.md`：「argv 顺序…改顺序会破 fence」）——只是用活根把同一个构造再跑一次，不新增、不重排、不删 flag；`--size`/`--tmpfs` 仍是独立 argv 项；不用 bwrap flag 表达 rlimit。前台与 `background:true` 必须读**同一个**波快照根（CONTEXT.md 沙箱纪律）。

**D5 — LSP 根翻转时的 client 处置。**
`LspCtx.directory` 活化后，client pool 已按 root 派生 key（`lsp/client.ts:128-131`），翻转自然产生新 key。旧根 client 必须**显式收口（stop）**——不得静默留着（泄漏 spawn 进程），也不得复用（会写旧根）。NearestRoot 上界（`lsp/server.ts:39-41`）随活根走。

**D6 — 子代理继承取根时机。**
按 ADR-0040「子代理是父会话的执行臂，继承父会话当前生效根」，继承判定与取值都在 **spawn 调用时**读活根，替换 `build-engine.ts:577-581` 的装配期一次判定。worker 进程自身装配（`subagent/worker.ts`）在 spawn 时定根后冻结——worker 是独立进程，不共享父的活 cell。

**D7 — 展示面的根取舍（保 KV cache）。**
`identity/assemble.ts:380-383` 的 `## Project path` 段**继续钉在稳定根**（其注释契约「cwd 在进程内稳定」保 KV cache 前缀字节稳定，不破）。活 `taskRoot` 只经**环境现势**（`envSnapshot`，`build-engine.ts:1053` → `loop-engine.ts:408`）暴露给人读面——对齐 CONTEXT.md「状态栏 vs 环境现势」分工（环境现势 = cwd/git/diff 给人，不进状态栏 user 消息）。

**D8 — mutate 分类真值源。**
分类改为从 registry 已携带的 ACI 元数据 + 能力面推导，取代 `worktree-gate.ts:249` 的硬编码 2 名集合；`build-engine.ts:849-872` 的私有覆写折进同一 SSOT（今天有两个分类真相源）。元数据缺失/未知 → **fail-closed 判 mutate**（对齐 `build-engine.ts:855-858` `__invalid_subagent_type__` 的既有兜底形态）。
注意 `symbol-mutate.ts:816` 已指出 `category:"write"` 还包含工作树生命周期与进程控制工具，它们不是 workspace mutate ⇒ 判据必须是「**写工作区**能力」，不是裸 `category`。判据的具体形态留给实施（headroom），fail-closed 方向钉死。

**D9 — read 面 `extraReadRoots` 同 vintage。**
`read-file.ts:60-65` 工厂期冻结的 `extraReadRoots` 必须与活根同 vintage：按 D2 的波快照一起重算，不得出现「`root` 是新的、`extraReadRoots` 是旧的」混vintage。persona / identity 可达性经稳定根（`projectIdentityRoot` / userHome）保证，不靠 `extraReadRoots` 兜。

**D10 — 死缝处置。**
`registry.ts:471-473` 传给 `createReadFileTool` 的 `projectIdentityRoot` 在 `read-file.ts` **无声明无消费**（`CreateReadFileToolOptions`（:26-36）只有 `workspaceRoot`；conditional spread 逃过 TS 多余属性检查）= 死缝。ADR-0037 §1 的「rebind 后身份根只读直通」要么接通、要么显式删除，**不许留半接**。

**D11 — 排序不变量（本计划最重要的安全约束）。**
**严禁先翻门禁再迁移工具。** 若门禁先读活根而 `write_file`/`bash` 仍闭包冻结旧根，就会出现「门禁放行 + 工具写主仓」的隔离破口——把今天的 fail-closed 变成 fail-open。因此顺序必须是 **expand（T4）→ 迁移全部 mutate 消费者（T5/T7/T8）→ 最后 contract 翻门禁（T10）**。T5–T9 期间门禁仍拦，放行面零变化，所以每批迁移都是零风险可独立回滚的。

## 6. Tracer bullets

### T1 — 堵掉隔离 fail-open：mutate 分类改由能力元数据推导

- **Tag**: `[implementation]`
- **Inherits**: §2 全部实测事实；**D8**（fail-closed 方向 + 「写工作区」而非裸 category）；`.qoder/rules/test.md`「不得为让构建通过而删除测试或降低 assert 强度」。
- **Surface**: `harness/isolation`（分类 SSOT）、`harness/build-engine`（私有覆写折入）、`harness/aci/tools/registry`（元数据来源）。
- **Acceptance**:
  - 隔离 ON 且会话根仍在主仓时，5 个 symbol-mutate 工具**全部被门禁拦下**，主仓零写入；`spawn_subagent` / `write_file` / `edit_file` / 会改工作区的 `bash` 的既有裁决**逐条不变**（`tests/harness/isolation/worktree-gate.test.ts:229-241` 现有 assert 保持绿，不改弱）。
  - 只读 bash、读路径工具、工作树生命周期工具（create/enter/exit）**不被误判为 workspace mutate**——否则模型连建树工具都调不动，功能自锁。
  - 分类真值源收敛到一处；`build-engine.ts:849-872` 不再是第二个真相源。
  - 元数据缺失/未知角色 → 判 mutate（fail-closed），有测试点名这条。
  - 新增覆盖落在既有隔离套件（`tests/harness/isolation/`），5 个工具名逐个有 assert（今天 grep = 0）。
- **Completion**: 独立于活根机制即可验证与回滚；两个实施者可以用不同判据形态（能力面推导 / 显式 mutate 名单注册 / registry 侧标注）通过同一 Acceptance。
- **依赖**: 无。可与 T2/T3 `[parallel]`。**建议最先落地**（in-force 安全缺陷）。

### T2 — 改写 ADR-0037：model-provision 契约 + 活 taskRoot

- **Tag**: `[decision]`
- **Inherits**: 操作员指令「以现在的架构改进决策为准」；`git show 4b4fa6fe^:docs/adr/0037-worktree-isolation-on-mutate.md`（被 `4b4fa6fe` 撤销的修订版）；§1 实测；**D1/D2/D3/D11**。
- **Surface**: `docs/adr`。
- **Acceptance**:
  - 盘上 ADR-0037 不再描述 **auto-provision**（现文 §1「首次 mutate 被拦截 → `git worktree add` 建 task worktree」与已 shipped 的 model-provision 代码矛盾：`worktree-gate.ts:521-527` 明确「NEVER provisions」）。改写为 model-provision 契约。
  - 明确记录**活 `taskRoot`** 决定：唯一 writer（D1）、batch 快照（D2）、稳定根清单（D3）。
  - **显式撤销**「same-turn mutator 列为非目标」这条旧裁决，并写明撤销理由 = §1 的 trace 证据 + spec 原文「不要求操作员 `/continue`」。
  - 钉死 rebind 生效边界用 **一轮（run）/ 回合（turn）** 既有词汇表述，不再用含糊的「下一 turn」——CONTEXT.md 已分别定义 **一轮**（:185）与 **turnCount**（:26），本 bug 的文案层病因就是两者混用。
  - `Status` / `Date` / supersede 关系按既有 ADR 惯例写；不改 ADR 编号（下一个空号是 0041，本 bullet 是修订 0037 不是新开）。
- **Completion**: 一个读者只读这份 ADR 就能判断「run 内 rebind 该不该生效、谁写根、哪些根不动」，不需要翻 plan 或 trace。
- **依赖**: 无 blocker，可与 T1 / T3 `[parallel]`。下游：T4 依赖本 bullet（决策先于代码）。

### T3 — 给 session-roots SSOT 补契约测试（零行为变化）

- **Tag**: `[implementation]`
- **Inherits**: §3 实测「`session-roots.ts` 零测试覆盖」；**D3**；`.qoder/rules/test.md` 六类覆盖（正常/失败/边界/权限不足/空或非法输入/并发）。
- **Surface**: `harness/session-roots`。
- **Acceptance**:
  - `resolveSessionRoots` 的现有契约被 characterization 测试钉住：四角色归位、缺根 → `missing_root`、相对/空白/含 NUL → `invalid_root`、**绝不回退 `process.cwd()`**（doc :30-31）、`stripTrailingSeparators` 保住 posix `/` 与 win32 `C:\`（:108-119）、`resolveInstallRoot` 锚 `import.meta.url` 且进程级缓存不给 reset 缝（:168-171）。
  - 四角色分工中「跨 rebind 不变」的那三条（`productRoot` / `projectIdentityRoot` / `installRoot`）有测试点名，作为 T4 之后不回归的锚。
  - 本 bullet **不改 `src/` 任何一行**（纯加测试）；`npm run typecheck` + 全量绿。
- **Completion**: 这是 T4 动这个模块之前的安全网；测试通过即证明 SSOT 现状被固定住。
- **依赖**: 无 blocker，可与 T1 / T2 `[parallel]`。下游：T4 依赖本 bullet。

### T4 — expand：活 `taskRoot` 持有者 + 唯一 writer（零行为变化）

- **Tag**: `[implementation]`
- **Inherits**: **D1**（归属 + 唯一 writer + 失败不写不回滚）、**D2**（batch 快照）、**D3**（稳定根清单）、T2 的 ADR 裁决、T3 的契约网。
- **Surface**: `harness/session-roots`（活持有者）、`harness/build-engine`（缝包装点）。
- **Acceptance**:
  - `resolveSessionRoots` 仍是纯函数、T3 的测试**逐条不变绿**；活持有者是同模块的另一个导出，包裹已校验快照，不新造平行根抽象。
  - writer 只有一个入口，且只在 host 缝**成功 resolve** 时写；缝抛 typed error 时活根**不变**、error 原样冒泡（有测试点名「失败不回滚也不写」）。
  - Hub / CLI 侧语义零变化：dirty-root 仍只在 provision 返回不同根时记录、conditional save 成功后清除（CONTEXT.md **Hub dirty root**），Hub 仍只观察返回根（**Hub-visible provision seam**）。有测试证明 Hub 没有变成第二份根权威。
  - **本 bullet 无任何消费者读活根** ⇒ 产品行为逐字节不变；全量测试 + `npm run typecheck` 绿。
  - 并发类有覆盖：同一波内多次读得到同一快照值（D2 的机制在此就位，T10 才依赖它）。
- **Completion**: expand 阶段完成——活根已存在且只有一个 writer，但还没人读，所以可独立合并、独立回滚。
- **依赖**: `[blocks: T2, T3]`（本 bullet 被 T2、T3 阻塞）。下游 T5 / T7 / T8 / T9 各自声明 `[blocks: T4]`。

### T5 — migrate 批 1：写路径工具读活根

- **Tag**: `[implementation]`
- **Inherits**: **D1/D2/D3**；**D11**（门禁仍拦 ⇒ 本批零放行变化）；`registry.ts:679`「每个工厂只在构造期调用一次」⇒ 活性必须在 handler 内部。
- **Surface**: `harness/aci/tools`（`write-file` / `edit-file`）、`harness/aci/tools/registry`（threading）。
- **Acceptance**:
  - `createWriteFileTool`（`write-file.ts:75`）与 `createEditFileTool`（`edit-file.ts:111`）在**调用时**取根，不再闭包冻结；`resolveWithinRoot` 的 containment 保证不降级（它本来就每次 `realpath(resolve(root))`，`helpers.ts:57`，喂活值即保住符号链接逃逸拒绝）。
  - 一次 handler 内 resolve 与写入用**同一个**根值（不得 resolve 用新根、写入用旧根）。
  - 稳定根不被拖动：`todoDir`（`todo-write.ts:109` 工厂期预计算 `filePath`）等 D3 清单成员保持冻结。
  - **门禁未翻 ⇒ 产品放行面零变化**：现有 `write_file`/`edit_file` 测试全绿；未 rebind 时行为逐字节等同今日。
  - 既有测试面（`createWriteFileTool` 19 处 / 3 文件、`createEditFileTool` 38 处 / 2 文件）保持绿——若签名形态变化，按 expand 纪律先兼容再迁移，不得删测试或降 assert 强度。
- **Completion**: 两个实施者可以用不同签名形态（`string | RootCell` 联合 / 工厂收 cell / handler 收 getter）通过同一 Acceptance。
- **依赖**: `[blocks: T4]`。

### T6 — migrate 批 2：读路径工具读活根 + 处置死缝

- **Tag**: `[implementation]`
- **Inherits**: **D9**（`extraReadRoots` 同 vintage）、**D10**（死缝接通或删，不许半接）、**D3**。
- **Surface**: `harness/aci/tools`（`read-file` / `glob` / `grep`）、`harness/aci/tools/registry`。
- **Acceptance**:
  - `read_file` 的 `root` 与工厂期冻结的 `extraReadRoots`（`read-file.ts:60-65`）**同 vintage**：不出现新根 + 旧 extra 的混vintage（有测试点名）。
  - `glob`（`glob.ts:86,89`）与 `grep`（`grep.ts:91,140,196,214,323`）在调用时取根；rebind 后读解析到新树，不再 not_found。
  - **D10 死缝有明确处置**：`registry.ts:471-473` 传的 `projectIdentityRoot` 要么被 `read-file.ts` 真实消费（接通 ADR-0037 §1 的身份根只读直通），要么连同传参一起删除；两种都可接受，**留半接不可接受**。
  - 读路径不因活化而放宽 containment：越根读仍被 typed 拒绝。
  - 既有测试面（`createReadFileTool` 8 处 / 3 文件、`createGlobTool` 20 处、`createGrepTool` 31 处、`resolveWithinRoot` 14 处）保持绿。
- **Completion**: 读路径迁移完；§1 里 turn 5 那类 `read_file not_found` 在本批之后不再出现。
- **依赖**: `[blocks: T5]`（与批 1 顺序改同一批 registry threading，避免冲突）。

### T7 — migrate 批 3：bash cwd + bwrap 围栏 per-call

- **Tag**: `[implementation]`
- **Inherits**: **D4**（argv 形状与顺序逐字节不变；前台/后台读同一波快照根）、**D2**、`.qoder/rules/security-boundaries.md` 全文（bwrap 0.11.1 实测适配）。
- **Surface**: `harness/aci/tools/bash`、`harness/sandbox`（`fs-policy` / `bwrap` / `runner`）。
- **Acceptance**:
  - `createFsPolicy`（今天 `bash.ts:74-79` 工厂期一次成型 → `fs-policy.ts:96` 冻结 `roots`）与 `createBwrapFence`（`bash.ts:156`）改为 per-call 用波快照根重建；**argv 顺序与 flag 集合逐字节不变**（system `--ro-bind` → user `--bind` → `--size`/`--tmpfs` → 可选 cwd 重绑 → `--proc`/`--dev-bind` → `--chdir` → `--` → 命令）。
  - **`npm run probe:sandbox` 全 11 类探针（9 物理 + 2 violation）全绿**——这是本 bullet 的硬门，不是可选项。
  - **`npm run probe:sandbox:subagent` 绿**。
  - 沙箱纪律：同一 `bash` 调用输入下，前台执行与 `background:true` spawn 共用同一套围栏参数（CONTEXT.md **沙箱纪律**）；后景臂已在 `background/manager.ts:232-266` per-spawn 构造，本批要保证两臂读**同一个**快照根，不出现前景新根/后景旧根。
  - `cwd` 在 `/tmp` 子路径时 `--tmpfs /tmp` 之后仍重绑 cwd（security-boundaries.md 既有实测适配，不得回归）。
  - 既有围栏测试（`createFsPolicy` 32 处 / 8 文件，含 `tests/harness/sandbox/bwrap-rebind.test.ts`、`tests/harness/aci/bash-fence-parity.test.ts`）保持绿。
- **Completion**: 最高风险的一批，靠 11 类探针 + fence-parity 做地面真值；探针不过即本 bullet 未完成。
- **依赖**: `[blocks: T4]`。可与 T6 `[parallel]`（不同文件面）。

### T8 — migrate 批 4：LSP/symbol 活目录 + 子代理 spawn 时取根

- **Tag**: `[implementation]`
- **Inherits**: **D5**（旧根 client 显式收口，不泄漏不复用）、**D6**（ADR-0040 spawn 时取根；worker 自身装配 spawn 后冻结）、T1 的分类修复。
- **Surface**: `harness/aci/tools`（`symbol` / `symbol-mutate` / `lsp`）、`harness/lsp`（`server` / `client` / `warmup` / `notifier`）、`harness/subagent`（`spawn` / `manager`）、`harness/build-engine`。
- **Acceptance**:
  - `LspCtx.directory` 调用时取活根；NearestRoot 上界（`lsp/server.ts:39-41`）随活根走 ⇒ rebind 后 symbol 工具能到新树、且**够不到旧根**。
  - 根翻转时旧根 client **显式 stop**：无残留 spawn 进程（不泄漏）、无复用旧根 client（不写旧根）。两条都有测试点名。
  - 子代理继承按 **D6** 在 spawn 调用时判定与取根，替换 `build-engine.ts:577-581` 的装配期一次判定；`manager.ts:898-904` 对子根的 typed 校验以活根为上界（今天它以陈旧父根为上界，会误拒新树里的子根）。
  - ADR-0040 **子代理根归属** 成立：父已 rebind 时子代理与父共享同一棵 task worktree；父未 rebind 时满足只读门禁的子代理可留主仓且不建独立 worktree。
  - **`npm run probe:lsp` 绿**；`npm run probe:sandbox:subagent` 绿。
  - `tests/mcp/rebind-boundary-matrix.test.ts`、`tests/mcp/rebind-dual-root-smoke.test.ts`、`tests/subagent/` 相关面保持绿。
- **Completion**: 两个实施者可以对 client 收口时机（翻转即收 / 惰性收 + 上界校验）做不同选择，只要「不泄漏 + 不写旧根」两条都可观测。
- **依赖**: `[blocks: T4, T1]`。

### T9 — migrate 批 5：展示面 —— 稳定根进 system，活根进环境现势

- **Tag**: `[implementation]`
- **Inherits**: **D7**（`## Project path` 钉稳定根保 KV cache；活根只经环境现势）；CONTEXT.md **状态栏 vs 环境现势**（:194-198）、**环境现势**（「不写入 ADR-0028 状态栏 user 消息，也不充当 verify 输入」）。
- **Surface**: `harness/identity`（`assemble`）、`harness/build-engine`（`envSnapshot`）、`harness/loop-engine`（读口）。
- **Acceptance**:
  - `identity/assemble.ts:380-383` 的 `## Project path` 段继续渲染**稳定根**；system prompt 前缀字节稳定性测试保持绿（未 rebind 时逐字节不变；rebind **不**造成前缀抖动）。
  - 活 `taskRoot` 经环境现势（`build-engine.ts:1053` → `loop-engine.ts:408` `readEnvSnapshot`）反映当前树 ⇒ rebind 后人读面（cwd / git 摘要）不再停在主仓。
  - 活根**不进** ADR-0028 状态栏 user 消息、**不**充当 verify 输入（CONTEXT.md 明令）。
  - `assemble.ts:380-383` 那条「cwd 在进程内稳定」的注释按新事实改写（它已被本变更否证），不留误导性注释。
- **Completion**: 展示面迁移完；KV cache 契约与「给人/给模型」分工都没破。
- **依赖**: `[blocks: T4]`。可与 T6/T7/T8 `[parallel]`。

### T10 — contract：门禁改读活根（原 bug 的 red→green）

- **Tag**: `[implementation]`
- **Inherits**: **D11**（必须最后翻）、**D1/D2**、T2 的 ADR 裁决、T5+T7+T8 已把所有 mutate 消费者迁完；`.qoder/rules/test.md`「Trace as the integration-test assert surface」（double-track：trace-based assert 之外再配 NoopTraceService-vs-no-trace deepEqual 基线）。
- **Surface**: `harness/isolation`（门禁）、`harness/build-engine`（装配）。
- **Acceptance**:
  - **先写 red 测试再翻门禁**：门禁读活根后，「run 内 turn 0 `create-task-worktree` 成功 → 同 run 后续 turn 的 mutate 落地到新树」这条从 red 转 green。red 阶段必须实测到 red（不得直接提交绿测试冒充）。
  - `worktree-gate.ts:518`（`state.boundRoot === root`）与 `:550` 的 passthrough 语义在活根下重新成立；`:525` 的 shape 判定读活根。
  - **D2 batch 快照有测试点名**：同一波 `executeAll` 内活根翻转不被观察到（整波一个根）；跨波才生效。
  - **无 admit-but-write-old-root 窗口**：门禁放行的每一个 mutate，其执行消费者的根与门禁裁决用的根是同一个波快照值（有测试点名，这条是 D11 的可观测形式）。
  - 未 rebind 时行为逐字节不变；`unboundMutateNotice()` 在**真的没建过树**时仍然照旧拦（fail-closed 不降级）。
  - `create-task-worktree`（`create-task-worktree.ts:70,94-95`）与门禁文案里含糊的「next turn」按 T2 的 run/turn 词汇校正。
  - 既有隔离测试（`tests/harness/isolation/worktree-gate.test.ts`、`tests/session-api/hub-worktree-isolation.test.ts`、`tests/harness/build-engine.test.ts:1390,1421,1452`）保持绿，不删不弱化。
- **Completion**: §1 的病灶在此闭合；因为 D11 的排序，这一刻所有 mutate 消费者都已经活，放行是安全的。
- **依赖**: `[blocks: T5, T7, T8]`（T6/T9 非阻塞但建议同批之后）。

### T11 — 收敛：命名 engine-bundle 类型 + 合并三条重建缝（纯 refactor）

- **Tag**: `[implementation]`
- **Inherits**: ACR complexity-anti-drift 与 minimal-change 的拆分要求；`.qoder/rules/code-quality.md` Single Source of Truth / Follow Existing Conventions。
- **Surface**: `harness/build-engine`、`session-api/hub`、`cli/chat-session`、`tui/hub-bridge`、`tui/deps`、`tui/run`。
- **Acceptance**:
  - 今天内联重复约 12 处的 engine-bundle 形状（`hub.ts:540,646,669,798,2727`；`build-engine.ts:325`；`tui/hub-bridge.ts:212,243`；`tui/deps.ts:231`；`cli/chat-session.ts:146,225`）收敛为**一个命名类型**；`RebuiltChatEngine`（`chat-session.ts:214`）不再是一份私有同形拷贝。
  - 三条平行重建缝（chat `rebuildDeps` / tui `buildEngine` / hub `getOrBuildEngine`，`hub.ts:2685-2708`）落在同一个命名类型上，语义漂移消失。
  - **纯 refactor：零行为变化**。全量 `npm test` + `npm run typecheck` 绿；所有 host 的重建/rebind 测试保持绿。
  - 顺带清掉同类反模式：`todo-write.ts:109` 工厂期预计算 `filePath`（`todoDir` 本身按 D3 保持冻结，只是不再工厂期拼死路径）。
  - 复杂度门交给 `complexity-anti-drift` 阈值判定，本 bullet 不自订行数/圈度数字。
- **Completion**: 一个读类型定义就能知道「一台重建出来的 engine 交回哪些句柄」，不需要在 5 个文件里比对内联字面量。
- **依赖**: `[blocks: T10]`（行为定型后再收敛，避免 refactor 与语义改动互相掩盖）。

### T12 — 收尾：run 级端到端复现 + 全量验证 + 术语落盘

- **Tag**: `[implementation]`
- **Inherits**: `.qoder/rules/test.md`（trace double-track、真实 store + fresh conversationId、完成 = 实测过）；§5 全部 D；T2 的 ADR。
- **Surface**: `tests/`（集成面）、`docs/CONTEXT.md`。
- **Acceptance**:
  - **§1 那个 trace 场景有 run 级端到端复现测试**：stub model + stub tool，一个 run 内 turn 0 调 `create-task-worktree`、后续 turn 发 mutate，assert mutate 落在 `<repo>/.iknow/worktrees/<conversationId>` 且主仓零写入。接**真实 store（temp dir）+ 真实 fresh conversationId**（不预存 session 文件），按 test.md 的命令 handler 集成测试纪律。
  - **double-track assert**：trace-based（`createJsonlTraceService` + `createJsonlTraceReader` 对 event sequence）之外，再配一条 NoopTraceService-vs-no-trace deepEqual 基线。
  - 全量验证矩阵实测并附输出：`npm run typecheck`、`npm test`、`npm run probe:sandbox`（11 类）、`npm run probe:sandbox:subagent`、`npm run probe:lsp`。任一不过 ⇒ 本 bullet 未完成，不得声称 done。
  - **CONTEXT.md 术语落盘（post-implementation persist）**：新增 `taskRoot` / `SessionRoots` / `projectIdentityRoot` / `installRoot`（今天 grep = 0 匹配），并把 `worktree isolation mode`（:320）与 `session worktree rebind`（:323）里残留的 **auto-provision** 措辞改成已 shipped 的 model-provision + 活 taskRoot 语义。只写清单上的项，经 `domain-modeling`。
  - 收尾报告按 `.qoder/rules/CLAUDE.md`：改了什么 / 实际运行的验证及结果 / 未验证内容及原因 / 风险与 Git 操作。
- **Completion**: 「完成 = 跑过 = ground truth」；不包装 deferred 项。
- **依赖**: `[blocks: T11]`。

## 7. 依赖图

`[blocks: X]` 的读法 = **本 bullet 被 X 阻塞**（X 是先决条件）。下表与各 bullet 的「依赖」行同源。

| bullet | 被谁阻塞（先决条件） | 可与谁并行 |
| --- | --- | --- |
| T1 分类 fail-open 修复 | 无 | T2 / T3 |
| T2 ADR-0037 改写 | 无 | T1 / T3 |
| T3 session-roots 契约网 | 无 | T1 / T2 |
| T4 expand：活根 + 唯一 writer | T2, T3 | — |
| T5 migrate 批 1：写路径 | T4 | — |
| T6 migrate 批 2：读路径 + 死缝 | T5 | T7 / T9 |
| T7 migrate 批 3：bash 围栏 | T4 | T6 / T9 |
| T8 migrate 批 4：LSP + 子代理 | T4, T1 | T6 / T7 / T9 |
| T9 migrate 批 5：展示面 | T4 | T6 / T7 / T8 |
| T10 contract：翻门禁（red→green） | T5, T7, T8 | — |
| T11 收敛：命名类型 + 合并 3 缝 | T10 | — |
| T12 收尾：e2e + 全量 + persist | T11 | — |

- **可并行**：`T1 ∥ T2 ∥ T3`（三路起点）；`T6 ∥ T7 ∥ T9`（不同文件面）；T8 只等 T4 与 T1，**不等** T5/T7。
- **硬串行**：`{T2,T3} → T4 → {T5→T6, T7, T8, T9} → T10 → T11 → T12`。
- **T10 绝不可提前**（D11）：翻门禁时 T5（写路径）、T7（bash 围栏）、T8（LSP/子代理）必须已全部落地，否则「门禁放行 + 消费者仍写旧根」= 把 fail-closed 变成 fail-open。T6 / T9 是读路径与展示面，不构成 T10 的安全先决条件，但建议同批之后再做，避免与 T10 争同一批装配文件。
- T11 是纯 refactor，刻意排在行为定型（T10）之后，避免重构与语义改动互相掩盖。

## 8. 验证矩阵（按改动范围选，出自 `.qoder/rules/test.md`）

| 改动面 | 命令 | 硬门 |
| --- | --- | --- |
| 分类 / 门禁 / 隔离 | `npx vitest run tests/harness/isolation tests/session-api/hub-worktree-isolation.test.ts tests/mcp/rebind-boundary-matrix.test.ts tests/mcp/rebind-dual-root-smoke.test.ts` | T1 / T10 |
| session-roots SSOT | T3 新增契约测试 + `npm run typecheck` | T3 / T4 |
| 工具路径解析 | `npx vitest run tests/harness/aci` | T5 / T6 |
| 沙箱 / bwrap | **`npm run probe:sandbox`（11 类全绿）** + `npm run probe:sandbox:subagent` + `npx vitest run tests/harness/sandbox` | T7 |
| LSP | **`npm run probe:lsp`** + `npx vitest run tests/harness/aci/lsp.test.ts` | T8 |
| 子代理 | `npx vitest run tests/subagent` + `npm run probe:sandbox:subagent` | T8 |
| 装配 / 三入口 | `npx vitest run tests/harness/build-engine.test.ts tests/tui tests/cli` | T4 / T9 / T11 |
| 全量（收尾） | `npm test` + `npm run typecheck` + 上述全部 probe | T12 |
| LLM 客户端 / loop 契约（本计划未触及，若实施中被动到） | `npm run test:real-llm`（缺 key → 显式 Not run） | 条件触发 |

超时 = 选错矩阵 → 切窄矩阵重跑，不要放宽 assert。

## 9. 待写入（persist 清单）

**(a) 计划落盘即写（描述已 shipped 现实，`domain-modeling` flush）：**

1. `docs/CONTEXT.md:320` **worktree isolation mode** — 现文写「首次 mutate（写路径）被拦截 → `git worktree add` 建 task worktree → session worktree rebind」= **auto-provision**，与已 shipped 的 model-provision 代码矛盾（`worktree-gate.ts:521-527` 明写 gate NEVER provisions，建树由 `create-task-worktree` ACI 工具承担）。
2. `docs/CONTEXT.md:323` **session worktree rebind** — 同一条 auto-provision 措辞（「首次 mutate 成功后」）需校正。
3. `docs/CONTEXT.md` 缺 **`SessionRoots`**（四角色根 SSOT，`src/harness/session-roots.ts`，已 shipped 且已被 `BuiltEngine.sessionRoots` 暴露，grep = 0 匹配）。
4. `docs/CONTEXT.md` 缺 **`projectIdentityRoot`**（与 `productRoot` 分开的理由：`--workspace-root <dir>` 重定向档下 `dir ≠ cwd`，见 `session-roots.ts:16-20`）。
5. `docs/CONTEXT.md` 缺 **`installRoot`**（锚 `import.meta.url`，≠ 用户项目 `node_modules`，故裸 task worktree 上 worker 仍起，`session-roots.ts:24-25,173-180`）。

**(b) 实施后写（描述本计划引入的新语义，T12 负责；现在写会把未实现行为登记成活跃术语）：**

6. **`taskRoot`** 的**活性**语义：调用时读取、唯一 writer = 装配层缝包装点、batch 快照（一波一根）、生效边界用「一轮 / 回合」表述（D1/D2 + T2）。
7. **rebind 生效边界**：明确 rebind 在 run 内对**下一波** tool calls 生效，不需要操作员再发消息（撤销旧「same-turn mutator 非目标」裁决）。

**(c) ADR reopen 记录：**

8. `docs/adr/0037-worktree-isolation-on-mutate.md` — **本计划 T2 即 reopen 对象**。
   > Contradicts ADR-0037 — worth reopening because：盘上 ADR §1 描述 auto-provision（首次 mutate 自动 `git worktree add`），而已 shipped 代码是 model-provision（gate NEVER provisions，`worktree-gate.ts:521-527` + `create-task-worktree` 工具）；且被 `4b4fa6fe` 撤销的修订版原文要求「不要求操作员 `/continue`」，当前 run-boundary-only 的 rebind 传播做不到，§1 的 trace 是实测反证。
9. ADR-0040（`docs/adr/0040-subagent-identity-and-dispatch-gate.md`）**子代理根归属** — 不需 reopen，但 T8 是它的**实现补齐**：「继承父会话**当前生效**根」今天被 `build-engine.ts:577-581` 实现成装配期一次判定（D6）。

## 10. 收尾 code review 阶段（只说一次）

T12 绿之后跑一次**整轮**收尾评审（不是每 commit 重复）：`code-review`（Standards + Spec 双轴，针对整轮 diff）→ `verification-before-completion`（对照本计划 §5 的 D1–D11 与 §8 矩阵逐条核）→ 才 commit/push。中途 WIP commit 不需要先过 code-review。

**未经操作员显式 `push` 授权不执行 `git push`**（`.qoder/rules/CLAUDE.md`）。

## 11. 未纳入本计划（显式非目标，防止范围蠕变）

- 孤儿 task worktree 的清理（既有 plan 已列为非目标，本计划继承）。
- `ba3ead79`（`WorktreeGateRebindMutator` / `setReboundRoot`）的复活：那是「只改门禁 root cell」的路子，**已被证伪**——工具与围栏仍闭包冻结旧根时会把 fail-closed 变成 fail-open（D11）。本计划走的是「所有消费者一起活」。
- serve 的 product workspace 多根（ADR-0023 语义不动；CONTEXT.md 明写 git worktree ≠ product workspace 多根）。
- rebind 后隐式重载 project settings（ADR-0037 §5 明令禁止，本计划不破）。
- 「提交 → push → PR」产品向导与 `gh` 鉴权（ADR-0037 已划为另轨）。
