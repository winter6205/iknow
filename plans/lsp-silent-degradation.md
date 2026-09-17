# Plan: lsp-silent-degradation

**Goal:** 让 LSP 子系统的失败态与正常态可区分。四处「静默退化」各自变成可命名、可观测的失败：`find_symbol` 无 `file` 的 `[]`、applier 静默丢 file operation、warmup 失败只写 stderr、probe 的实测结论只活在夹具注释里。不加任何新能力（codeAction / typeHierarchy / 新语言均不在本批）。
**Approach:** 这四处不是四个独立 bug，是同一缺陷类的四个实例——**失败看起来像成功**。修法同形：给失败态一个名字，让调用方（模型或人）能读到它。`[]` 只保留「查到了、真没这个符号」一个含义，失败走既有分层哨兵家族第五条；applier 遇到应用不了的东西 typed 失败而非 `continue`；warmup 的成败可查（这同时是根因调查所需的观测点）；probe 矩阵落成文档，「支持一门语言」从此 = 矩阵里有那一行。
**Spec link:** `specs/251-lsp-tool.md`（活）。注意 `specs/302-lsp-multilang.md` 与 `specs/symbol-primary-aci.md` 被源码约 20 处引用但**已删且未归档**（`5ae9889a` / `a6987b05`）——本批不恢复它们，但矩阵票是对 302 那部分裁决的部分补偿。
**ACR:** **BLOCKED**（见下块）。解除 BLOCK 的 6 条已写进下方「解除 BLOCK 需补」；本修订把已能定的写死，仍 open 的标 `[blocked until]`。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion
**待写入:** 无（三条词条已于 `e685c5ad` 落盘；「零生产调用方」错判已在主仓纠回）

## ACR

affected files (reviewed): `plans/lsp-silent-degradation.md`；`src/harness/aci/tools/symbol.ts:300-360`；`src/harness/aci/tools/lsp.ts:170-260,430-510,857`；`src/harness/aci/tools/symbol-mutate.ts:48-62,170-230`；`src/harness/aci/tools/symbol-resolver.ts:20-32`；`src/harness/lsp/warmup.ts`（全文）；`src/harness/lsp/client.ts:515-525,625-645`；`src/harness/build-engine.ts:771`；`src/harness/subagent/worker.ts:552`；`scripts/lsp-probe.ts:40-56,250-322`；`tests/harness/aci/lsp.test.ts:995-1030,1922`；`tests/harness/lsp/client.test.ts:10-12,61-70`；`tests/harness/lsp/live-directory.test.ts:145-291`；`package.json:51`；`docs/CONTEXT.md:170,721`；`docs/guides/lsp-client-analysis.md:25`

### 被推翻的事实（已纠）

1. **`createLspToolSet` 不是零生产调用方。** `scripts/lsp-probe.ts:49` import、`:266` 调用，经 `package.json:51` 的 `probe:lsp` 接线。旧计划 / CONTEXT / guide 四处写「零生产调用方」——错。删退役 `lsp_*` 会砸掉 T5（矩阵）的仪器。
2. **probe 矩阵不是 `find_symbol` 无 `file` 的验收参照。** probe 调 `lsp_workspace_symbol({ file: target })`（`:318-322`），**永远带 `file`**，从不碰 `getClientForWorkspaceDetailed`，也从不调 `find_symbol`。

### 5 行裁决

bounded-context-guardian: **unclear** — 没看到技术分层切分或反向依赖；问题是 warmup 观测缝没有形态和归属。`startLspWarmup` 是 `void` 返回的 fire-and-forget（`warmup.ts:50-52`，约束 `:10-11`），失败只落 stderr；验收只说「可查」，没说是返回值、ctx 状态、trace 还是 notifier。消费者跨 `build-engine.ts:771` 与 `worker.ts:552`，还要被根因调查当判别机制读到。缝未定 → 边界无法裁。

