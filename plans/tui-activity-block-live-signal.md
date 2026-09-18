# Plan: TUI activity block live signal

**Goal:** 过程块只折「对读模型行为没帮助的噪音」，思考钉在动作上方并在原位收成秒数；`web_search` / `web_fetch` 与脚印工具一样 live 实卡。
**Approach:** `#1025` 的块列表留下。未提交补丁只保留「history 里仍 running 的噪音要进 `calling` + 预览、unanchored 去重」。拿掉 `liveThinking: false` 和「任意工具 running 关思考 panel」。live 谁进块不再等于整张 retract：噪音才焊，有语义的工具（含网络搜索）块外实卡。Ctrl+O、改 `thinkingMs` 落盘、改 CLI/web，仍不做。
**Spec link:** `specs/tui-activity-block.md`（T1 修订锁句；本计划 Locked sentences 在 spec 落地前为 Inherits 源）
**Predecessor:** `plans/tui-activity-block.md` — 块两态 / 正文槽 / 切开仍成立；「安静 = 现 retract、live 全折进块」由本计划 supersede。
**Successor:** live「思考钉在动作题头」已由 `plans/tui-thinking-at-bottom.md` supersede；噪音/有语义与 web_* 实卡仍以本文件为准。
**ACR:** all-yes（block below）
**待写入:** 已 flush：live noise / live signal；修订 body slot / adjacent weld / live tool line / retract class / unit fold。无新 ADR。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

> Reopens `specs/tui-activity-block.md` 「不改 keep/accent/retract 分类表」与「安静 = 现 retract」——仅 **live 谁进过程块** 与 _\*web_* 落定是否留查询行_*。落定「`read_file` 不摊正文」不重开。无 ADR 冲突。

## ACR

bounded-context-guardian: yes — 仍只改 tui 显示派生与消费；不改 harness 工具形状、transcript、`thinkingMs` 落盘、web。
input-contract-tests: yes — 仅思考；思考后仅噪音；思考后仅 web_search；噪音与 web_search 同段；正文切开；history 中 running 噪音；失败 web/grep 走 overlay；无工具。
error-handling-enforcer: yes — 失败横切不进 `calling`/`called`；派生拒画时 `// EXIT:`。
complexity-anti-drift: yes — 一块两态仍唯一摘要器；新增的是 weldable=噪音 谓词，不是第三套 Listing 行。
minimal-change-verifier: yes — 一任务 = live 噪音/有语义 + 思考原位；吸收未提交漏计，不另开 Ctrl+O / 分类表大搬家。

Affected files (enumerate, not freeze): `specs/tui-activity-block.md`, `docs/CONTEXT.md`, `src/tui/activity-block.ts`, `src/tui/chat-view.tsx`, `src/tui/message-blocks.tsx`, `src/tui/turn-fold-lines.ts`, `tests/tui/*`.

## Locked sentences

1. 思考永远画在它驱动的那批动作**上面**；该段思考结束（`text_delta` 或任何 `tool_call_start`）后，**原位**变成 `Thought for Ns`，不跳到 tail panel。
2. 过程块正文槽同一时刻只归：仍在流的思考，或当前一次**噪音**的 dim 预览。有语义工具不占这个槽。
3. **live noise（实时噪音）** 才进过程块：`grep` / `glob` / `read_file` / 列举与内部查询（`tool_search`、list MCP、多数 LSP 扫、`memory_recall`、`bash_output` 等既有 retract 侦察）。未注册名缺省仍当噪音。
4. **live signal（实时有语义）** 永不进 `calling`/`called`：既有 keep / accent / 失败，外加 **`web_search` / `web_fetch`**。live 与落定都留一行标题；search/fetch 的查询或 URL 用一行 dim 预览，不摊长文。
5. 相邻焊接只发生在「思考 + 噪音」之间（中间无正文、无有语义工具、无失败）。`Thought for` 不准焊上 `web_search` 计数。
6. 仅噪音、无思考：可以只有 `calling`/`called` 行。仅有语义工具、无噪音：只有 `Thought for`（若有秒数）+ 实卡，**不出现**空的 `calling`。
7. `hideThinking` 只藏已不当槽主的思考正文；不准掐 assistant 正文，不准用「任意 tool running」关下一块思考。
8. 保留未提交漏计：噪音已进 transcript 但仍 running → 块为 `calling` + 预览；unanchored 按 id 去重。MessageBlocks 只抽掉**噪音**的独立标题，不抽 web_* / keep。
9. Ctrl+O、思考 peek 行数、改 `thinkingMs` 落盘，本切片不做。

