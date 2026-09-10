# 0069. 写处境告知与回执的分工 · 可恢复性分类轴

Date: 2026-09-08

Status: accepted; superseded-by ADR-0079 §Decision 1 only

> 来源：`specs/write-situation-disclosure.md`。承接 ADR-0068（可写合同）与 PR #947；#947 修「伸手要写那一刻拒绝理由错不错」，本 ADR 修「伸手之前告知真不真」与「伸手注定失败时有没有出路」。

## Context

三处缺陷同一根因——harness 给模型的信息不可信或没有出口：

1. **告知面与门禁真值相反**。`writeRootSegment` 只吃一个路径字符串，无条件宣告「文件改动应该落在这里」。而装配初值 `taskRoot: sandboxRoot` = 主仓、`liveTaskRoot` 无条件创建、三个生产调用方无条件 `read()`。于是隔离 ON 且未绑树时，告知面说「写主仓」，门禁同一时刻以 `unboundMutateNotice` 拒绝一切写主仓的 mutate。两句话**同时在场、真值相反**，模型无从判断哪句为真，只能重试至回合耗尽。
2. **回执语义空心化**。`specs/casual-ask-context-hygiene.md:21` 的锁定语义是「若要写，调 `create-task-worktree` **再重试这一次调用**」；实现只剩「该工具存在，供需要可写根的会话使用」——唯一可行动的后半句丢失。SC7 验收只断言三个子串，实现满足子串、语义已空，测试全绿无人察觉。
3. **失败没有出口**。`worktree_exists` / `branch_exists` 的 detail 指向「人工清理」，而模型手里有 `enter-task-worktree` / `list-task-worktrees`；`not_a_git_repo` / `git_unavailable` 是结构性死路（本会话不可能取得可写根），detail 只诊断不叫停。

## Decision

### 1. 分工原则

**告知面说「此刻能不能写」，回执说「下一步做什么」。** 两边都真，不重叠。

告知面 = skill 正文 trailer、子代理 worker prior、改绑后主会话注入（`specs/skill-load-write-root.md` 三面）。回执 = 门禁阻断文案与工具 typed 错误。

**共享处境判定，不共享措辞。** 三个面的纪律不同（告知面不得引导、回执必须给出路），共用一个字符串必有一条纪律被破；共用一个真值源则两条同时成立。

### 2. 写处境三态

```
writable_main      隔离 OFF                      → 主仓可写
writable_tree      隔离 ON + 当前根是树形        → 该树可写
no_writable_root   隔离 ON + 当前根非树形        → 无处可写
```

判据 = 隔离开关 + **复用** `isTaskWorktreePath`。不得重写形状判断（`classifyCall` 已有同类教训：硬编码名单漏掉 5 个符号工具 → fail-open，故改为复用 `FILE_WRITE_TOOL_NAMES` 并立下「one name → one classification, no shadow copies」）。

判定为**纯同步函数**，不碰磁盘、不跑 git——它在每次 skill 装配与每次子代理 spawn 时被调用。枚举类型住 `session-roots.ts`，判定住 `isolation/`，渲染住 `skill/`；`skill/` **不 import** `isolation/`，依赖单向无环。

①② 两态输出**逐字节不变**（前缀缓存与既有 SC 的硬约束）；③ 态是新字节，而状态变了本就该 miss。

### 3. ③ 态不点名建树工具

`no_writable_root` 的告知只陈述事实（隔离开着、未绑树、主仓对文件改动只读、此刻无可写根），**不含** `create-task-worktree` 字面。

理由不是 SC7 的反引导条款本身，而是**时机**：告知面在 skill 装配时进上下文，**早于任何写意图**；在那里点名工具，等于对每一个未绑会话、每一次 skill 加载都推一次建树——比 SC7 已经禁止的（在意图已证的回执上不得用祈使句）更激进。点名留在回执：模型真的伸手要写、被拦下的那一刻，意图已证。

### 4. SC7 收窄

`specs/casual-ask-context-hygiene.md` SC7 **amend，不 supersede**：

- **保留**：不按用户问句分两套文案；子串禁令（含 `create-task-worktree`、不含 `this conversation's task worktree`、含 `This call would write`）。
- **撤销**：「不把模型下一拍收成去建树」。撤销理由 = 回执只在写意图已证时出现，casual ask 结构上碰不到它，该顾虑在这个时点不成立。
- **新增**：验收从纯子串升级为**语义 + 子串**——断言回执含条件式与「重发这次调用」语义。子串断言拦不住语义空心化，这是本次缺陷 2 的直接成因。

### 5. 可恢复性分类轴

每个 `WorktreeIsolationErrorKind` 归入 `model_actionable` | `operator_required`，由一张 `Record` 静态表承载。**穷尽性由 TypeScript 编译期保证**：新增 kind 未分类则 `typecheck` 失败，不靠测试兜。

`operator_required` 的回执**必须含停止指令**（「重试无用 / 报给操作员」等价）。理由：模型的默认循环是重试，不明确叫停就会重试到回合耗尽——结构性死路只诊断不给出口，等于把死路变成消耗战。

回执携带机读 `kind`，沿用 PR #947 在 `HardRuleSpec.reasonFor` 上建立的「机读 id 进 reason」惯例。

