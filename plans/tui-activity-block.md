# Plan: TUI activity block

**Successor:** live「安静 = 全 retract」已由 `plans/tui-activity-block-live-signal.md` supersede；块两态 / 正文槽 / 切开仍以本文件 + spec 为准。

**Goal:** TUI 过程 chrome 按模型消息切成过程块：思考实时占正文槽，安静工具接手后改占同一槽的浅色预览，中间正文切开焊接，块与块只追加不合。
**Approach:** 先把访谈锁句写入 spec 与 CONTEXT（替换现行「unit fold + live activity group 双时态」）。再做一个纯派生（消息 + live runs → 块列表），用垂直切片接上思考-only、安静工具接手、中间正文切开、下一条消息新块；最后拆掉旧双摘要器互斥。Ctrl+O 展开、改 keep/accent/失败分类表、改 thinkingMs 落盘算法，均不在本计划。
**Spec link:** `specs/tui-activity-block.md`（T1 产出；落地前本计划的 Locked sentences 为 Inherits 源）
**ACR:** all-yes（block below）
**待写入:** 已 flush：activity block / body slot / adjacent weld；修订 live tool line / unit fold / open unit / live activity group / thinking duration / retract class。无新 ADR。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## ACR

bounded-context-guardian: yes — chrome 只留在 tui 显示面；不改 harness 工具形状、不改 session transcript / thinkingMs 落盘、不改 web。
input-contract-tests: yes — 无思考无工具；思考后无工具直接正文；思考后直接安静工具（无正文）；正文夹在思考与安静工具之间；失败安静工具走 failure overlay 不进 stub；下一条 assistant 新块（并发 live 与已冻 stub 并存）。
error-handling-enforcer: yes — failure overlay 横切不进过程块计数；派生拒绝画块时 `// EXIT:`；不把失败吞成 `called`。
complexity-anti-drift: yes — 一块两态由纯派生模块产出，ChatView 只消费；禁止再叠第三套摘要器；不把 Listing/Reading/Searching 与 Thought for 并行保留。
minimal-change-verifier: yes — 一任务 = 过程块时态；不改 Ctrl+O、不改 CLI 非 TUI 面、不改 TOOL_SETTLED_CLASS 的 keep/accent 名单（安静 = 现 retract）。

Affected files (review enumerate, not implementer freeze): `docs/CONTEXT.md`, `specs/tui-activity-block.md`, tui fold/activity/chat-view/message-blocks 及对应 `tests/tui/*`.

## Locked sentences

1. 一条 assistant 消息至多一块过程块；块按时间追加；禁止把整轮收成一行 stub。
2. 过程块 = 一行标题 + 一个正文槽；槽同一时刻只归思考流或一行 dim 工具预览。
3. 仅相邻的「思考 + 安静工具」（中间无正文 / keep / accent / 失败）才把时长与 calling/called 焊在同一标题。
4. 安静工具仍在跑 → 标题用 `calling`；该块安静工具都结束 → `called`，预览槽收掉。
5. 思考阶段结束的切点 = 该消息出现 `text_delta` 或 `tool_call_start`（与既有 `thinkingMs` 测量边界一致）；此后思考正文让出槽位，时长留在标题。
6. keep / accent / 失败仍是块外实卡；安静工具不刷独立标题。
7. 下一次思考只开新块；已 `called`（或已被正文切开）的块不再改计数。
8. Ctrl+O 本切片不做。

## Tasks (ordered by dependency)

1. **Record the activity-block contract in spec** — tag: `[decision]`
   - **Inherits:** Locked sentences 1–8; CONTEXT keep / retract / accent / failure overlay 分类表不重开（安静 = retract，脚印 = keep/accent，失败横切仍 overlay）
   - **Surface:** `specs/tui-activity-block.md`；若仓库仍用活跃 spec 索引则只登记这一条
   - **Acceptance:** spec 引用八句锁句；写明 superseded：整轮 `unit fold` 焊计数、live activity group 与 unit fold 同时画同一批 retract、工具 running 即关思考 panel 且思考行仍可提前出现；不授权 Ctrl+O、不授权改 thinkingMs 落盘
   - Status: [ ] pending

2. **Persist glossary deltas** — tag: `[decision]`
   - **Inherits:** Locked sentences 1–8; existing CONTEXT keep/retract/accent/failure overlay
   - **Surface:** `docs/CONTEXT.md`
   - **Acceptance:** 词条 **activity block** / **body slot** / **adjacent weld** 已在 CONTEXT；**unit fold** / **live activity group** / **open unit** / **live tool line** / **thinking duration** 与锁句一致（不再要求跨消息求和、不再要求思考永不焊进工具标题）
   - Status: [x] done — 本 worktree 随 plan persist flush（T2 不再另开 ADR：显示 chrome 可逆，无 against 既有 ADR 的单向门）

3. **Pure projection: messages + live runs → activity blocks** — tag: `[implementation]`
   - **Inherits:** T1 sentences 1–4, 6–7; retract = 安静；`thinkingMs` 仍 per-message
   - **Surface:** tui fold / turn-activity 纯派生（无 React）
   - **Acceptance:** 给定 transcript 夹具，可观察块列表：焊 / 切开 / 新消息新块 / `calling` vs `called`；失败件不进块计数。现有 `npm test` 里覆盖该派生的用例绿（或新增同套件）
   - Status: [ ] pending
   - [blocks: T1, T2]

4. **Thinking-only live then fold when the phase ends** — tag: `[implementation]`
   - **Inherits:** T1 sentences 2, 5; T3 块列表
   - **Surface:** tui chat transcript（思考 panel / 折叠行）
   - **Acceptance:** 仅思考时正文槽流思考（或既有 peek 高度）；出现正文或工具后思考正文离开槽位，标题留下 `Thought for Ns`；工具 running 不得在思考仍流时抢走槽位
   - Status: [ ] pending
   - [blocks: T3]

5. **Quiet tools take the same body slot** — tag: `[implementation]`
   - **Inherits:** T1 sentences 2–4, 6; T3 `calling`/`called`
   - **Surface:** tui chat transcript
   - **Acceptance:** 相邻安静工具：标题为 `Thought for Ns, calling name × N`（无时长则只有 calling 段）+ 一行 dim 当前预览；该块安静工具结束后预览消失、标题 `called`；keep/失败仍是块外实卡，不出现 Listing/Reading/Searching 第二套现在时行
   - Status: [ ] pending
   - [blocks: T3]

6. **Text in the middle splits the weld; next assistant starts a new block** — tag: `[implementation]`
   - **Inherits:** T1 sentences 1, 3, 7
   - **Surface:** tui chat transcript
   - **Acceptance:** 思考→正文→安静工具：`Thought for` 与正文与 `called name × N` 三段分离，工具计数不写回思考行；下一条 assistant 的 `Thinking…` 出现在已冻 stub 之下且不修改上一块计数
   - Status: [ ] pending
   - [blocks: T4, T5]

7. **Contract dual aggregators** — tag: `[implementation]`
   - **Inherits:** T1 superseded 句；T3 为唯一块列表
   - **Surface:** tui chat-view 消费面（live activity group 与 unit fold 互斥闸）
   - **Acceptance:** 同一批 retract 不再同时出现过程组现在时行与 `Thought for · name × N` 结束态行；`hideThinking` 只跟过程块槽位主人走，不再用整轮 running/`currentTurnHasFold` 关后续块；相关旧测试改钉新合同后绿
   - Status: [ ] pending
   - [blocks: T6]

## Code review phase

整轮落地后 `code-review`；`GATE: BLOCKED` → `review-report-repair`。不在每个 checkpoint 强制双轴。
