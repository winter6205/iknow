# Plan: 文件系统隔离两档（默认全局）

**Goal:** 默认 bash 按宿主真路径读写（权限 + hard-wall 仍拦），会话草稿只有一条宿主路径，不再把垫底 bind 成 `/tmp`。
**Approach:** Round 1 先改默认姿态和 tmp 命名（能消 dual name）；Round 2 再做工作区档与 `/config`。不混 grep 那条线，不改 PermissionMode。
**Spec link:** `specs/fs-isolation-modes.md`
**Worktree:** `.iknow/worktrees/fs-isolation-modes` on `feat/fs-isolation-modes`
**ACR:** all-yes（见下）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion（landing grain: operator global commit section）

```
bounded-context-guardian: yes — FS 档落 sandbox；权限仍在 permission/；worktree 门禁不搬家；会话 tmp 仍会话文件夹布局
defensive-contract-validator: yes — Round 1 写路径五类表见 spec；workspace 越界写留 Round 2
error-handling-enforcer: yes — 垫底不可写 typed；工作区越界写 typed；hard-wall 不吞；无静默降级成裸跑
complexity-anti-drift: yes — 一档一位工厂（全局 vs 工作区），不把权限链折进 bwrap argv
minimal-change-verifier: yes — Round 1 默认全局+去 bind；Round 2 工作区+/config 独立收尾不混 commit
```

**两轮:** Round 1 = T1–T5；Round 2 = T6–T8（Round 1 合入后再开）。

## 待写入

（已 flush：ADR-0092；CONTEXT 文件系统隔离档 / 全局档 / 工作区档 / 会话 tmp / 闭世界修订 / flagged。0037/0074/0068 superseded 句仍属 T1。）

## 背景（本轮讨论事实）

- 权限模式问不问人；文件系统隔离管进程能碰哪些路径。两层，不是一档里把 home 藏掉。
- 默认要 **全局档**：真路径读写，权限正常拦截。
- **工作区档**（后做）：读偏宽；写 = 项目 workspace（活 taskRoot）+ 会话 tmp；home 其余默认不能写。
- 现行闭世界：home 不可见，可写 = taskRoot + `/tmp`，才必须把会话垫底 bind 成 `/tmp`。
- 对齐后两档都用同一条宿主会话 tmp；工作区只是少了「写整个 home」，不再藏、不再挂。

> Contradicts ADR-0037 §9「全档位闭世界、可写集 = taskRoot + /tmp」— worth reopening because 默认要把 home 当真路径，闭世界不能再当默认姿态。
> Contradicts ADR-0074「bind 成该身份围栏的 `/tmp`」— worth reopening because dual name 是藏 home 逼出来的，不是垫底寿命本身。
> Contradicts ADR-0068「闭世界是 bash 唯一物理沙箱」字面 — 围栏仍在（网络/env/rlimit + 工作区档 FS），但默认 FS 不再是否认 home。

## Tasks (ordered by dependency)

1. **T1 决策落盘：ADR-0092 + 0037/0074/0068 amendment 指针** — tag: `[decision]`
   - **Inherits:** spec Objective / Changes；操作员已确认默认全局、工作区 home 默认不能写、对照名不入库。
   - **Surface:** `docs/adr/`、`docs/CONTEXT.md`（词条由 persist 先写；本票补 0037/0074/0068 的 superseded 句，避免与 0092 双源）。
   - **Acceptance:** ADR-0092 已在树内；本票补 0037 §9 / 0074 / 0068 的 superseded 句，避免与 0092 双源。独立 docs commit，不与围栏代码混合。
   - Status: [ ] pending
   - [parallel]

2. **T2 默认全局：FS 策略不再藏 home** — tag: `[implementation]`
   - **Inherits:** spec SC1、SC5–SC8；沙箱纪律；不卸 bwrap 进程、不放开网络。
   - **Surface:** sandbox（fs-policy / bwrap）+ bash 装配。
   - **Acceptance:** 默认档 `ls` home 成功；mutating bash 仍走 permission；hard-wall 夹具仍拦；isolation ON 未绑树写主仓仍拦。复杂度门见 `complexity-anti-drift`。
   - Status: [ ] pending
   - [parallel]

