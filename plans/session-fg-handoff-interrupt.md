# Plan: session-fg-handoff-interrupt

**Goal:** 前景子代理交差一次就停、终稿可按路径读回；Ctrl+C 停掉本会话全部前台（含前景子代理）；写路径相对活树根且不套娃叶子名；无 LSP 调用则不起 language server。
**Approach:** 思考折叠不进本计划（见 Predecessor）。本切片按管道互斥 → 终稿落 pad → 路径解析 → 前台打断扇出 → LSP 按需起 的依赖切。默认仍 `wait:true`。不改 web、不 reopen 默认后景、不把短信封改成全文灌 `tool_result`。
**Spec link:** 本文件 Locked sentences（LogicSync 2026-09-17 对齐）；T1 刷进 `docs/CONTEXT.md` 后，CONTEXT 为实施 Inherits 源。无独立 `specs/` 文件、无新 ADR。
**Predecessor:** `plans/tui-activity-block-live-signal.md` / `specs/tui-activity-block.md` — 思考原位 `Thought for`；本计划不重开 Ctrl+O / thinkingMs。
**ACR:** all-yes（block below）
**待写入:** 已 flush：父可见信封 `output_path` / host 落稿；host drain 禁前景 silent wake；前台打断；taskRoot 剥叶子；warmup 改首次 lsp。无新 ADR。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## ACR

bounded-context-guardian: yes — 子代理信封/drain 留在 harness/subagent；路径解析留在 ACI helpers；打断留在 TUI 已有 abort 链；LSP warmup 留在 lsp；不新开 technical-layer 目录。
input-contract-tests: yes — 空 path；绝对已在 taskRoot 内；第一段等于 leaf；wait:true 终态不再 drain；idle 时仍有前景子代理的 Ctrl+C；无 lsp_* 则无 warmup spawn。
error-handling-enforcer: yes — pad 落稿失败 typed、不把截断当任务失败；abort 扇出失败 EXIT 仍停父 turn；路径剥前缀后仍 outside-root 则既有 containment 拒绝。
complexity-anti-drift: yes — 剥前缀是 resolve 一处谓词；drain 排除是 spawn 定义上一旗；不把四条合成一个 god handler。
minimal-change-verifier: yes — 一任务 = 本会话对齐的四条运行时缺陷；思考 live-signal 不并入；不翻默认 wait。

Affected files (enumerate, not freeze): `docs/CONTEXT.md`, `src/harness/subagent/envelope.ts`, `src/harness/subagent/spawn-subagent-tool.ts`, `src/harness/subagent/manager.ts`, `src/harness/subagent/host-drain.ts`, `src/tui/app.tsx`, `src/harness/aci/tools/helpers.ts`, `src/harness/lsp/warmup.ts`, `src/harness/build-engine.ts`, `tests/subagent/*`, `tests/harness/aci/*`, `tests/tui/*`.

## Locked sentences

1. 前景（`wait:true`）交差只走当跳 `tool_result`；该任务 `excludeFromHostDrain`；session idle 后 mailbox **不得** 再 silent wake 同一份信封。
2. 父可见信封仍是短摘要，不是终稿；`truncated` 不是任务失败。worker 终态时 **host** 把最后一条 assistant 正文写入该 worker pad 的稳定相对路径（约定名留给实施，信封带 `output_path`）；父用既有 `subagent_result(tmp_path)` 或读该路径取全文。
3. Ctrl+C = 当前会话 **前台一切**：父 `running-fg` turn + 本会话所有前景子代理（含父已 idle 但仍 live 的 `wait:true`）。后景 `wait:false` 与其它会话 `running-bg` 不停。前台仍在跑时有选区也先打断。Ctrl+X 仍可单杀一行（含后景）。
4. 写/读/改/搜 的 workspace 解析相对活 `taskRoot`。相对路径第一段或绝对前缀等于当前树 leaf / 树路径 → **剥掉再解析**；已在 `taskRoot` 下的绝对路径不再 join。不为同名套娃留逃生口。
5. 未发生 `lsp_*`（及同族符号工具）调用前，装配 **不得** warmup/spawn language server。第一次这类调用再起。

## Tasks (ordered by dependency)

