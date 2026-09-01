# Plan: worktree isolation model provision

**Goal:** 开关 ON 时拦住主仓 mutate；模型调用 ACI 建树工具完成建树与会话根改绑；路径切好后模型自己接着写；子代理跟父会话同一棵树；缺 rules 目录不得让 worker 退出。
**Approach:** 先把 ADR-0037 / 说明书读法写进合同，再修 worker 缺目录 fatal，再把门禁从「拦写并自动建树」改成「只拦、等工具」，然后上 ACI 建树工具与改绑，最后钉子代理继承根与父代理 rules 按需读。不写 commit→PR 向导，不改开关默认 OFF。
**Spec link:** none — 合同来自 [worktree isolation：拦住 → 模型建树工具 → 自己继续 → 树内正常工作](https://github.com/winter6205/iknow/issues/829) Decisions so far；操作员选择跳过独立 spec、直接本计划。
**Tracker:** GitHub `ready-for-agent` 每 bullet 一票；本文件为切片 SSOT。地图 #829。
**Map:** https://github.com/winter6205/iknow/issues/829
**ACR:** PASS（2026-08-30，见下文）。
**Plan closeout (2026-09-01):** T1–T8 均已落地（GitHub #836–#841 closed）。本文件勾选与 HEAD 祖先 SHA 对齐；子代理继承根另见本分支 `af7624e6` envelope 断言。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch；整轮改动收尾再 code-review（非每票重复）。

> Contradicts ADR-0037（ON：首次 mutate 拦截后由 host `git worktree add`）— worth reopening because 建树改为模型调用 ACI 工具；门禁只拦不自动建树。
> Contradicts ADR-0009 D2（静态层 AGENTS.md+rules 会话开始整段注入）— worth reopening because 父代理 rules 改为需要时再读；干活子代理仍开场注入已有文件。

## 待写入（T1 落盘；本计划提交不刷 CONTEXT/ADR）

- 修订 ADR-0037：ON 时 mutate 拦到 ACI 建树工具成功改绑为止；成功 = 树在且会话根已切到该路径；Host 不做同波重放被拦的写；主仓物理路径不切；项目相对读路径不改写到主仓绝对路径；同名树 typed 错误、不覆盖。
- 说明书读法写入 CONTEXT：缺目录/文件视为空；父代理不强制整段灌 rules；general-purpose 开场注入已有 AGENTS.md 与 `.iknow/rules/*.md`；explore 不注入；硬约束走权限。
- 候选术语：创建工作树 ACI 工具（模型可见；内部仍走既有 provision 缝）。

## 合同（开关 ON）

```text
读路径 → 放行（相对路径不改写到主仓绝对路径）

写路径
  → 已绑定本会话 task worktree → 放行
  → 否则拦住（不自动 git worktree add）
       → 模型调用 ACI 建树工具
       → provision + session worktree rebind
       → 模型在新根上自己再调被拦的写
```

**硬要求**

1. 开关默认 OFF；OFF 与今日一致。
2. 建树必须改绑本会话；只建树不改绑不合格。
3. 改绑只影响本会话。
4. 工具成功后 Host 只保证路径已切；不在同波偷偷执行被拦 mutate；不要求操作员 `/continue`。
5. 同名 task worktree / 分支已存在：typed 错误给模型；不覆盖、不复用归属不明的树。
6. 建树/改绑失败：typed 可见错误；主仓零写入。
7. 子代理继承父会话改绑后的根。
8. `~/.iknow/rules` 与项目 `.iknow/rules` 不存在视为空；worker 不得因此退出。
9. 父代理不强制整段灌 rules；干活子代理开场注入已有说明书；explore 不注入。
10. 硬约束走权限层。

**明确非本计划**

- commit → push → PR 产品向导
- 默认把开关改成 ON
- product workspace 多根
- 孤儿 worktree 自动删除
- MCP 双根（已另修复）

## ACR

```
bounded-context-guardian: yes — 建树工具落 ACI 注册表；provision/rebind 留在 session-api；mutate 门禁留在 harness isolation；缺目录与说明书装配留在 memory/subagent worker；不新开技术分层目录。
defensive-contract-validator: yes — 空（缺 rules 目录）、否定（未改绑仍拦写）、溢出（同名树）、并发（同会话建树幂等）、异常（git/改绑失败 typed、主仓零写入）均在硬要求与对应 bullet 验收。
error-handling-enforcer: yes — 同名树、建树失败、改绑失败走 typed 非空出口；缺目录是跳过不是 throw；禁止空 catch 放行写主仓。
complexity-anti-drift: yes — 流水线为拦 → 工具 → 改绑 → 模型再写；worker 缺目录短路为空；每 bullet 一层结果，无新抽象层意图。
minimal-change-verifier: yes — 单一逻辑任务（模型建树并切路径后继续写）拆 T1–T6 各一 commit；PR 向导/默认 ON/多根/自动删树列为非目标。
OVERALL: yes
```

## Tasks (ordered by dependency)

1. **Record model-provision isolation contract** ([T1](https://github.com/winter6205/iknow/issues/836)) — tag: `[decision]`
   - **Inherits:** 上文合同与硬要求 1–10；地图 #829 Decisions so far
   - **Surface:** `docs/adr/` + `docs/CONTEXT.md`
   - **Acceptance:** ADR-0037 修订为「拦写、ACI 工具建树、改绑后模型自己再写」；CONTEXT 写明说明书读法与缺目录视为空；本 bullet 不含运行时代码
   - Status: [x] done — `9b4e4612` ADR-0037 model-provisioned 修订 + CONTEXT；issue #836 closed.

2. **[parallel] Missing rules directory is empty, not fatal** ([T2](https://github.com/winter6205/iknow/issues/837)) — tag: `[implementation]`
   - **Inherits:** 硬要求 8
   - **Surface:** harness memory discovery / subagent worker 启动装配
   - **Acceptance:** 用户级与项目级 `.iknow/rules` 目录不存在时，general-purpose worker 能跑完一次 spawn 并交出信封，stderr 无 `[subagent-worker] fatal` / `scandir` 该类 ENOENT；不要求操作员先 mkdir
   - Status: [x] done — `91b756af`；`tests/subagent/rules-missing-dirs.test.ts` 本工作树复跑绿；issue #837 closed.
   - [blocks: T1]
   - [parallel]

3. **[parallel] Mutate gate blocks without auto-creating a worktree** ([T3](https://github.com/winter6205/iknow/issues/838)) — tag: `[implementation]`
   - **Inherits:** 合同「否则拦住（不自动 git worktree add）」；硬要求 1、6
   - **Surface:** harness isolation 门禁
   - **Acceptance:** ON 且尚未改绑时，mutate 被拦且**不**调用 `git worktree add`；错误可见、主仓无新写入；文案指向调用建树工具而非「end the turn and retry」自动建树协议
   - Status: [x] done — `ea6ba8d3`；issue #838 closed.
   - [blocks: T1]
   - [parallel]

4. **ACI tool creates the task worktree and rebinds the session** ([T4](https://github.com/winter6205/iknow/issues/839)) — tag: `[implementation]`
   - **Inherits:** 硬要求 2–6；工具成功 = 树已在且会话根已切到该路径
   - **Surface:** harness ACI 工具集 + session-api provision/rebind
   - **Acceptance:** 模型可调用该工具；成功后本会话后续 mutate 进入 task worktree；同名树/分支 → typed 错误且不覆盖；失败 → 主仓零写入；被拦的写由下一模型回合再调，Host 不同波重放
   - Status: [x] done — `1d05d54f` create-task-worktree + 会话改绑；issue #839 T4 closed.
   - [blocks: T3]

5. **[parallel] ACI tool enters an existing task worktree and rebinds the session** ([T7](https://github.com/winter6205/iknow/issues/839)) — tag: `[implementation]`
   - **Inherits:** 硬要求 2–6；工具成功 = 会话根已切到既有 task worktree（含他人树）
   - **Surface:** harness ACI 工具集（enter-task-worktree）+ session-api provision/rebind（host worktreeEnter 缝 + provision adoption）
   - **Acceptance:** 模型可调用该工具（只收 owner conversationId，过 segment-safety 闸；目标路径由 SSOT `taskWorktreePath` 派生，不收自由路径）；目标不存在 → typed `worktree_not_found`，非本仓 linked worktree / 调用方已在树内 → typed `foreign_worktree`，unsafe id → typed `rebind_failed`（任何 fs/git 访问之前）；成功 = 仅本会话改绑到目标树（主仓零写入、worktree list 不变、树内容零污染），经 dirty-root conditionalSave 持久化；改绑的持久记录（`session.workspaceRoot` === 引擎 task-worktree 形状根）即 provision 的 adoption 锚 —— 重启后该会话在他会话树上的 mutate 被放行（显式进入语义）；无持久锚的外来根维持 `foreign_worktree` fail-closed；门禁本体零改动；worker / TUI(仅 provision) 工具面缺席有钉子
   - Status: [x] done (commit `feat(harness): enter-task-worktree ACI tool with durable adoption anchor`)
   - [blocks: T3, T4]
   - [parallel]

6. **[parallel] ACI tool exits the task worktree back to the main repo root, tree preserved** ([T8](https://github.com/winter6205/iknow/issues/839)) — tag: `[implementation]`
   - **Inherits:** 硬要求 2–6；exit = 改绑回主仓根，树保留不删（孤儿树自动删除仍是明确非目标）
   - **Surface:** harness ACI 工具集（exit-task-worktree）+ session-api provision/rebind（host worktreeExit 缝）
   - **Acceptance:** 模型可调用该工具（无参数）；当前未改绑（无 bound 条目且持久锚与引擎根均非树形状）→ typed `rebind_failed`；成功 = 仅本会话根回到主仓（主仓根由树经 `git rev-parse --path-format=absolute --git-common-dir` 派生，重启安全、不依赖进程内状态），经 dirty-root conditionalSave 持久化后下一回合门禁在主仓重新武装（拦 + ACI 工具文案）；`git worktree list` 计数不变（树与其分支保留）；失败 → 主仓零写入；worker / TUI(仅 provision) 工具面缺席有钉子
   - Status: [x] done (commit `feat(harness): exit-task-worktree ACI tool for symmetric return to the main repo root`)
   - [blocks: T7]
   - [parallel]

7. **Subagents inherit the rebound session root** ([T5](https://github.com/winter6205/iknow/issues/840)) — tag: `[implementation]`
   - **Inherits:** 硬要求 7、9（explore 不注入说明书；general-purpose 开场注入已有文件）
   - **Surface:** harness subagent worker / spawn
   - **Acceptance:** 父会话已改绑后 spawn 的子代理 cwd/sandbox 在同一 task worktree；general-purpose 在说明书文件存在时注入其内容；explore 不注入项目 AGENTS.md 正文
   - Status: [x] done — `d030ec67`；本分支补强 `af7624e6` rebound `sandboxRoot` 信封断言 + `tests/harness/build-engine-subagent-spawn-root.test.ts` 复跑绿；分裂根 worker 注入钉在 `tests/subagent/worker.test.ts`「改绑分裂根」；issue #840 closed.
   - [blocks: T2, T4]

8. **Parent does not dump all rules bodies at session start** ([T6](https://github.com/winter6205/iknow/issues/841)) — tag: `[implementation]`
   - **Inherits:** 硬要求 9–10
   - **Surface:** harness identity / memory 静态层装配（chat / tui / serve 父会话）
   - **Acceptance:** 父会话 system 不因存在多份 `.iknow/rules/*.md` 而把全部正文灌进开场上下文；模型仍可用读路径打开其中一份；无 rules 时会话正常开始
   - Status: [x] done — `29bf1bb2`；`tests/harness/memory/assembly.test.ts`「does not dump rule bodies…」本工作树复跑绿；issue #841 closed.
   - [blocks: T1]
   - [parallel]