指引必须**唯一**，不给模型留猜测：`worktree_exists` 按 sidecar 归属分三臂（自己的 → `enter-task-worktree`；别人的 → 显式接手或换 label；读不出 → `list-task-worktrees`）；`branch_exists` 分「目标目录在 / 不在」两子况——目录不在时（`remove-task-worktree` 默认不删分支造成的遗留分支）**不得**指向 `enter-task-worktree`，因为 enter 必撞 `worktree_not_found`，照抄会造第二次空转。

### 6. 认下的残留

外来树 + 无持久化 enter 记录 → 告知面说可写、门禁给 `foreign_worktree`。**不修**。

该错误自带出路（`move this session back to the main repo first`），所以形状是「乐观告知 + 自洽错误」= 一步可恢复；而缺陷 1 的形状是「两句真值相反的话同时在场」= 不可推理。本 ADR 消灭的是后者。

消掉残留要让纯函数读可变门禁状态（per-engine `states` Map）与 session-api 持久化记录，把渲染面耦到状态机上，还要处理波快照时序（§7.2 D2）。用一个可推理的错误换掉纯函数与零耦合，不划算。

## Why not

- **Why not 恢复 auto-provision（ADR-0037 原始 Decision 1）**：操作员要的形状是「拦截 + 告知」，不是替模型自动建。且自动建树会让随口一问的请求也背上建分支建目录的副作用，ADR-0037 两次 superseded 的理由仍然成立。
- **Why not 让判定函数查 host 授权态**：见 Decision 6——纯函数变不纯、渲染面耦合可变状态、波快照时序问题，代价远大于消掉一个自带出路的错误。
- **Why not 只改文案、不抽处境函数**：阶段性的草稿根（若将来触发）会成为第四态，必须经同一个渲染口；内联 if 会长歪成第二份判断，违反 `skill-load-write-root` 合同 1「文案只有一份」的立意。
- **Why not 把 `/tmp` 进程临时事实放进写根段**：该事实属 **bash 面**，而写根段也进只读子代理 prior（ADR-0040 判官面无 bash），对它是纯噪音；且把「哪里能写」与「临时面活多久」揉进一段就是混轴——ADR-0068 刚退休一个混轴（hard-wall 当第二套沙箱），不在旁边新种。故落 bash 工具描述，静态，词汇沿用 ADR-0068 与 `helpers.ts` T3 已定的 `process-temporary` / `not a delivery destination`。
- **Why not 用「这棵树的 owner 是不是我」当可写判据**：会造**反向**新谎。`enter-task-worktree` 四道检查里没有归属，会话可以合法 adopt 外来树并被门禁放行（`if (boundRoot === snapshotRoot) return undefined; // already home`）；按 owner 判定会对这些会话宣告「无可写根」，模型继而建第二棵树，违反 ADR-0037 §2。sidecar 归属的职责是**告知**，不是授权。

## Consequences

### Positive

- 告知面与门禁不再互相打脸；模型的第一个写调用要么成功，要么失败在一个自洽的故事里。
- 回执语义被测试锁住，不能再靠满足子串而空心化。
- 16 个失败 kind 各有一个明确的「谁能解」，结构性死路带停止指令，不再退化成消耗战。
- 零新状态、零新层、不动门禁裁决逻辑、不动围栏 argv。

### Negative / Trade-offs

- `writeRootSegment` 签名变更波及三个生产调用方、worker prior 与 `skill-load-write-root` SC2/SC6（需 amend）。
- 同一 skill 在 ③ 态装配过、之后绑树变 ② 态，再装配字节不同 → 一次 prompt cache miss。这是正确行为的代价（旧字节本来就是错的），不是回归。
- 残留（Decision 6）刻意保留，需在文档里写明，否则会被当成漏修。

### Reversibility

- 三态渲染可退回单态（`writeRootSegment` 忽略处境入参），告知面回到今日形态，门禁与围栏不受影响。
- 可恢复性表可退化为不渲染分类尾句，kind 与 detail 原样保留。
- 两者都不产生持久状态，回退无迁移成本。

## Evidence

- `specs/write-situation-disclosure.md`（本 ADR 的 spec）；SC1–SC12 与输入五类表 A/B。
- 缺陷 1 的代码链：`build-engine.ts:486`（`taskRoot: sandboxRoot`）、`:506`（`liveTaskRoot` 无条件创建）、`skill.ts:73-75` / `hub.ts:2273-2275` / `chat-session.ts:457`（无条件 `read()`）、`skill/body.ts:139-146`（无条件宣告）、`worktree-gate.ts:479-490`（`classifyCall` 判 mutate）+ `:84-91`（`unboundMutateNotice`）。
- 缺陷 2 的漂移对照：`specs/casual-ask-context-hygiene.md:21`（锁定语义）vs `worktree-gate.ts:84-91`（实现）vs `:33`（子串验收）。
- 缺陷 3 的文案现场：`worktree-gate.ts:292`（`branch_exists`）、`:299`（`worktree_exists`）、`:271`（`not_a_git_repo`）。
- 判据复用依据：`worktree-gate.ts:1013`（门禁自己的第一道判断即 `!isTaskWorktreePath(snapshotRoot)`）、`:466-471`（shadow copy 教训）。