input-contract-tests: **no** — `find_symbol` 零行为覆盖（tests 里全是工具名清单 / description guard）。整个 vitest LSP 套件都 mock 掉传输层；没有真实 server 测试层。`warmup.ts` 同样零直测。答案是**补第一个覆盖**，而且承载它的测试层本身得先建——这是计划外新增 scope，不能塞进哨兵票。

error-handling-enforcer: **unclear** — applier 方向对，但同形静默丢弃是**三处**不是两处：`normalizeWorkspaceEdit` 的 `continue`（`symbol-mutate.ts:188`、`:203-204`）、两个 `flatMap`（`:189`、`:205`）、`:190`/`:206` 的 length-0 `continue`，加 `normalizeTextEdit` 的裸 `return []`（`:225`）。哨兵措辞与 `isLspFailureSentinel` 是否加第四条前缀分支都推给调查结论，而该判定函数（`lsp.ts:233-239`）只匹配三条字面前缀，且有活消费者（probe）按它分类 FAIL/skip。失败轴形状未定。

complexity-anti-drift: **yes** — 四刀各落在单文件单函数上。共享件搬家被 Q1 判为不动后，跨文件膨胀风险消解。

minimal-change-verifier: **no** — 旧计划里「T5 → T2 验收参照」依赖是假的；哨兵修法由调查结论决定，而调查又要拿 warmup 观测当仪器 → warmup 的 scope 由尚未得出的调查反向决定。5 张票跨 4 个关注点加一份文档，不是 one task。

### Q1 / Q2

- **Q1 共享件搬家：不动。** 提问前提不成立——`createLspToolSet` 是 probe 仪器；T2 要改的两处本就是活函数、活 importer。该文件是名字起错，不是死了。搬家另开批，前提是先决定 probe 迁符号面还是坐标面维持现状。
- **Q2 commit 切分：4 个产品/文档 commit + 调查证据另存。** 顺序：**warmup 可观测 → 根因调查 → 哨兵+覆盖 → applier**；矩阵票完全独立、不构成任何前置。

### 解除 BLOCK 需补

1. ~~改正三处文档的「零生产调用方」错判~~ → 主仓已纠 CONTEXT + guide（本修订同步）。
2. **定哨兵票的覆盖策略**（二选一，写进票）：(A) 新建真实 server 测试层（config / gating / CI 跑不跑 / 缺二进制行为）——单独一张票；(B) fake client 钉契约 + 手工 `probe`/`脚本` 复验无 `file` 路径。**本修订暂选 (B)**，避免本批再扩一张基建票；若 (B) 在调查后证明测不出根因，再升 (A)。
3. ~~删掉「矩阵是哨兵票验收参照」~~ → 已删。
4. **定 warmup 观测缝形态**（见 T1）。
5. **定 applier 范围：同批**（见 T4）——`normalizeTextEdit` + length-0 `continue` 与 file-op `continue` 同一缺陷，分批会造「修了一半」。
6. **定哨兵措辞 + `isLspFailureSentinel` 是否加分支** → 调查结论后、哨兵票开工前落纸（见 T3）。

## Tasks (ordered by dependency — ACR 改序后)

1. **warmup 成败可观测** — tag: `[implementation]`
   - **Inherits:** `src/harness/lsp/warmup.ts` 失败只 `process.stderr.write`（`:71-77`、`:80-84`、`:99-103`），「project 没加载」与「加载了」对调用方不可区分。ACR：观测缝必须在本票定形态，**不得**边调查边加。
   - **缝形态（本票定死）:**
     - 机制：模块级只读快照 `getWarmupOutcome(): WarmupOutcome | undefined`（`undefined` = 尚未 settle）。
     - `WarmupOutcome = { status: "ok" | "partial" | "skipped"; pinnedSamples: ReadonlyArray<{ serverId: string; file: string }>; failures: ReadonlyArray<string> }`。
     - writer 仅 `warmup()` 内部；两个装配点（`build-engine.ts:771` / `worker.ts:552`）不读、不改。
     - 调查票用 `getWarmupOutcome()` 判别「warmup 是否 pin 住 typescript 样本」。
   - **约束:** 保持 fire-and-forget（不阻塞 build 主路径）；warmup 失败不冒泡成 turn 失败。
   - **Surface:** harness LSP warmup + 单测（fake / 无真实 server）
   - **Acceptance:** settle 后 `getWarmupOutcome()` 非 `undefined`；`ok` 时 `pinnedSamples` 含至少一个真实文件；`partial`/`skipped` 时 `failures` 非空；build 主路径耗时与失败语义不变。
   - Status: [ ] todo

