# Plan: 工作树 ACI 改名与说明书分层

**Goal:** 模型面五件改名为 `create-worktree` 一族；description 只说能力；夹具锁「人喊创建 → 首工具 create」。
**Approach:** 先夹具（红）再改名与短 description，再改门禁 hint / git-work 点名，最后 TUI 注册表跟名。不把政策写进 system。TUI 人读合同不在本计划。
**Spec link:** `specs/create-worktree-tools.md`
**ACR:** all-yes（见 spec 文末）
**Tracker:** 本地 markdown
**Worktree:** `.iknow/worktrees/tui-human-display` on `feat/tui-human-display`（与 TUI 人读同树、不同 commit 序列）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on `feat/tui-human-display`

```
bounded-context-guardian: yes — ACI + identity hint；TUI 只跟名。
defensive-contract-validator: yes — 夹具五类见 spec ACR。
error-handling-enforcer: yes — 失败 kind 不改，只改回执工具名。
complexity-anti-drift: yes — 机械改名 + 短 description。
minimal-change-verifier: yes — 单一逻辑任务：工作树模型面；与 TUI 人读分票。
```

## 待写入

（空）

## Tasks (ordered by dependency)

1. **黄金夹具（改名前用旧名写红测，改名后断言新名）** — tag: `[implementation]`
   - **Inherits:** spec D4；指南「先夹具再动文案」。人喊创建 → create；人喊列出 → list。
   - **Surface:** ACI 测试（与 #960 同形，跟工具测试放）
   - **Acceptance:** SC3 + SC4 夹具入仓；此时实现未改则创建用例红或 skip-not-yet — 下一颗改名后转绿。复杂度门见 `complexity-anti-drift`。
   - Status: [ ] pending
   - [parallel]

2. **五件注册名 + description 去政策** — tag: `[implementation]`
   - **Inherits:** spec D1 / D2；ADR-0082。
   - **Surface:** harness ACI
   - **Acceptance:** SC1 + SC2；`rg` 模型面无旧 `name:` 字符串。
   - Status: [ ] pending
   - [blocks: T1]

3. **门禁 hint 与 git-work 点名新名** — tag: `[implementation]`
   - **Inherits:** spec D3；告知面仍不点名。
   - **Surface:** isolation gate + identity git-work
   - **Acceptance:** SC5；git-work 正文含 `create-worktree`、无旧名。
   - Status: [ ] pending
   - [blocks: T2]

4. **TUI / 显示注册表跟名** — tag: `[implementation]`
   - **Inherits:** spec D5 — 只跟名，不做过程标题。
   - **Surface:** TUI 工具表
   - **Acceptance:** `EXPECTED_TOOLSET_*` 含新五名、不含旧五名。
   - Status: [ ] pending
   - [blocks: T2]

## 收尾

整轮 code review 对照 spec；相关 ACI 测试 + `npm test`。真模型夹具有 key 再跑 `npm run test:real-llm`。不与 TUI 人读子弹混 commit。
