# Plan: global user profile (persona stays at home)

**Goal:** `user.md` / `BOOTSTRAP.md` / identity `state.json` 永远只在全局 `~/.iknow/`（测试缝 = `userHome`）一份；`--workspace-root` 与项目 `.iknow/` 不再种、不再读画像。
**Approach:** 先用 ADR 推翻 ADR-0019 D1.4，再把 seed 与 assemble 的物理根从 `workspaceRoot` 改回 `userHome`，入口层停止把 cwd 传进 identity init。不自动删除已误种在项目里的文件。memory / sessions / settings fallback 仍跟 workspaceRoot。
**Spec link:** `specs/196-identity-assembly.md`（A8 / 首启引导 + user.md）；`docs/adr/0019-workspace-root-per-root-state-decoupling.md` D1.4（本计划矛盾并 supersede）。
**Tracker:** GitHub（origin `winter6205/iknow.git`，label `ready-for-agent`）。
**ACR:** all-yes（block 已用 commit 切片消解）

```
bounded-context-guardian: yes — persona 留在 identity + home 锚；workspaceRoot 继续只服务 memory/sessions/settings/serve data；不新建技术层目录，不把画像读路径留在 workspaceRoot 上。
defensive-contract-validator: yes — T2 覆盖 empty（缺 user.md 跳过段）/ negative（cwd 项目不得出现 user.md）/ overflow（超长 userHome → typed/warn 不炸引擎）/ concurrent（双 init 幂等）/ exception（不可写目录 → Safe warn，装配继续）。
error-handling-enforcer: yes — 沿用 IknowIdentityError 判别联合与 initIknowWorkspaceSafe warn-不阻塞；assemble 读失败 skip+warn；不引入空 catch 或 magic string 错误码。
complexity-anti-drift: yes — 不新增模块、不把 workspace 解析再包一层 god helper；只改身份文件的物理根与调用方传参；结构保持 identity seed vs per-root ops 两锚。
minimal-change-verifier: yes — 决策 / 代码+测试 / 产品文档 三 commit 切片，禁止把 ADR 与行为改动、CHANGELOG 与 seed 逻辑混在同一 commit。
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on `worktree-global-usermd`

**Out of scope:** 删除用户磁盘上已有的 `<cwd>/.iknow/user.md`；改 `iknowWorkspaceRoot()` 对 memory 的 cwd 默认；host-init / settings merge / ADR-0019 D1.1–D1.3 / D1.5。

> Contradicts ADR-0019 D1.4 — worth reopening because operator 明确画像永远全局一份；D1.4 把 persona 绑到 workspaceRoot，导致每个启动根目录都 seed 空模板。

## 待写入

- （已 flush）ADR-0025、ADR-0019 D1.4 正文、CONTEXT 三词条

## Tasks (ordered by dependency)

1. **Record persona-is-global** — tag: `[decision]`
   - **Inherits:** spec 196 A8「`~/.iknow/` 复用同根，新增 user.md + state.json」；BOOTSTRAP 文案已指向 `~/.iknow/user.md`。ADR-0019 D1.1–D1.3 / D1.5 保持。
   - **Surface:** `docs/adr` / `docs/CONTEXT.md`
   - **Acceptance:** ADR-0025 accepted：identity 文件物理根 = `userHome/.iknow`，即使设置了 `--workspace-root` 也不搬走；ADR-0019 Status 含 `D1.4 superseded by ADR-0025`；CONTEXT 三词条定义与 `_Avoid_` 与该契约一致。
   - Status: [x] done (ADR-0025 + CONTEXT; this commit)

2. **Seed and assemble only at home** — tag: `[implementation]`
   - **Inherits:** T1 / ADR-0025。`initIknowWorkspaceSafe` 失败仍 warn 不阻塞。`opts.workspace` 仅测试/隔离 `userHome` 缝，不是 workspaceRoot。
   - **Surface:** identity / build-engine / cli / tui / session-api
   - **Acceptance:** 在隔离 `userHome` + `cwd` = 项目根、无 `IKNOW_WORKSPACE_ROOT` 时：`<userHome>/.iknow/{user.md,BOOTSTRAP.md,state.json}` 存在；`<cwd>/.iknow/user.md` 与 `BOOTSTRAP.md` 不因启动被创建；`assemble` 的 `user_profile` / bootstrap 读的是 home 那份。`--workspace-root` 指向另一目录时画像仍在 home。五类边界见 ACR DCV 行。既有 `npx vitest run tests/harness/identity/` 与相关 serve/cli 回归 EXIT=0。
   - [blocks: T1]
   - Status: [x] done (`b763b01f`)

3. **Align product docs with global persona** — tag: `[implementation]`
   - **Inherits:** T1 + T2 已落地的物理根。
   - **Surface:** `docs/architecture.md` / `CHANGELOG.md` / `specs/196-identity-assembly.md`
   - **Acceptance:** architecture 的 per-root consumers 列表不再包含 `user.md` / `BOOTSTRAP.md` / identity seed；CHANGELOG 写明 D1.4 被 supersede；spec 196 有 supersede 标记指向 ADR-0025，不再把 seed 描述成跟随 workspaceRoot。
   - [blocks: T2]
   - Status: [x] done (this commit)