2. **钉 `find_symbol` 无 `file` 的根因** — tag: `[investigation]`
   - **Inherits:** 现象可信、归因未立。`file` 缺省走 `getClientForWorkspaceDetailed`（`lsp.ts:447-459`）伪路径仅为 spawn，随后 `run()` 不套 `withDocumentOpen`（`symbol.ts:354-356`）。反证：warmup 同池键 pin 真实样本（`warmup.ts:67` / `client.ts:632-642`）。
   - **候选机制:** (a) warmup 静默失败；(b) 池键不匹配；(c) `ctx.directory` 非仓库根；(d) `workspace/symbol` / tsserver 行为本身。
   - **仪器:** T1 的 `getWarmupOutcome()`。
   - **Surface:** `systematic-debugging`；证据落本文件「落地补记」或 guide 一小节。
   - **Acceptance:** 写出成立机制 + 排除机制，各有可复现证据。**不修产品代码。** 附带产出：哨兵措辞草案 + `isLspFailureSentinel` 是否加前缀分支（供 T3 落纸）。
   - Status: [ ] todo
   - [blocks: T1]

3. **无 project 锚点返分层哨兵，不返 `[]`** — tag: `[implementation]`
   - **Inherits:** T2 根因 + 哨兵措辞。
   - **措辞裁决（T2 §8.7 落纸后改）：** 初稿写「措辞须被 `isLspFailureSentinel` 认出（否则 probe 把失败记成 pass）」，**该前提实测不成立**：probe 从不调 `find_symbol`、从不进这条分岔（§7.1），新前缀在 probe 端是死判定；三前缀的语义是「这次调用没打成」，而这条**打成了**（RPC 有响应），记 FAIL 是错误分类；消费者是模型，需要「结论不可信、换条路」而非「LSP 坏了」。故**不加第四条前缀分支**，`isLspFailureSentinel` 保持 `false`（实测），判定函数零改动。
   - 取不到有效 project 锚点时返哨兵（tsserver `No Project.` 抛错与无锚点空结果收敛到同一条）；修完 `[]` 只表示「查到了、真没这个符号」。非空结果原样透传——§8.4 实测正确锚点下覆盖也可能不完整，该警示走 description 常驻面而非逐次返回。
   - **覆盖策略（ACR 解除项 2，选 B）:** fake client 钉三条契约（无锚点 → 哨兵 / 真无符号 → `[]` / 分类为 neither）；另用一次性脚本在真实 tsserver 上复验无 `file` 路径。**不**新建真实 server vitest 层（升 (A) 另开票）。
   - **Surface:** ACI symbol 工具层 + 哨兵家族（家族判定不变，仅新增渲染器）
   - **Acceptance:** 无锚点 → 哨兵且 `isLspFailureSentinel === false`（**非**初稿的 `true`，理由见上）；真不存在的符号仍 `[]`；带 `file` 路径逐字节不变；假客户端契约测试绿；真实复验证据在案。
   - Status: [x] done（`fix(aci): return layered sentinel when no project anchor`）
   - [blocks: T2]
   - [blocked until: T2 落纸哨兵措辞] → 已解除：T2 §8.7 落纸并实测两条字符串
   - **机制 (c′) 明确不在本票范围：** 有 `.ts` 无 TS root marker 时 dispatch 落到 yaml-language-server 返回误导性缺方法哨兵。修法要动 server **选择**（另一模块、另一缺陷类），plan 无此票；T3 复验时再次实测确认该形态仍原样透传。