3. **T3 会话 tmp 真路径：去掉 `/tmp` bind** — tag: `[implementation]`
   - **Inherits:** spec SC2、SC3、SC4、SC10；`parent-visible-tmp` 每身份一块、父按 id 读。
   - **Surface:** sandbox tmp 装配、bash `$TMPDIR`、写工具可写集。
   - **Acceptance:** 无垫底→`/tmp` bind；`$TMPDIR` = 宿主会话 tmp；`write_file` 能写该绝对路径且不进 taskRoot；父子垫底仍隔离；`write_file("/tmp/…")` 一种语义测死（拒绝或 OS `/tmp`，禁止静默双写）。S2 五类见 spec 表。
   - Status: [ ] pending
   - [blocks: T2]

4. **T4 探针与闭世界默认断言改写** — tag: `[implementation]`
   - **Inherits:** spec SC9；既有 `scripts/sandbox-probe*` / `tests/harness/sandbox` 认证的不变式「等价或更强」。
   - **Surface:** sandbox 测试与 verify 探针。
   - **Acceptance:** 默认档不再断言 home 不可见；`npm test` 与 `npm run typecheck` 退出 0。工作区档断言可 skip 或标 Round 2。
   - Status: [ ] pending
   - [blocks: T3]

5. **T5 规格面跟名（parent-visible-tmp / mutate-write / security-guardrails / STATUS / architecture）** — tag: `[implementation]`
   - **Inherits:** spec Amends；CONTEXT 已有「会话 tmp」。
   - **Surface:** `specs/` 活跃文 + `docs/STATUS.md` + `docs/architecture.md` 沙箱句。
   - **Acceptance:** 活跃 spec 不再把默认可写集写成 `taskRoot + /tmp` bind；`specs/README.md` 已链本 spec。无第三产品名。
   - Status: [ ] pending
   - [blocks: T1, T3]

6. **T6 [decision] 工作区档白名单（Round 2）** — tag: `[decision]`
   - **Inherits:** spec SC11–SC13；读白名单可复用 0037 §9.2 的「可见」而不是「不可见」。
   - **Surface:** ADR-0092 amendment 或 0037 §9 工作区条款。
   - **Acceptance:** 写死：读 home；写 = taskRoot ∪ 会话 tmp；越界 typed。开关字段名实施可定，须用户层 settings（项目文件不得自授更宽写）。
   - Status: [x] done（`900f042a`） —— ADR-0092 Amendment 2026-09-13 写死围栏 argv 合同；spec SC11–SC13 细化
   - [blocks: T5]

7. **T7 工作区档围栏** — tag: `[implementation]`
   - **Inherits:** T6；spec SC11–SC12。
   - **Surface:** sandbox fs-policy 第二档。
   - **Acceptance:** 工作区档读 home 成功、写 home 非白名单失败且不落盘；会话 tmp 真路径仍可写。S2：empty/negative/overflow/concurrent/exception 覆盖越界写。
   - Status: [x] done（本 PR） —— `src/harness/sandbox/fs-mode.ts` 值域 + `bwrap.ts` 挂载序（`--ro-bind home` → `--bind taskRoot` → `--bind 会话 tmp`）；home 缺失 typed fail-loud 不静默降级。MCP 实测：home 读 OK / home 写 EROFS 且宿主不落盘 / `$TMPDIR` 落 `<sessionFolder>/fence-tmp`
   - [blocks: T6]

8. **T8 TUI `/config`（或等价）切档** — tag: `[implementation]`
   - **Inherits:** spec SC13；默认全局。
   - **Surface:** TUI 配置面 + settings 读口。
   - **Acceptance:** 能从全局切到工作区；新会话缺省全局；权限模式控件不被这个开关替换。
   - Status: [x] done（本 PR） —— settings `isolation.fsMode`（用户层）+ TUI/chat `/config fs global|workspace`；holder 就地翻转、下一次调用生效。MCP 实测：同会话同命令 workspace 档 EROFS → 切 global 后 `TOUCH_OK`；Shift+Tab 权限轮独立（Default→Auto）；非法参数 usage 且不改档；settings 双向回写
   - [blocks: T7]

## 收尾

Round 1 全部落地后一整轮 code-review 对照 spec SC1–SC10。Round 2 另开 review。不与 `feat/grep-wave-survive` 混 commit。
