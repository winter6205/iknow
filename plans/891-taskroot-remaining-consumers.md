# Plan: 改绑后 taskRoot 剩余消费点（围栏 + 模型可见面）

**Goal:** worktree isolation ON 且会话已 rebind 之后，bash 物理上不能再写主仓，模型（含子代理）能看见当前写根是活 `taskRoot`，且不破坏 T9 的 system KV 缓存契约。
**Approach:** 不新造第五根。写根继续是 `SessionRoots.taskRoot`。先把 ADR-0037 §4「写仍不得进主仓」落到 bash 围栏（home 可写祖先之后后挂身份根 `--ro-bind`），再让 worker prior / path-outside 回执说出这根。hard_wall `cat` 误杀与 label discard 不在本计划。
**Spec link:** `docs/adr/0037-worktree-isolation-on-mutate.md` §4 / §7；`docs/CONTEXT.md` 词条 `taskRoot` / `SessionRoots` / `子代理根归属`；`specs/task-worktree-lifecycle.md`；issue #891。
**ACR:** **PASS**（2026-09-05，`architecture-change-reviewer-agent` 第三轮；前两轮 BLOCKED 已由下列 T1–T3 表面冻结 + 五类边界 + fail-loud EXIT 消化）。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch。全部 bullet 落地后再跑一轮 `code-review`。

> **Tracker 路径：本地 markdown（fallback）。** 理由：操作员要求「开 worktree + 写 plan，去另一会话实施」，未授权把 #891 拆成 `ready-for-agent` GitHub issue。父跟踪是 issue #891。
>
> **本计划的 headroom：** 钉切片形状与不变量，不钉补丁。除已被代码冻结的名字（`taskRoot` / `projectIdentityRoot` / `createBwrapFence` / `createBashTool`）外，文件内 helper 拆分留给实施方。

---

## 1. 病因（已实测，不是假设）

**根因（一句话）：** 改绑后 JS 写工具问活 `taskRoot`，bash 围栏的 cwd 也问它，但 `--bind $HOME $HOME` 后挂且可写，主仓若在 home 下就被罩住；同时模型看见的 `## Project path` 仍是 `projectIdentityRoot`，活 `taskRoot` 只进人读 `env_snapshot`。

**复现命令**（2026-09-05，本会话，exit 0）：用真实 `createBwrapFence` + `spawnSync`，`cwd=taskRoot`，`home` 为含 `projects/iknow` 的假 home。

| 观察                                                | 结果                                          |
| --------------------------------------------------- | --------------------------------------------- |
| `classifyCall(mkdir -p $identity/archive/.tmp)`     | `"mutate"`（#891 P2「分类漏了 mkdir」不成立） |
| `classifyCall(cat a b > raw.txt)`                   | `"mutate"`                                    |
| `isDangerousCommand("cat a b > raw.txt")` 单行      | `false`                                       |
| 同上，命令含换行 / `dd if=`                         | `true`（P1 真因，本计划不修）                 |
| argv：`--bind $HOME` 下标 31 > `--bind cwd` 下标 28 | home 后挂                                     |
| 身份根 `--ro-bind`                                  | 缺席                                          |
| `mkdir -p $identity/archive/.tmp`                   | **exit 0，目录落到「主仓」**                  |
| `mkdir -p ./in-tree`（相对 taskRoot）               | exit 0，落在树上（合法）                      |

**支撑代码：**

- 门禁已覆盖 mkdir：`tests/harness/isolation/worktree-gate.test.ts` `expect(mutate("mkdir d")).toBe("mutate")`
- home 后挂：`src/harness/sandbox/bwrap.ts` `bindArgs` 非 `cwdReadonly` 分支
- `cwdReadonly` 已有「可写祖先不能盖住后挂子挂载」纪律，隔离改绑未复用
- bash 工厂未收 `projectIdentityRoot`：`src/harness/aci/tools/registry.ts` bash vs `read_file` 517–522
- 前台 `bash.ts` 与后台 `defaultBackgroundSpawn` 都调 `createBwrapFence`；verify 的 `sandbox-run.ts` 本轮不传 overlay
- system Project path 钉身份根：`src/harness/identity/assemble.ts` `projectPathSegment`；`env_snapshot` 注释写明不进 messages
- `write_file` 已用 `resolveWithinRoot(taskRoot)` 拦主仓路径，文案不含 remap：`helpers.ts`

**范围外（#891 其余项，禁止顺手修）：** P1 hard_wall；P3 label schema；verify 围栏 overlay；manager 静默改写 spawn `task` 正文。

---

## ACR

```
bounded-context-guardian: yes — no fifth root; overlay is a createBwrapFence option --ro-bind of SessionRoots projectIdentityRoot after writable home (bwrap.ts:101), not an FsPolicy write slot; T3 keeps ## Project path on assemble.ts:503-509 and write root = envelope sandboxRoot (ADR-0037 §4:62).
defensive-contract-validator: yes — T2 allocates all 5 classes: empty (ON+rebound identity blank → typed fail, no spawn), negative (mkdir -p $identity/archive/.tmp non-zero), overflow (identity under $HOME, overlay last vs bwrap.ts:101 homeBind), concurrent (fg bash.ts:177 and bg manager.ts:247 same overlay token), exception (missing-on-disk fail-loud, not optionalHostRoBindArgs bwrap.ts:24-27 skip).
error-handling-enforcer: yes — missing/blank identity is fail-loud ToolExecutionError like pathForHome (bwrap.ts:67-70), never existsSync omit; OFF/unbound leaves the option absent (sandbox-run.ts:49 stays today); T3 keeps typed helpers.ts:72-73 with no task-text rewrite.
complexity-anti-drift: yes — overlay is a sibling fence option mirroring cwdReadonly (bwrap.ts:45-52,102-107,137-139); T9 system bytes stay in projectPathSegment; T3 injects via worker prior messages (worker.ts:556-559), not a god-handler.
minimal-change-verifier: yes — T2 is one fence-overlay commit: registry.ts:492-506 threads projectIdentityRoot like read_file at 517-522, consumed by bash.ts:177 and manager.ts:247; T3 frozen to helpers.ts:72-73 plus worker messages (worker.ts:556-559), not create-task-worktree.ts:115-118.
```

