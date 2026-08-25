# Plan: continue_pending（截断后续跑）

**Goal:** HITL 截断之后，用户用 `/continue`（及 CLI/TUI pending 整行 NL）在同一会话 skip-append 把未完成工具环跑完；serve/Web 走专用 `POST .../continue`。
**Approach:** 先在 Loop Engine 现有 `run()` 上打开 skip-append 缝（T1），再在 session-api 一次交付谓词、closeout `store.load`、hub continue 与 `POST /continue`（T2；整行 NL helper 也落在这里，避免 T3/T4 抢同一词表）。CLI、TUI、Web 三面在 T2 之后并行接线。不实施 ACI / ask / worker / `/goal` auto / Web Composer NL / `GET /pending`。SDD 留给 plan 的四项（NL alias、EXIT copy、谓词文件 vs inline、`continued?: true`）均不挡切分，折进相关 implementation 的 **Inherits none**。
**Spec link:** `specs/continue-pending.md`（buildable；map [#270](https://github.com/winter6205/iknow/issues/270)；ticket [#686](https://github.com/winter6205/iknow/issues/686)；产品逻辑 [#277](https://github.com/winter6205/iknow/issues/277) 不重开）
**Tracker:** GitHub issues（main path）；origin `winter6205/iknow`，每颗 tracer 一张 `ready-for-agent` issue，`[blocks:]` 走 GraphQL `addBlockedBy`。[T1 #687](https://github.com/winter6205/iknow/issues/687) · [T2 #688](https://github.com/winter6205/iknow/issues/688) · [T3 #689](https://github.com/winter6205/iknow/issues/689) · [T4 #690](https://github.com/winter6205/iknow/issues/690) · [T5 #691](https://github.com/winter6205/iknow/issues/691)。T2←T1；T3/T4/T5←T2（T3∥T4∥T5）。
**ACR:** all-yes（paste from architecture-change-reviewer）

```
bounded-context-guardian: yes — 落点仅既有 capability（`src/harness/` skip-append、`src/session-api/` 谓词+hub+POST、`src/cli/` / `src/tui/` / `web/` 表面；spec Boundaries L44–47），不新开目录；CLI/TUI→session-api 与现网同向；Web 只 HTTP（EXIT `web_slash_http_only`），禁止 `ChatUiMessage` 算 P0–P7、禁止 `GET /pending`；`verify/` / `goal-auto` 行为零改。
defensive-contract-validator: yes — Testing 五类均有用例；SC5 锁 P0–P7。
error-handling-enforcer: yes — 关闭表命名 EXIT；harness skip_append typed class in errors.ts；HTTP ValidationError 400 field=continue；store.load→mapStoreError；busy_stop_first 仅 client；HTTP serialize 同 compact；continue_http_no_fallback。
complexity-anti-drift: yes — skip-append 是现有 run() opts 缝；hub continue 镜像 compactSession；HTTP 镜像 POST /compact；谓词纯函数 + NL 单整行 helper；表面切开。
minimal-change-verifier: yes — 单一逻辑任务 continue_pending；OUT 排除 ACI/ask/worker/goal-auto/Web NL/GET /pending；六步是同一 feature 的 tracer 切分。
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

**Code review phase (end of round):** 五刀都合入后对整轮 diff 跑一次 `arthurpower:code-review`（Standards + Spec），再 `verification-before-completion`。单刀 WIP commit 不重复整轮审查。

## Harvest

**Settled（implementer 不得当未决、不得推翻 #277）：** 产品逻辑在 host、不是 ACI 工具；Stop first 且 `busy_stop_first` 仅 CLI/TUI/Web _client_；HTTP `http_serialize_like_compact`、无 HTTP `busy_stop_first`；本 slice CLI/TUI = slash + pending NL，Web = slash + `POST .../continue` only（`web_slash_http_only`）；不追加新任务 user；skip-append 缝；closeout 投影而非 `sanitizeSessionFile` 修 tool 对；continue 前 `store.load`（`reload_before_continue` / `mapStoreError`）；ask / worker / `/goal` auto OUT；专用 POST；P0–P7 与关闭表全部命名 EXIT；NL 整行词表 + `nl_not_single_token` + `nl_pending_only`；`continue_http_no_fallback`；无 `GET /pending`；禁止 `ChatUiMessage` 算谓词。

**Open（折进 implementation，不另开 [decision]）：** 同一整行 helper 是否加 alias；EXIT 用户可见中英 copy 字面；谓词纯函数文件 vs inline；`PostMessageResponse.continued?: true`。

## 待写入（persist）

（空 — `continue_pending` 已 flush 到 `docs/CONTEXT.md` Language（rewind head 与 turnCount 之间）与 Relationships（vs `/goal` auto、vs in-flight closeout）。无新 ADR。）

## Tasks (ordered by dependency)

1. **T1 harness skip-append** ([#687](https://github.com/winter6205/iknow/issues/687)) — tag: `[implementation]`
   - **Inherits:** spec §Harness entry：现有 `run()` opts 增加 `appendUserText?: boolean`（default true = 今日行为）；`false` 时不调用 `encodeUserText`，`messages = freeze(priorMessages ?? [])`，`userText` 必须是 `""` 否则 typed throw `skip_append_with_text`；`false` 且 prior 缺席或 `[]` → `skip_append_empty_prior`；类定义在 `src/harness/errors.ts`（new typed class extending existing harness error pattern）。skip-append 不跑 `recognize(userText)`。不新入口文件。ADR-0012：此次 continue 是新 `run`，`turnCount` 从 0（本刀只提供缝，host 接线在 T2）。
   - **Surface:** `src/harness/`（Loop Engine）
   - **Acceptance:** `run({ appendUserText: false, priorMessages })` 不调用 `encodeUserText`；缺省 `run("hi")` 仍调用一次；`userText !== ""` 与空 prior 分别打出上述 typed 错；本刀不改 `src/harness/verify/`、不注册 continue ACI 工具。现有 `npx vitest run tests/harness/loop-engine.test.ts` 与 `npm run typecheck` 覆盖本缝后仍 exit 0。
   - Status: [ ] pending

2. **T2 session-api 谓词 + hub continue + POST /continue** ([#688](https://github.com/winter6205/iknow/issues/688)) — tag: `[implementation]`
   - **Inherits:** spec Pending predicate P0–P7 与命名 EXIT（`nothing_pending` / `goal_active` / `fused_clean_stop` 等）；权威输入 = `store.load` 之后已 `closeoutOrphanToolUses` 的 `file.messages` + `file.goal`；禁止 TUI `lastStopReason`、hub catch 的 `PostMessageResponse.session`、未 reload 的 CLI 快照、`ChatUiMessage` / SPA timeline 算 P0–P7。谓词可剥末条 interrupt system（`SYSTEM_INTERRUPT_TEXT`），剥掉不得改盘、不得改传入 `run` 的 prior（`cancelled_keep_interrupt`）。`reload_before_continue`：谓词与 `run` 之前 hub `store.load`；失败走既有 `mapStoreError`，不新 store kind。`closeout_not_schema_sanitize`：不靠 `sanitizeSessionFile` 修 tool 对。Host：`appendUserText: false`，`userText: ""`，`priorMessages` = load 后 messages。`POST /sessions/:id/continue` 镜像 compact：可空 body；hub serialize/queue；HTTP **没有** `busy_stop_first`；禁止空 `postMessage` 冒充 continue。HTTP 谓词拒绝与 skip_append harness 错 → `ValidationError` 400（`field=continue` 或已有 `workspaceRoot`）；不把 harness 类当 wire kind；409 不征用。成功复用 `PostMessageResponse`。同一 `conversationId`。CLI/TUI 可 import 谓词；本刀提供 **同一** 整行 NL helper（spec 词表；`nl_not_single_token` / `nl_pending_only` 语义），供 T3/T4 接线。unbound 与 `postMessage` 相同 `field=workspaceRoot`。零改 `goal-auto` / `src/harness/verify/`。**Inherits none — open：** 谓词纯函数放邻域文件还是 inline；是否在同一 helper 加 alias（仍 ZH+EN、禁子串与单短词、不扩 Web Composer）；EXIT 用户可见中英 copy 字面（测试锁语义）；`PostMessageResponse` 是否加 optional `continued?: true`（缺省不加也能过 SC）。
   - **Surface:** `src/session-api/`
   - **Acceptance:** P0–P7 各有测试锁对应 EXIT（输入 = load 后 messages + goal）。空会话 `POST .../continue` → 400 `nothing_pending`，`run` 不调用。goal 钉着 → `goal_active`；LOOP_DETECTED 末 user → `fused_clean_stop`。MaxTurns：盘上有最后 `tool_result`、host 快照没有 → continue 的 `priorMessages` 含盘上那轮且 `encodeUserText` 次数 = 0。孤儿 `tool_use` 经 load closeout 后不进 `adapter.step`。并发 `POST .../continue` 走 hub serialize，**不**返回 `busy_stop_first`。`store.load` throw → `mapStoreError`，不 `run`。trailing interrupt 仍在 prior。空 `POST .../messages` 仍 400 `message text must be non-empty`。无 `GET .../pending`。worker 仍无 continue API。`npx vitest run tests/session-api` 与 `npm run typecheck` exit 0。
   - Status: [ ] pending
   - [blocks: T1 #687]

3. **[parallel] T3 CLI `/continue` + pending NL** ([#689](https://github.com/winter6205/iknow/issues/689)) — tag: `[implementation]`
   - **Inherits:** spec Trigger：`/continue` trim 后 slash、command 大小写不敏感、禁止参数（任何 args → `usage`）；slash 即使 NL 不会匹配仍走 continue，谓词失败则 EXIT、不把 `/continue` 当 user 任务句。NL **仅当 pending 为 true** 才查 T2 整行表；未命中或 pending 为 false → 普通新任务（append）。表内 ZH+EN 在 pending 时 skip-append。`nl_not_single_token`：整行 `continue` / `resume` / `go` / `续` / `继续` 当普通 query（pending 时也会 append）。`busy_stop_first`：CLI _client_ idle/busy-guard，busy 拒绝发起、不 abort 原 turn。`continue_http_no_fallback`：continue 校验失败只展示 EXIT，永不 fallback 成新任务句。`reload_before_continue` 由 hub 执行；CLI 不得用 stale `CliChatState.messages` 当 SSOT。`ask_out`：`iknow ask` 无 continue。CLI `/help` 含 `/continue`。**Inherits none — open：** 本面 EXIT 用户可见 copy 字面（锁语义即可）。
   - **Surface:** `src/cli/`
   - **Acceptance:** 空会话 `/continue` → `nothing_pending` 且 `run` 不调用。表内 NL 在 pending 时不追加任务 user 句；整行 `continue` / `继续` 与 `continue the migration` 走普通 query（pending 时会 append）。超长非精确 NL 仍受 `MAX_MESSAGE_CHARS`。CLI busy 时 `/continue` → `busy_stop_first`，原 turn 不被 abort。MaxTurns 后 host 数组缺最后一轮、盘上有 → CLI continue 的 prior 含盘上块。`/help` 含 `/continue`。ask 无 continue 入口。`npx vitest run tests/cli` 与 `npm run typecheck` exit 0。
   - Status: [ ] pending
   - [blocks: T2 #688]
   - [parallel] 与 T4、T5（均只依赖 T2）

4. **[parallel] T4 TUI `/continue` + busy-guard** ([#690](https://github.com/winter6205/iknow/issues/690)) — tag: `[implementation]`
   - **Inherits:** spec Trigger TUI：slash 词表 + help/hint；pending NL 在 `kind=message` 之后查 T2 同一整行表（规则同 T3）。_client_ busy-guard 镜像 `/compact`：in-flight turn / compact / continue → `busy_stop_first`；Ctrl+C 停 turn，不拿 continue 当 abort。`continue_http_no_fallback`；谓词失败不把 slash 当新任务句。禁止用 TUI `lastStopReason` 当 SSOT。**Inherits none — open：** 本面 EXIT copy 字面。
   - **Surface:** `src/tui/`
   - **Acceptance:** `/continue` 在 TUI slash 词表。client in-flight 时 `/continue` → `busy_stop_first`，原 turn 不被 abort，且不发起第二次 continue。compact in-flight 时 `/continue` 同 EXIT。pending 表内 NL skip-append。Ctrl+C 仍停 turn。`npx vitest run tests/tui` 与 `npm run typecheck` exit 0。
   - Status: [ ] pending
   - [blocks: T2 #688]
   - [parallel] 与 T3、T5

5. **[parallel] T5 Web slash + POST /continue** ([#691](https://github.com/winter6205/iknow/issues/691)) — tag: `[implementation]`
   - **Inherits:** EXIT `web_slash_http_only`：本 slice Web = `/continue` slash + `POST .../continue` only；Composer NL matcher **OUT**；不新增 `GET /pending`；禁止用 `ChatUiMessage` / SPA timeline / DTO turns 算 P0–P7。slash 词表对齐 TUI **slash**（不是 NL 表），走专用 POST。Composer 普通发送仍 `postMessage`。`continue_http_no_fallback`：`POST .../continue` 返回 `nothing_pending` 或任何 continue `ValidationError` 时 client 只展示 EXIT，**永不** auto-fallback 到 `postMessage`。Web _client_ `busy_stop_first`：busy 时不发 HTTP continue。unbound 与 `postMessage` 相同。
   - **Surface:** `web/`
   - **Acceptance:** slash `/continue` 只打 `POST .../continue`。400 / continue `ValidationError` 后面板只展示 EXIT，不 `postMessage`。本 slice 无 Composer NL continue-intent matcher。无 `GET .../pending`。Web client busy 时 `/continue` 不发 HTTP。P0–P7 不从 SPA timeline 计算。`npx vitest run tests/web` 与 `npm run typecheck` exit 0。
   - Status: [ ] pending
   - [blocks: T2 #688]
   - [parallel] 与 T3、T4
