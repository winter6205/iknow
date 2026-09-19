# Plan: 会话列表标题（lite 生成）

**Goal:** 列表扫到的是一次生成的短主题；没有 lite 或失败时仍能看见首条 user 占位；生成结果不会被 save/compact 的 `extractTitle` 盖掉。
**Approach:** 先把术语和 ADR 钉在用户层 lite 槽与「标题事件 ≠ message」。再让 JSONL 能存事件、header `title` 当缓存。然后接无工具补全模块与 host 触发。最后把 Web 侧栏改到 `title`。不把 compact/memory 接到 lite。
**Spec link:** `specs/session-list-title.md`
**ACR:** N/A-with-reason — 本槽操作员点名 writing-plans（跳过 ACR 技能）；覆盖如下，供实施前若重跑 ACR 对照。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion（落地粒度：操作者全局提交段）

## 待写入

已在本 worktree 落盘：CONTEXT **lite model** / **session-title event**；`docs/adr/0109-session-list-title-lite-model.md`（proposed）。实施不另开词。

## ACR

```
bounded-context-guardian: yes — 生成模块落在 session-api 能力内（无工具补全，不进 Loop Engine）；settings 仍 src/config；不新开顶层技术分层目录
input-contract-tests: yes — liteModel 空/非法/溢出路由、标题事件缺席、生成失败、与 extractTitle 占位并存；沿用 settings 解析与 jsonl schema 既有空/非法类测试面
error-handling-enforcer: yes — lite 缺席或补全失败 EXIT: log-and-continue，保留占位，不抛进主回合；主模型缺失仍 ADR-0015 fail-fast
complexity-anti-drift: yes — 新模块只做一次补全+sanitize+append；hub 只接线；禁止把生成折进 compact
minimal-change-verifier: yes — 只做列表标题；out of scope = 给人改名、compact/memory 改 lite、双行列表
OVERALL: N/A planner coverage — writing-plans 本槽；实施前可另跑 architecture-change-reviewer
```

**affects:** `src/config` `src/session-api/store` session-api hub/host 接线 `web` 侧栏 `tests/session-api` `tests/web` `tests/config`（实施自定文件名）

## Tasks (ordered by dependency)

1. **术语与 ADR-0113 已在树内** — tag: `[decision]`
   - **Inherits:** G4：独立事件 + 单独模块 + `settings.llm.liteModel`；G1：lite 生成一次短主题；G2：主文案 `title`；G3：占位立刻、completed 后异步、禁止回盖。
   - **Surface:** `docs/CONTEXT.md`、`docs/adr/0109-session-list-title-lite-model.md`、`specs/session-list-title.md`
   - **Acceptance:** 词条与 ADR 在本 worktree 可读；lite 缺席不 fail-fast 写进 ADR；compact/memory 不接 lite 写进 Does not。
   - Status: [x] done（本 slot persist）

2. **liteModel 进用户 settings 与 env** — tag: `[implementation]`
   - **Inherits:** ADR-0113 §3；ADR-0015：`llm.model` 仍是主会话唯一 fail-fast 路由；ADR-0084：项目文件不采纳 `llm`。同形 `provider/model`，同一 `providers[]`。非法字段丢弃，不当成主模型。
   - **Surface:** `src/config`（settings 解析 + `loadIknowEnv`）
   - **Acceptance:** 合法 lite 路由可解析到与主模型相同的 provider 查表结果；缺席 / 空串 / 非法 → env 上 lite 缺席且主会话仍能启动；项目 settings 写 `llm.liteModel` 不覆盖用户层。
   - Status: [x] done — `LiteModelEnv`/`resolveLlmLite`（env.ts）+ `parseLlm`/`mergeLlm`/`isEmptyLlm` 三处同步（settings.ts）；tests/config 690 绿；s5 复杂度经 helper 抽取回 baseline。
   - [blocks: T1]

3. **标题事件进 transcript，header title 只做缓存** — tag: `[implementation]`
   - **Inherits:** ADR-0113 §1/§4。事件不投影进 `messages`、不进模型 prior。无事件时 `extractTitle` 占位；有事件后 save/compact 不得回盖。compact preamble 不得成为 `title`。
   - **Surface:** session-api store / jsonl / list 投影
   - **Acceptance:** 追加标题事件后 `list()` 的 `title` 为事件正文；随后 save 与 compact 仍为该正文。无事件的旧文件行为与今日 `extractTitle` 一致。load 投影的 `messages` 不含标题事件。
   - **澄清（code-review L 登记）：**「compact preamble 不得成为 title」由回盖闸在**已有标题事件**时保证；无事件时 compact 后 title 仍是 `extractTitle` 占位（spec Does #2 允许的既有行为），不是本票回归。
   - Status: [x] done — JSONL 新 type `"title"` + `appendTitle`/`latestTitleText`/`resolveTitleText`；回盖闸落 store 咽喉点（save 的 `gateTitleToEvent` + rewind），hub 零改动即全覆盖；tests/session-api 986 绿。
   - [blocks: T1]

4. **无工具生成模块 + host 触发** — tag: `[implementation]`
   - **Inherits:** G1 材料（跳过寒暄；过短等首轮助手）；G3 第一次 `completed` 后异步一次；失败静默。不进 Loop Engine。
   - **Surface:** session-api 内生成模块 + hub/host 接线
   - **Acceptance:** 配了 lite 的会话在第一次 completed 后，不挡主回合的情况下出现标题事件且 list `title` 更新；lite 抛错或超时则 `title` 仍为占位。第二次 completed 不写第二条生成（已有事件则跳过）。寒暄-only 首条不单独成功生成。
   - Status: [x] done — `src/session-api/title-generation.ts`（sanitize/prompt/触发闸/generator）+ hub `titleGenerator` 注入缝 + serve/TUI hub-bridge 装配；触发语义 (a)-(e) 各有测试；hasTitleEvent 磁盘闸在 serialize 槽位内权威判定（review M2 修复）。
   - [blocks: T2, T3]

5. **[parallel] Web 侧栏主文案改 title** — tag: `[implementation]`
   - **Inherits:** G2。TUI 已渲染 `title`。搜索仍可命中 `lastFinalText`。
   - **Surface:** `web` SessionSidebar
   - **Acceptance:** 侧栏可见字符串来自 `title`（空则既有空态，不用 `lastFinalText` 当主行）。HTTP list 字段仍带 `title` 与 `lastFinalText`。
   - Status: [x] done — `sidebarLineText` 纯 helper（lib/session-list.ts）+ `SessionListItem.title` 必填；tests/web 406 绿；搜索/过滤仍按 lastFinalText。
   - [parallel]
   - [blocks: T3]

## Out of scope

- 给人改会话名、中途反复生成
- 列表双行、聚类、搜索排序
- compact / memory extract / dream 改用 lite
- 用 `title` 当文件夹名
- chat REPL 入口（`src/cli/chat-session.ts`，不装配 SessionHub）接标题生成 —— 操作员裁定（2026-09-20）：本票只管 TUI/Web 相关面；chat 会话继续显示 `extractTitle` 占位（spec Does #2 既有语义）。follow-up：若日后要接，走同一 `liteTitleGeneratorOptions` 装配缝并按 CLI 接线规则补 `test:real-llm`。

## Code review phase

全部 tracer 落地后跑一轮 `code-review`；`GATE: BLOCKED` 则下一槽 `review-report-repair`，再 `verification-before-completion`。