1. **Persist glossary** — tag: `[decision]`
   - **Inherits:** Locked sentences 1–5；不新开 ADR
   - **Surface:** `docs/CONTEXT.md`
   - **Acceptance:** 父可见信封含 host 落稿 + `output_path`；host drain _Avoid_ 写明前景任务不进 drain；前台打断含 Ctrl+C 扇出；taskRoot/解析含剥叶子；warmup 与「首次 lsp 工具」对齐。无业务代码。
   - Status: [x] done — persist 随本计划 flush（无新 ADR）

2. **Foreground spawn never host-drains** — tag: `[implementation]`
   - **Inherits:** Locked sentence 1
   - **Surface:** harness subagent spawn / drain / TUI silent wake
   - **Acceptance:** `wait:true` 终态后父回合 idle，下一次 `run()` prior 不再出现同一 `## Sub-agent` 浓缩；`wait:false` 仍可 mailbox 叫醒。`npm test` 覆盖该互斥的用例绿
   - Status: [ ] pending
   - [blocks: T1]

3. **Host writes pad final; envelope carries output_path** — tag: `[implementation]`
   - **Inherits:** Locked sentence 2
   - **Surface:** harness subagent envelope / worker settle / pad inspect
   - **Acceptance:** 子终稿长于短信封时，pad 上文件可读且信封有 `output_path`；`truncated: true` 时任务仍 `status: ok`（失败另有 reason）；父 `subagent_result` 按该相对路径读到与终稿一致的正文（截断口径同既有 pad 读）
   - Status: [ ] pending
   - [blocks: T1]
   - [parallel]

4. **Resolve strips worktree leaf prefix** — tag: `[implementation]`
   - **Inherits:** Locked sentence 4
   - **Surface:** ACI workspace path containment（写/读/改/搜共用）
   - **Acceptance:** 活根叶子为 `ai-news-digest` 时，`ai-news-digest/index.html` 与 `index.html` 解析到同一绝对路径（树根下的 index.html）；已在树内的绝对路径不变；剥完仍逃出 root → 既有 outside-root 拒绝
   - Status: [ ] pending
   - [blocks: T1]
   - [parallel]

5. **Ctrl+C aborts all session foreground work** — tag: `[implementation]`
   - **Inherits:** Locked sentence 3
   - **Surface:** TUI 前台打断 + subagent abortTask
   - **Acceptance:** `running-fg` 时 Ctrl+C abort 父 turn 且本会话 live 的 `wait:true` 子代理进入 cancelled；父 idle 但仍有前景 live 子代理时 Ctrl+C 同样停它们；`wait:false` 子代理仍跑；`running-fg` 且有选区时仍 abort 而非只复制
   - Status: [ ] pending
   - [blocks: T1]
   - [parallel]

6. **LSP starts on first language-server tool** — tag: `[implementation]`
   - **Inherits:** Locked sentence 5
   - **Surface:** harness LSP warmup / 引擎装配
   - **Acceptance:** 装配完成且从未调用 `lsp_*` 同族工具 → 无 language server 子进程因 warmup 被拉起；第一次该类工具调用后 client 可 spawn。不改 LSP 请求超时与失败哨兵分层
   - Status: [ ] pending
   - [blocks: T1]
   - [parallel]

## Out of scope

- 思考 live-signal 实施（Predecessor 计划）
- 默认改 `wait:false`
- 加长 `SUMMARY_LIMIT` 当全文通道
- 改 CLI/web 主路径（TUI/harness 合同动到的共享解析与 spawn 除外）
- Ctrl+O / thinkingMs 落盘
- **`<agent_status>` 的注入时机**（原 Locked sentence 6：只在即将调模型前注入；没有下一跳则不因 drain/wake 再贴 `last_tool: idle`；环境条仍不进 messages）。该条无 ticket 承接、无测试覆盖、`src/harness/loop-engine.ts` 本分支未改 —— 属独立行为切片，本分支只落地前 5 条。思考行为的代码改动同样不在本切片。
- **本计划文件自身需随代码 `git add`**：它是本分支的 spec 源，但当前 untracked（同级 `plans/*.md` 均已入库）；漏 staged 会让「Locked sentences 1–5」在提交里没有出处。由 leader 在提交时一并 `git add`。