4. **applier 拒绝不可应用的 WorkspaceEdit 片段，不静默跳过** — tag: `[implementation]`
   - **Inherits:** `normalizeWorkspaceEdit`（`symbol-mutate.ts:176-211`）对 file operation `continue`；同形还有 `flatMap`（`:189`、`:205`）、length-0 `continue`（`:190`、`:206`）、`normalizeTextEdit` 裸 `return []`（`:225`）。ACR：**同批**。
   - **行为:** 含 `CreateFile` / `RenameFile` / `DeleteFile`，或 `documentChanges` 条目无法归一成 `TextDocumentEdit`，或 `TextEdit` 形状非法 → typed 失败并点名哪种；**不部分应用**。纯文本编辑路径逐字节不变。
   - **Surface:** symbol-mutate WorkspaceEdit 归一化
   - **Acceptance:** 上述失败路径各有测试；`rename_symbol` 现有测试全绿。
   - Status: [ ] todo
   - 与 T1–T3 零耦合，可并行 / 单独 PR。

5. **probe 矩阵落成文档** — tag: `[docs]`
   - **Inherits:** `scripts/lsp-probe.ts` + `lsp-probe-targets.ts` 已能产出 5 server × method 的 skip/FAIL 矩阵。实测结论散在夹具注释（`:74-76` yaml、`:97-99` dockerfile）。
   - **澄清（ACR）:** 本矩阵量的是**坐标面** `lsp_*`（含带 `file` 的 `lsp_workspace_symbol`），**不是** `find_symbol` 无 `file` 覆盖。仍有价值：定义「支持一门语言」。
   - **Surface:** `docs/guides/lsp-client-analysis.md`
   - **Acceptance:** 跑 `npm run probe:lsp` 落矩阵；夹具注释结论收上来；写明「支持 = 矩阵有那一行」。缺二进制如实记未测格。
   - Status: [ ] todo
   - 完全独立，前后随意。

## Commit 切分（ACR Q2）

1. `feat(lsp): make warmup outcome observable`（T1）
2. 调查证据：`docs:` 进 guide/本计划落地补记，或写进下一个 commit message body（不单独产代码）
3. `fix(aci): return layered sentinel when no project anchor`（T3；哨兵 + `isLspFailureSentinel` 同 commit）
4. `fix(aci): reject unsupported workspace edit fragments`（T4；可并行）
5. `docs(lsp): record probe matrix`（T5；独立）

## Out of scope

- **codeAction / quickfix**。形态已定但另开一批：单工具 `fix_diagnostic({file, diagnostic_index, choice?})`，一个候选直接落、多候选不落手只返候选；kind 只放 `quickfix` 且绑单条诊断；拒 `source.organizeImports` / `source.fixAll`；拒 `refactor.*`（返 `CreateFile`，撞 T4 的洞）。**依赖 T4。** 附带：`get_diagnostics_for_file` 加稳定序号。
- `typeHierarchy/*`、`prepareRename`、`willRenameFiles`、pull diagnostics
- 新语言（gopls / rust-analyzer）。更正：不需要 `resolvePathBin`；`resolveNpmBin` 第二步已是 PATH。5 server 全在 `devDependencies`。
- `METHOD_CAPABILITY_KEYS` 死行清理
- 共享件搬家 / 删退役 `lsp_*`（Q1：不动；另开批，先定 probe 迁不迁符号面）
- 新建真实 LSP server vitest 层（覆盖策略升 (A) 时另开）
- `find_declaration` 实发 `definition` 的语义折叠（只改 description）
- full sync → incremental、`didChangeWatchedFiles`
