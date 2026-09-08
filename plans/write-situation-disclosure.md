# Plan: 写处境告知与建树失败出口

**Goal:** 隔离 OFF / ON-已绑 / ON-未绑三态下，harness 对模型说的每一句关于「能写哪」的话都与门禁此刻的裁决同真值；每一次建树失败都带一个模型能执行的下一步。

**Approach:** ADR-0069 与两份 CONTEXT 词条已在 specify 阶段落盘。先把 SC7 那条**禁止**改文案的决议 amend 掉（否则 T2 一落地就违反活跃 spec），再恢复回执语义；同时并行铺开写处境三态判定（expand），然后按「主会话告知面 → 子代理告知面」两批 migrate 消费方；失败出口一侧先立可恢复性穷尽表，再改两个 kind 的 detail。bash `/tmp` 一句与 enter 归属告知各自独立、随时可插。**不改**门禁裁决逻辑、波快照语义、围栏 argv。

**Spec link:** `specs/write-situation-disclosure.md`
**ACR:** PASS（5/5 yes，见下方五维）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch；全部 bullet 落地后再跑一轮 `code-review`。

**Tracker:** 操作员明确不开 GitHub ticket，本 plan 的 T1–T10 不拆成 issue；依赖图以本文件的 `[blocks:]` / `[parallel]` 标注为唯一事实源（同 `plans/mutate-write-contract.md` 的处理）。上游 [#946](https://github.com/winter6205/iknow/issues/946) 由 PR #947 关闭。

**合并顺序（ACR note b，硬约束）:** 本 plan 与 PR #947 都要改 `docs/CONTEXT.md` / `specs/README.md` / `docs/adr/0037`。#947 仍 OPEN，**本 plan 的所有 bullet 必须排在 #947 合并之后**，否则三个 doc 文件位置冲突。代码面零交集（#947 = `hard-walls.ts` / `helpers.ts` / `manager.ts` / `permission/*`；本 plan = `skill/body.ts` / `isolation/*` / `session-roots.ts` / `build-engine.ts` / `worktree-rebind.ts` / `bash.ts`）。

## ACR

```
bounded-context-guardian: yes — 依赖方向钉死且与现状一致：判定住 isolation（复用 worktree-gate.ts:575 isTaskWorktreePath，gate 自身 :1013 首查即用它）、渲染住 skill、枚举住 session-roots（SC4 显式断言 body.ts 不 import isolation）；无技术分层切片、无反向依赖。
defensive-contract-validator: yes — 两份五类表全部分配、无造假：A 表 negative 钉「隔离 OFF + 树形 → writable_main」防形状误用；B 表 overflow = 16 kind 穷尽由 typecheck 承担（实测 union 恰 16 成员，worktree-gate.ts:95-123）；concurrent 两处 `// N/A: pure` 合法。
error-handling-enforcer: yes — SC6 编译期穷尽 + SC7 停止指令 + 机读 kind + SC8 sidecar 读失败退化不 throw + B 表非 ENOENT rethrow；「记录缺 workspaceRoot → 放行」不是 fail-open。
complexity-anti-drift: yes — 一个纯函数 + 一张静态表 + 文案分支；明令不改 classifyCall / gateMutate 状态机；无 god-function 意图。
minimal-change-verifier: yes — 两 spec = 两个 destination，拆分正确；本份修既有行为可信性，lock 份加新策略档位；依赖已声明实施顺序，非环。
OVERALL: PASS — hand to writing-plans
```

## 待写入

（空 — ADR-0069、CONTEXT「写处境」新词条与「taskRoot（活值）」amend 已在 specify persist flush。T1 / T5 的产出是 spec 文件本身的 amend，不是 CONTEXT/ADR 项。）

## Tasks (ordered by dependency)

1. **SC7 收窄：撤销反引导半句** — tag: `[decision]`
   - **Inherits:** ADR-0069 Decision 4；spec Changes「`specs/casual-ask-context-hygiene.md` SC7 **amend**（非 supersede）」
   - **Surface:** `specs/casual-ask-context-hygiene.md`（该文件**就是**产出）
   - **Acceptance:** SC7 读作——**保留**「不按用户问句分两套文案」与三条子串禁令（含 `create-task-worktree`、不含 `this conversation's task worktree`、含 `This call would write`）；**撤销**「不把模型下一拍收成去建树」并附撤销理由（回执只在写意图已证时出现，casual ask 结构上碰不到它）；**新增**「验收从纯子串升级为语义 + 子串」的义务句；并记录 spec→实现的语义漂移（锁定语义里的「再重试这一次调用」在实现中丢失）为本次修复对象
   - Status: [ ] pending
   - [blocks: T2]

2. **`unboundMutateNotice` 恢复可行动语义** — tag: `[implementation]`
   - **Inherits:** spec SC5 (a)–(e)；`casual-ask-context-hygiene.md:21` 锁定语义「若要写，调 `create-task-worktree` 再重试这一次调用」；ADR-0037 §7.5「本 run 内下一波 tool calls 将在新根上落地」措辞（不得用「下一 turn」）
   - **Surface:** `src/harness/isolation`（门禁阻断文案）+ 既有 isolation 单测
   - **Acceptance:** 隔离 ON 且未绑树时发一个 `write_file`，回执同时含条件式（`To write` 等价）与「重发这次调用」语义（`re-issue` 等价），且三条既有子串禁令仍满足；测试**断言语义**而非只断言子串（把 SC7 空心化的成因堵住）
   - Status: [ ] pending
   - [blocks: T1]

3. **写处境三态判定（expand，无消费方）** — tag: `[implementation]`
   - **Inherits:** spec SC1、SC4；ADR-0069 Decision 2；Changes 已冻结落点——判定新增 `isolation/write-situation.ts`、枚举类型落 `session-roots.ts`，**不追加进 `worktree-gate.ts`**（该文件已 1167 行，ACR note a）
   - **Surface:** `src/harness/isolation` + `src/harness/session-roots.ts`
   - **Acceptance:** 纯同步函数（不碰磁盘、不跑 git）返回三态；**复用** `isTaskWorktreePath` 而非重写形状判断（审查项：无第二份形状逻辑）；输入五类表 A 全部可观察，其中 negative 臂钉住「隔离 OFF + 树形路径 → `writable_main`」；空 / 空白根 typed 结果不 throw
   - Status: [ ] pending
   - [parallel]

4. **主会话告知面按处境渲染（migrate 批 1）** — tag: `[implementation]`
   - **Inherits:** spec SC2、SC3、SC4；ADR-0069 Decision 2/3；ADR-0037 T9 红线（活写根不进 system）；`skill-load-write-root` 合同 1「文案只有一份」
   - **Surface:** `src/harness/skill`（渲染）+ `src/harness/build-engine.ts`（deps 接线）+ 三个生产调用方（ACI `skill()`、`session-api` hub、`cli` chat-session）+ 既有 skill body / rebind 测试
   - **Acceptance:** 隔离 ON 且未绑树时加载一个 skill，模型看到的正文末段是 ③ 态文案且**不含** `create-task-worktree` 字面；①② 两态输出与改造前**逐字节相等**（断言锁死，守前缀缓存与 `skill-load-write-root` SC2）；`skill/body.ts` **不 import** `isolation/`；改绑后注入缝仍只注入一次、不进 system
   - Status: [ ] pending
   - [blocks: T3]

5. **`skill-load-write-root` 合同 6 / SC6 amend** — tag: `[decision]`
   - **Inherits:** spec Changes「合同 6 / SC6 **amend**——envelope 多带处境枚举，worker 渲染入参变更；合同 1『文案只有一份』不变」
   - **Surface:** `specs/skill-load-write-root.md`（该文件**就是**产出）
   - **Acceptance:** 合同 6 读作「worker prior 写根段改用同一 helper，入参为**处境枚举**而非裸 `sandboxRoot`；顺序契约 `[host dialogue?, evidence?, write root]` 不变」；SC6 相应改写并保留「worker 源内无第二份写根长句」的原断言强度
   - Status: [ ] pending
   - [parallel]

6. **子代理告知面按处境渲染（migrate 批 2）** — tag: `[implementation]`
   - **Inherits:** spec SC4、OQ1（**采纳 (b) typed skip**——ACR 已代查：envelope 无 schema version 字段，`worker.ts:177-208` 已有「字段缺席回落 legacy 形态」先例）；ADR-0040 子代理是父会话执行臂
   - **Surface:** `src/harness/subagent`（envelope 装配 + worker prior）+ 既有 worker prior 测试
   - **Acceptance:** 未绑树的父会话派出的子代理，prior 里的写根段是 ③ 态文案或**整段不注入**，绝不再是「突变写该根」指向主仓；旧 envelope（无处境字段）走 typed skip 而非回落旧文案；worker 源内仍无第二份写根长句
   - Status: [ ] pending
   - [blocks: T4, T5]

7. **可恢复性穷尽表 + `operator_required` 停止指令** — tag: `[implementation]`
   - **Inherits:** spec SC6、SC7；ADR-0069 Decision 5；PR #947 `HardRuleSpec.reasonFor` 建立的「机读 id 进 reason」惯例；Changes 已冻结落点——新增 `isolation/recoverability.ts`
   - **Surface:** `src/harness/isolation` + 门禁回执渲染缝
   - **Acceptance:** `Record<WorktreeIsolationErrorKind, Recoverability>` 覆盖全部 16 个成员，**漏一个则 `npm run typecheck` 失败**（编译期穷尽，不靠测试兜）；`not_a_git_repo` / `git_unavailable` 的回执含停止指令语义（「重试无用 / 报给操作员」等价）与机读 `kind`
   - Status: [ ] pending
   - [parallel]

8. **两个残留 kind 的指引唯一化** — tag: `[implementation]`
   - **Inherits:** spec SC8、SC9；输入五类表 B 的 empty / negative 臂；ADR-0037 §3 fail-closed（不静默覆盖、不复用归属不明的树）；CONTEXT「task worktree label」条目「同名已存在 → 建树失败不覆盖」
   - **Surface:** `src/harness/isolation`（两个 kind 的 detail）+ `src/session-api`（sidecar 归属反演消费）+ isolation 单测
   - **Acceptance:** `worktree_exists` 按归属分三臂且各有测试——owner === 本会话 → 点名 `enter-task-worktree`；owner !== 本会话 → 点名 `enter-task-worktree`（显式接手）或换 label；owner 读不出 → 点名 `list-task-worktrees`。`branch_exists` 分两子况——目标目录**存在** → 与前者同形；目标目录**不存在**（`remove-task-worktree` 默认不删分支造成的遗留分支）→ 指引换 label 或请操作员删分支，且**不含** `enter-task-worktree`。sidecar 读失败退化到第三臂、不 throw
   - Status: [ ] pending
   - [blocks: T7]

9. **enter 成功回执告知树的创建者（恒定开）** — tag: `[implementation]`
   - **Inherits:** spec SC10；ADR-0069「sidecar 归属的职责是**告知**，不是授权」；ADR-0070 Decision 7（告知与拦截解耦，不受任何设置控制）
   - **Surface:** `src/session-api`（enter 缝的成功回执）+ 相应测试
   - **Acceptance:** enter 一棵由别的会话创建的树，成功回执含该树 sidecar 记录的创建者会话 id；sidecar 读不出则**省略该句**（不崩、不占位）；此告知**不受任何设置项控制**（`isolation.worktreeExclusive` OFF 时同样告知）
   - Status: [ ] pending
   - [parallel]

10. **bash 描述补 `/tmp` 进程临时事实** — tag: `[implementation]`
    - **Inherits:** spec SC11；ADR-0068 与 `helpers.ts` T3 已定词汇（`process-temporary` / `not a delivery destination`）；ADR-0069「Why not 把 `/tmp` 事实放进写根段」——属 bash 面，且写根段也进只读子代理 prior
    - **Surface:** `src/harness/aci/tools`（bash 工具描述）+ schema 断言测试
    - **Acceptance:** bash 工具 description 含「`/tmp` 内文件仅在本命令期间存在、命令结束即无」语义，词汇与 `helpers.ts` T3 文案一致；该句是**静态**的，不进写处境三态函数、不随改绑变化；`writeRootSegment` 输出**不含**该句（两轴不混）
    - Status: [ ] pending
    - [parallel]

## 认下的残留（不是 bullet，实施时不得当漏修）

外来树 + 无持久化 enter 记录 → 告知面说可写、门禁给 `foreign_worktree`。**不修**（ADR-0069 Decision 6）：该错误自带出路（`move this session back to the main repo first`），乐观告知 + 自洽错误 = 一步可恢复。消掉它要让纯函数读可变门禁状态与 session-api 持久化记录，把渲染面耦到状态机上并引入波快照时序问题。

## 收尾

全部 bullet 落地后跑一轮 end-of-round code review（`arthurpower:code-review` 双轴），再 `verification-before-completion` 对照 spec SC1–SC12 逐条核对。绿线：`npm test` + `npm run typecheck` exit 0。不跑 `test:real-llm`（本轮不触 LLM 客户端 / adapter / loop 契约 / 流式）。