**affects（实施时不得超出；T1 另含 ADR 文件）：**

- `src/harness/sandbox/bwrap.ts`
- `src/harness/aci/tools/bash.ts`
- `src/harness/aci/tools/registry.ts`
- `src/harness/background/manager.ts`
- `src/harness/aci/tools/helpers.ts`
- `src/harness/subagent/worker.ts`（prior messages 注入；envelope 若需字段则同模块）
- `docs/adr/0037-worktree-isolation-on-mutate.md`
- 对应测试（实施方自选布局，Acceptance 不发明路径）

---

## 待写入（由 T1 落地，本规划会话不 flush）

- ADR-0037 短 amendment：隔离 ON+rebind 时 bash 围栏后挂身份根只读；缺根 fail-loud；OFF/未改绑 argv 不变。
- `docs/CONTEXT.md` 词条 `taskRoot`：补一句「改绑后模型经 worker prior / path-outside 回执看见写根；system Project path 仍是身份根」。不新增词条。

---

## Tasks (ordered by dependency)

1. **记下围栏 overlay 与模型可见面合同** — tag: `[decision]`
   - **Inherits:** ADR-0037 §4「写仍不得进主仓」+ 身份根只读行；§7.3 稳定根清单不活化；T9 / `projectPathSegment` 不把活 `taskRoot` 写入 system；CONTEXT `taskRoot`「写与工具 cwd 只问它」；CONTEXT `子代理根归属`（执行臂，共享父 `taskRoot`）。
   - **Surface:** `docs/adr/0037-worktree-isolation-on-mutate.md` amendment + `docs/CONTEXT.md` `taskRoot` 一句。
   - **Acceptance:** amendment 写明：(a) overlay 条件 = isolation ON 且 `taskWorktreeOwnerOf(taskRoot)` 有主；(b) `--ro-bind projectIdentityRoot` 在 writable home bind **之后**；(c) 身份根缺席/空白/盘上不存在 → typed 可见错误、不 spawn，禁止 `existsSync` 跳过；(d) OFF 或未改绑 → 不传 option，argv 与今日逐字节一致；(e) 模型写根走 append-only / tool_result / worker prior，不改 system Project path，不静默改写 spawn `task` 正文。commit 无产品代码。
   - Status: [ ] pending

2. **改绑后 bash 围栏不能写主仓** — tag: `[implementation]`
   - **Inherits:** T1 (a)–(d)；`cwdReadonly` 已证明的后挂覆盖祖先纪律；registry 已把 `projectIdentityRoot` 传给 read_file，bash 对称接入；前台与后台必须同一 overlay token（CONTEXT 沙箱纪律：前后台共用围栏）。
   - **Surface:** `sandbox` 的 `createBwrapFence` + `aci/tools` bash 工厂/handler + `background` `defaultBackgroundSpawn`。`verify/sandbox-run.ts` 本轮不传 option。
   - **Acceptance:** 五类均可观察：empty = ON+rebind 但身份根空白 → typed fail、不 spawn；negative = `mkdir -p $identity/archive/.tmp` 非 0 且目录不出现；overflow = 身份根是 `$HOME` 子目录时 overlay 仍挡住（复现 2026-09-05 泄漏）；concurrent = 同一 rebound 波次前台与后台 argv 都含身份 `--ro-bind`；exception = 身份路径盘上不存在 → typed fail-loud 而非省略 bind。OFF/未改绑：相对 cwd 的 mkdir 仍成功；`createBwrapFence` 不传 overlay 时 argv 不含身份 `--ro-bind`。
   - [blocks: T1]
   - Status: [ ] pending

3. **模型与子代理看见写根，写错时一次纠正** — tag: `[implementation]`
   - **Inherits:** T1 (e)；ADR-0040 子代理继承父生效根；`create-task-worktree` 成功回执已含 `worktreePath`（本轮不改该工具）；`priorMessagesFromEnvelope` 已是 worker 的 prior 注入点。
   - **Surface:** `helpers.ts` 的 path-outside 文案；`subagent/worker.ts` prior messages（必要时 envelope 加只读字段，仍在 subagent 模块）。
   - **Acceptance:** 隔离改绑后，worker 在跑工具前能在 messages 里读到当前写根 = envelope `sandboxRoot`（= 活 `taskRoot`），且 system `## Project path` 字节仍是 `projectIdentityRoot`。`write_file` / 同类 resolve 对主仓绝对路径仍拒绝，文案含写根，使相对路径可重试。spawn `task` 正文不被 manager 改写。
   - [blocks: T1]
   - Status: [ ] pending

T2 与 T3 互不阻塞，可 `[parallel]`；都依赖 T1。

---

## 收尾

全部 bullet 落地后：`npm run typecheck` + 本计划 Acceptance 点名行为的窄测 + `verification-before-completion` + 一轮 `code-review`。不要在本分支修 P1/P3。
