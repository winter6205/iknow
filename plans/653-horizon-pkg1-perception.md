# Plan: horizon-653 / 包1-感知（Verify 可见 + 环境现势）

**Goal:** TUI 上验证成败对人可见（V-b，双模式），且 cwd/git/diff 以「环境现势」人读面呈现，不污染 ADR-0028 状态栏。
**Approach:** 先钉死人读 chrome 锚点；并行补齐宿主 `passed` 投影与环境现势快照计算；再分别接到 TUI。不改 verify 内核、不扩 Trace/Web、不做包2。
**Spec link:** `specs/653-horizon-pkg1-perception.md`
**Tracker:** GitHub 主路径（`ready-for-agent` + 原生 blocking）。[spec #660](https://github.com/winter6205/iknow/issues/660) · [T1 #661](https://github.com/winter6205/iknow/issues/661) · [T2 #662](https://github.com/winter6205/iknow/issues/662) · [T3 #663](https://github.com/winter6205/iknow/issues/663) · [T4 #664](https://github.com/winter6205/iknow/issues/664) · [T5 #665](https://github.com/winter6205/iknow/issues/665)。T3←T2；T5←T1+T4；T1∥T2∥T4。
**ACR:** all-yes（自 spec）

```
bounded-context-guardian: yes — 预定接线仅 TUI 人读 / hub 投影补齐 / harness verify 只读复用；禁内核重写与 ADR-0028 写栏；无新 technical-layer 目录
defensive-contract-validator: yes — SC 覆盖 empty / negative / overflow(≤2000 cp) / concurrent(双模式) / exception(cwd·git·刷新 degraded)
error-handling-enforcer: yes — Boundaries 五条 typed failure 均标 EXIT（静默缺席 / degraded）；不 throw；不进模型上下文
complexity-anti-drift: yes — Verify 投影与环境现势分列；复用 VerificationRecord；固定单一 UI 锚点；无神文件意图
minimal-change-verifier: yes — 单逻辑任务包1-感知；包2 OOS；无新 ADR / 无第二套判定；可 1 commit 合入契约
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## 待写入（persist）

（空 — `环境现势` 已在 worktree `docs/CONTEXT.md` 起草；随 T1 或首个合入 commit 进主干。无新 ADR。）

## Tasks (ordered by dependency)

1. **T1 钉死环境现势 UI 锚点** — tag: `[decision]`
   - **Inherits:** spec：锚点在 banner 旁 / strip / footer 之一，plan 定一个；默认摘要上限 2000 codepoints；**不**进 ADR-0028 状态栏 / `agent-status`。
   - **Surface:** `docs/`（本 plan 决议记录）+ 确保 CONTEXT「环境现势」在实施分支可见；无新 ADR。
   - **Acceptance:** 决议写明唯一锚点 = **TUI 人读 chrome 条，与 `AgentStatusLine`（模型向状态栏投影）并列、独立槽位**（推荐：同一 chrome 区但**不**复用 agent_status 事件/快照）；摘要上限 = **2000 codepoints**；commit 可只含文档/CONTEXT，无行为代码亦可。决议全文见 `docs/design/DESIGN-ENVIRONMENT-PRESENT.md`（组件命名 `EnvironmentPane` / `EnvPresenceStrip`、平行数据流、负向契约与 EXIT 边界均以该文件为准）。
   - Status: [x] done — 32b7f320（sha 回填见紧随的 docs(t1) meta commit）

2. **[parallel] T2 宿主 Verify 投影含成功态** — tag: `[implementation]`
   - **Inherits:** spec：复用 `VerificationRecord` / hub；`VerifyAnswerView` 今日仅 `failed|unstable|escalated` — 须补 `passed`（及内核已有等价态透出）；缺 record → 字段缺席；不新造判定逻辑。
   - **Surface:** `session-api`（及 TUI 若直连 chat-session 的等价投影缝）。
   - **Acceptance:** 验证成功时 wire/会话投影出现成功态；失败仍为 failed（或既有态）；未跑验证 → 无虚假成功字段；`npx vitest run tests/session-api`（及相关）绿。
   - Status: [ ] pending
   - [parallel] with T1

3. **T3 TUI Verify 人读提示（双模式）** — tag: `[implementation]`
   - **Inherits:** spec V-b：HITL + 自动模式显示成功/失败（及透出态）；信封继续 `isTuiHiddenUserMessage`；缺 record 静默；投影失败 →「验证结果不可用」degraded。
   - **Surface:** `tui`（`src/tui/verify-banner.tsx` + `src/tui/app.tsx` 独立槽位 + `src/tui/hub-bridge.ts` 透传）
   - **Acceptance:** 失败与成功均出现非聊天气泡人读提示；verify 信封仍隐藏；缺 record 无虚假提示；不依赖 Trace SPA；`npx vitest run tests/tui`（及相关）绿。
   - Status: [x] done — 8e717828 (T3 VerifyBanner HITL + auto; 32 bun:test cases; 双 reviewer gate PASS)

4. **[parallel] T4 环境现势快照计算（含上限与 EXIT）** — tag: `[implementation]`
   - **Inherits:** spec：cwd + git 摘要 + diff 要点；≤2000 codepoints；cwd/git/刷新失败 → degraded 占位，不 throw；不写状态栏。
   - **Surface:** `src/harness/env-snapshot.ts`（与 `agent-status.ts` 并列纯计算 + IO 读取器 seam；DI 注入 exec）。
   - **Acceptance:** 有 git / 无 git / 超长 diff 三条可测；超长输出 ≤2000 codepoints；失败路径不 throw；单元测试绿。
   - Status: [x] done — b4cabf2e (T4 compute seam, harness-only, 不动 agent-status 追加路径)

5. **T5 TUI 挂载环境现势** — tag: `[implementation]`
   - **Inherits:** T1 锚点决议；spec：回合边界刷新；负向 — 不调用 ADR-0028 / agent-status 写 cwd。
   - **Surface:** `tui`（`src/tui/env-snapshot-pane.tsx` + `src/harness/{stream,loop-engine,build-engine}.ts` 平行事件流）
   - **Acceptance:** 人读面可见 cwd + git 摘要字段；grep/测试证明不经 agent_status 写栏；`npm run typecheck` 与 `npx vitest run tests/tui tests/harness/verify tests/session-api` 绿。
   - Status: [x] done — 77e26929 (T5 EnvSnapshotPane; 17 bun + 6 vitest cases; mcp pty 实测 cwd+diff 行渲染; 反向契约 grep 空)

## End-of-round

全部 bullet 落地后：整轮 `arthurpower:code-review`（若环境启用）→ `verification-before-completion`。包2 另开 plan，不在本文件。

## Code review follow-ups

整轮 review 后遗留事项（已落 follow-up commits）：

- **Spec Medium**：`truncateByCodepoints` 截断到 cap=2000 后追加 marker，总长 ≈ 2000+22 cp 超 SPEC SC 字面「输出长度 ≤ 上限」。→ follow-up commit `9d2c08ec` 把 marker 长度计入预算（bodyCap = cap - markerLen），保证总长严格 ≤ cap。T4 测试断言改为「total ≤ cap」+「marker 报告实际丢弃数」。
- **Standards Low ×3**（formatVerifyReport 重复 / truncateByCodepoints 内联 cap 三元 / loop-engine effectiveState 命名）：post-merge cleanup，不阻塞。