## Keep from working-tree hotfix (not a separate product)

未提交 diff 中要留下的行为：`inFoldCountOf` 对未配对噪音仍为真；`deriveActivityBlocks` 吃完整 `liveRuns`，追加 unanchored 时排除已在 messages 的 id。不要留下：`liveThinking: false`；`shouldShowLiveThinkingPanel(..., toolRunning)` 整轮让位。

## Tasks (ordered by dependency)

1. **Amend the activity-block spec for live signal vs noise** — tag: `[decision]`
   - **Inherits:** Predecessor 块两态 / 切开 / 每消息追加；本文件 Locked sentences 1–9；operator 同意 `web_search` / `web_fetch` 为有语义
   - **Surface:** `specs/tui-activity-block.md`
   - **Acceptance:** spec 写明 superseded「live 安静 = 全 retract」；锁句含噪音名单原则与 web_* 实卡；不授权 Ctrl+O / 改 thinkingMs 落盘 / 给 `read_file` 摊正文
   - Status: [ ] pending

2. **Persist glossary** — tag: `[decision]`
   - **Inherits:** T1 锁句 3–5
   - **Surface:** `docs/CONTEXT.md`
   - **Acceptance:** **live noise** / **live signal** 已在 CONTEXT；**retract class** 不再写「web_* live 只进过程块」；**adjacent weld** 只焊噪音
   - Status: [x] done — persist 随本计划 flush（无新 ADR：live 集合可逆）

3. **Projection: weldable = live noise only** — tag: `[implementation]`
   - **Inherits:** T1 sentences 3–6, 8
   - **Surface:** tui activity-block 纯派生
   - **Acceptance:** 夹具：grep running → `calling grep` + 预览；同段 `web_search` 不出现在标题计数；history 中 running 的 grep 仍 `calling` 不提前 `called`；失败 grep 不进计数。`npm test` 覆盖该派生的用例绿
   - Status: [ ] pending
   - [blocks: T1, T2]

4. **Thinking occupies the block slot in document order** — tag: `[implementation]`
   - **Inherits:** T1 sentences 1–2, 7
   - **Surface:** tui chat transcript（块槽，不是独立让位 panel）
   - **Acceptance:** 仅思考时标题 `Thinking…`、槽为思考；出现正文或任何 tool_use 后原位 `Thought for Ns`；思考行在同段工具卡**之上**；已冻 stub 不关掉下一段 `Thinking…`；不再叠第二份 `Thinking…`
   - Status: [ ] pending
   - [blocks: T3]

5. **Semantic tools stay cards; noise uses the dim slot** — tag: `[implementation]`
   - **Inherits:** T1 sentences 2, 4, 6, 8
   - **Surface:** tui message 行 / 块预览
   - **Acceptance:** live `web_search`/`web_fetch` 可见标题 + 查询/URL 一行；MessageBlocks 不把它们当噪音抽掉；噪音无独立标题，只在块下 dim 预览；keep/失败仍块外
   - Status: [ ] pending
   - [blocks: T3]

6. _\*Text split still holds; no web_* on the thinking title_* — tag: `[implementation]`
   - **Inherits:** predecessor 切开；T1 sentence 5
   - **Surface:** tui chat transcript
   - **Acceptance:** 思考→正文→grep：`Thought for` / 正文 / `called grep` 三段；思考→web_search→grep：`Thought for`、search 卡、噪音 `calling/called` 分离，标题不含 `web_search ×`
   - Status: [ ] pending
   - [blocks: T4, T5]

## Code review phase

整轮落地后 `code-review`；`GATE: BLOCKED` → `review-report-repair`。
