# Plan: TUI thinking at bottom

**Goal:** 还在流的思考画在 transcript 最底下；这段结束就在原地变成 `Thought for Ns`，工具出现在它下面；下一轮思考再出现在新的最底下。落定后的上下顺序跟这个过程一样。
**Approach:** 过程块列表与 live noise / live signal 划分留下。改的是 live 思考相对已出现工具卡的位置，以及落定后 `Thought for` 插在对应内容处、禁止甩到消息尾巴。不改 `thinkingMs` 落盘、Ctrl+O、harness、web。
**Spec link:** `specs/tui-activity-block.md`（T1 修订锁句 1；落地前本文件 Locked sentences 为 Inherits 源）
**Predecessor:** `plans/tui-activity-block-live-signal.md` — 噪音/有语义、焊接、web_* 实卡仍成立；「live 思考永远钉在它驱动的动作上面」由本计划 supersede。
**ACR:** all-yes（block below）
**待写入:** 已 flush：不新造词条；只改 **live tool line** Avoid，并在 **unit fold** 补一句位置。无新 ADR。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

> Reopens `specs/tui-activity-block.md` Live-signal revision 锁句 1（思考永远画在动作上面，作为 **live 钉死题头**）。不重开 live noise/signal 名单、`thinkingMs` 算法、Ctrl+O、`read_file` 不摊正文。无 ADR 冲突。

## ACR

bounded-context-guardian: yes — 改动面停在 tui 显示派生与消费 + spec/plan/CONTEXT；排除 harness/web/CLI；消费既有过程块列表，不新开模块、不反向依赖。
input-contract-tests: yes — 无思考；`thinkingMs` 0 不画折；第二段 live 思考在已有工具下；live 思考与 live-signal 卡并发；畸形 content EXIT 空列表；hideThinking 不剥这条 `Thought for` 标题。
error-handling-enforcer: yes — 保留过程块派生 try/catch `// EXIT:` 空数组及非数组 content EXIT；无新 swallow。
complexity-anti-drift: yes — 禁止第二套 fold 摘要器；标题按锚点插入；live 思考不得钉在已有 live-signal 卡之上。
minimal-change-verifier: yes — 一任务 = 思考在底 / 原地变 `Thought for` / 按锚点插入；排除 Ctrl+O、thinkingMs 落盘、peek cap、harness。

Affected files (enumerate, not freeze): `specs/tui-activity-block.md`, `docs/CONTEXT.md`, tui chat transcript / 过程块消费 / live tail，及对应 `tests/tui/*`.

## Locked sentences

1. 思考还在流、后面还没有本段已经结束的内容时，`Thinking…` 画在 transcript **最底下**，用户能看见正在流的思考。
2. 该段思考结束（既有切点：`text_delta` 或任何 `tool_call_start`）后，**就在那一行**变成 `Thought for Ns`；新出现的工具卡或正文追加在它**下面**。不准把还在流的 `Thinking…` 钉在已经画出的工具卡上面。
3. 下一段思考（通常是工具结果回来后的下一条 assistant）出现在**新的最底下**，低于已经可见的工具。
4. 落定后的上下顺序与这条时间线相同：`Thought for` → 该段工具 → 下一行 `Thought for` → 下一批工具 → 正文。标题按过程块锚点插进内容顺序，禁止整包甩在消息尾巴。
5. live noise / live signal、相邻焊接、`hideThinking` 只藏不当槽主的思考正文、`thinkingMs` 仍 per-message 第一段爆发——均继承 predecessor；本切片不改落盘算法。
6. Ctrl+O、思考 peek 行数产品变更、harness 工具形状、web、CLI 非 TUI，本切片不做。

## Tasks (ordered by dependency)

1. **Amend the activity-block spec for thinking at the bottom** — tag: `[decision]`
   - **Inherits:** 本文件 Locked sentences 1–6；predecessor 锁句 2–9（噪音/有语义/焊接/hideThinking 口径/`thinkingMs` 不做）
   - **Surface:** `specs/tui-activity-block.md`
   - **Acceptance:** spec 写明 superseded「live 思考钉在动作题头」；锁句用「最底下 / 原地变成 Thought for / 下一段在新的底 / 按锚点插入」，不另造术语；不授权 Ctrl+O / 改 thinkingMs 落盘
   - Status: [x] done — spec 增 Thinking-at-bottom revision（锁句 1–6 + superseded 表 + S14–S17）

2. **Persist glossary** — tag: `[decision]`
   - **Inherits:** T1 锁句 1–4 的位置合同（不新造词）
   - **Surface:** `docs/CONTEXT.md`
   - **Acceptance:** 没有「思考光标」一类新词条；**live tool line** 禁止把还在流的思考钉在已有工具卡上、禁止把 `Thought for` 甩到消息尾巴；**unit fold** 写明结束就在当时那一行变成标题
   - Status: [x] done — persist 随本修订 flush（无新 ADR）

3. **Settled titles insert at content anchors** — tag: `[implementation]`
   - **Inherits:** T1 sentences 4–5
   - **Surface:** tui chat transcript（历史消息行，不是第二套 unit fold）
   - **Acceptance:** 思考→`web_search` 落定后屏序是 `Thought for Ns` 再 search 卡，不是卡后再甩一行折；`thinkingMs` 0 无折；`hideThinking` 不剥这条标题。覆盖该序的既有 `npm test` / TUI 夹具绿
   - Status: [x] done — blockLinesByMessage 带 contentBlockIndex；MessageBlocks 按锚点交错；t6 反转 + 133 测试绿
   - [blocks: T1, T2]

4. **Live thinking stays at the bottom until it becomes Thought for** — tag: `[implementation]`
   - **Inherits:** T1 sentences 1–2, 5
   - **Surface:** tui live tail / 过程块 live 相
   - **Acceptance:** 仅思考时 `Thinking…` 在最底下；出现 `web_search`（或任何工具）后该段已变成 `Thought for`，search 卡在其下，不再把 live `Thinking…` 钉在卡上面。覆盖该 live 序的测试绿
   - Status: [x] done — appendLiveBlocks 思考块收尾 + tail 思考块拆挂最底；t4/t5/activity-block 测试反转绿
   - [blocks: T3]

5. **Next thinking segment opens below already-visible tools** — tag: `[implementation]`
   - **Inherits:** T1 sentence 3
   - **Surface:** tui chat transcript（跨 assistant 消息的 live + 落定）
   - **Acceptance:** 第一段工具卡已可见时，第二段 live 思考出现在这些卡下面，不并进第一条 `Thought for`；畸形消息不画块（既有 EXIT）。覆盖该跨段序的测试绿
   - Status: [x] done — t6 跨消息用例 + t4 第二段思考夹具绿（Thinking… 在已可见工具之下）
   - [blocks: T4]

## Code review phase

整轮落地后 `code-review`；`GATE: BLOCKED` → `review-report-repair`。
