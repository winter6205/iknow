# Plan: task worktree 生命周期

**Goal:** 隔离 ON 时模型一次带名进树、能列出并显式回收、改绑后 grep/glob 仍读得了项目身份根。
**Approach:** 先锁 ADR 命名合同，再把路径反演与 create 的 `name` 同一逻辑落地（不可拆开合），然后 list / enter-by-label / remove，读路径与 include 拷贝不挡进树主路径。TUI 与基线 8 件不动。
**Spec link:** `specs/task-worktree-lifecycle.md`
**Tracker:** GitHub — spec [#869](https://github.com/winter6205/iknow/issues/869)；T1 [#870](https://github.com/winter6205/iknow/issues/870) → T2 [#871](https://github.com/winter6205/iknow/issues/871) → T3 [#872](https://github.com/winter6205/iknow/issues/872) / T4 [#873](https://github.com/winter6205/iknow/issues/873) / T6 [#875](https://github.com/winter6205/iknow/issues/875)；T5 [#874](https://github.com/winter6205/iknow/issues/874)；T7 [#876](https://github.com/winter6205/iknow/issues/876)；T8 [#877](https://github.com/winter6205/iknow/issues/877)。blocking 已用 `addBlockedBy` 接线。
**ACR:**

```
bounded-context-guardian: yes — 命名与反演留 isolation/session-api 既有 SSOT；ACI 只加条件家族成员，不新切 technical-layer 目录，不让 worker 持 provision 缝
defensive-contract-validator: yes — spec 覆盖空/非法 name、撞名、foreign 树、脏 remove、幂等 create、git 不可用 typed；实施测须含 empty/negative/overflow/concurrent/exception
error-handling-enforcer: yes — 沿用 WorktreeIsolationError typed kind；非法 slug 不抛、写进 tool_result；失败不写主仓
complexity-anti-drift: yes — 反演是单一纯函数；各工具继续薄委托 host 缝，不把 git/list/remove 逻辑堆进一个 handler
minimal-change-verifier: yes — 计划按 tracer 拆 commit；T2 命名反演与 T3 create `name` 必须同一逻辑任务合入，禁止「先写出 slug 叶子、ownerOf 仍整段当 id」的中间态
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch  
（整轮代码收尾再跑 code-review，不在每张票重复。）

## 待写入

- CONTEXT：`task worktree label`、`worktreeinclude`；`session worktree rebind` / `worktree isolation mode` 补 list、remove、可选 `name`
- ADR-0037 §3 amendment（T1）

## Tasks (ordered by dependency)

1. **ADR-0037 命名合同 amendment** — tag: `[decision]`
   - **Inherits:** spec Architectural Constraints：门禁与不自动 provision 不改；§3 叶子改为可选 label + `--` + conversationId；反演纯路径；自动孤儿清理仍非目标
   - **Surface:** `docs/adr`
   - **Acceptance:** ADR-0037 有 accepted amendment 写明新叶子形状、无 `--` 兼容档、label 不参与归属裁决、新增 list/remove 工具面
   - Status: [ ] pending

2. **路径与反演 SSOT + 往返不变量** — tag: `[implementation]`
   - **Inherits:** spec Contract 命名 1–5（`taskWorktreeOwnerOf` 取最后 `--` 后缀；非法 slug 不进路径）
   - **Surface:** harness isolation（命名函数与今日七个消费点共用同一反演）
   - **Acceptance:** 对安全 id ×（合法 slug ∪ 缺席），`ownerOf(path(root,id,slug)) === id` 且 `mainCheckoutOf` 仍回到主 checkout；无 `--` 的历史叶子仍整段为 id
   - [blocks: T1]
   - Status: [ ] pending

3. **create-task-worktree 可选 name + 实际路径回写** — tag: `[implementation]`
   - **Inherits:** spec 进树 6–8：hint 仍叫 `create-task-worktree`；非法 name 不抛；下一波再写
   - **Surface:** harness ACI create 工具 + provision 缝透传 label
   - **Acceptance:** 合法 name 建 `<slug>--<uuid>` 并改绑；非法 name 建纯 uuid 叶子且 tool_result 含原因与实际 path；同会话二次调用不第二次 `worktree add`
   - [blocks: T2]
   - Status: [ ] pending
   - 注：与 T2 若分 PR，中间不得出现「磁盘已是 slug 叶子、ownerOf 未升级」

4. **list-task-worktrees** — tag: `[implementation]`
   - **Inherits:** spec 发现 10：只读、不进 ROOT_FLIP、缝缺席不注册、append-only 名单
   - **Surface:** harness ACI registry（与既有三件同条件化）
   - **Acceptance:** 缝在场可列出本仓 task 树（含 label 与 conversationId）；worker / 开关 OFF 工具面无此名；`include_stale` 能标出无活树的 `iknow/task*` 分支
   - [blocks: T2]
   - [parallel] 与 T3
   - Status: [ ] pending

5. **enter 按 label 或 conversationId** — tag: `[implementation]`
   - **Inherits:** spec 11：不收自由路径；label 歧义 typed 失败
   - **Surface:** harness ACI enter 工具
   - **Acceptance:** list 给出的唯一 label 可进入对应树；两棵同 label 时失败并带上两个 conversationId
   - [blocks: T3, T4]
   - Status: [ ] pending

6. **remove-task-worktree + 操作员 gc** — tag: `[implementation]`
   - **Inherits:** spec 回收 12–13：当前根/脏树拒绝；默认不删分支；gc 默认 report-only
   - **Surface:** harness ACI + repo `scripts/`
   - **Acceptance:** 当前根 remove 失败；干净且已 exit 的树可 remove；无 `--apply` 时 gc 不改 git；分类不是 workspace mutate、不进 ROOT_FLIP
   - [blocks: T2]
   - [parallel] 与 T4
   - Status: [ ] pending

7. **改绑后 grep/glob 读 projectIdentityRoot** — tag: `[implementation]`
   - **Inherits:** spec 14：只扩父会话只读；写主仓仍拦
   - **Surface:** harness isolation / sandbox 放行（与今日 read_file 身份根放行同一闸）
   - **Acceptance:** 隔离 ON 且已改绑时，grep 与 glob 能命中身份根上的项目文件；对该根 write_file 仍 block
   - [blocks: T1]
   - [parallel] 与 T2
   - Status: [ ] pending

8. **建树后 worktreeinclude 拷贝** — tag: `[implementation]`
   - **Inherits:** spec 9：缺文件不失败建树；只拷匹配且 gitignored
   - **Surface:** session-api / isolation provision 成功路径（建树已成功之后）
   - **Acceptance:** 身份根有 include 且列出被 ignore 的 `.env` 时，新树根出现该文件；无 include 文件时建树仍成功且不拷
   - [blocks: T3]
   - Status: [ ] pending

## Code review phase

全部 tracer 合入后对整轮 diff 跑 code-review，再 verification-before-completion。
