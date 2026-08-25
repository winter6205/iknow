# Spec: continue_pending（截断后续跑）

> Wayfinder map: [#270](https://github.com/winter6205/iknow/issues/270) · impl/spec [#686](https://github.com/winter6205/iknow/issues/686) · Resolution [#277](https://github.com/winter6205/iknow/issues/277)（**不重开**；产品逻辑已冻结）。
> 术语 persist 在 sibling `worktree-continue-pending-term`（`01b1266`）；本 worktree 的 `docs/CONTEXT.md` 尚无该条。本文件 **不写** CONTEXT / ADR；见文末 **待写入**。
> `architecture-change-reviewer`: parent blocker 已按 **OPTION 2**（EXIT `web_slash_http_only`）+ error-handling 三合同写入下文；**不重开** #277。无 plan 文件（本 slot 只改 spec）。

## 待写入（domain-modeling；本 spec 不落盘）

将下列条文原样写入 `docs/CONTEXT.md` Language 段（插在 **rewind head** 与 **turnCount** 之间，与 `01b1266` 一致）。本 spec 把词条里的「sanitize 悬空 `tool_use`」**操作化为** `closeoutOrphanToolUses`，**不是** `sanitizeSessionFile`（见 §Sanitize vs closeout）。

**continue_pending**: 截断后在**同一会话**把未完成的工具环接着跑完——先对人停住；用户再用 `/continue` 或（有 pending 时）续跑意图自然语言触发；不追加新任务 user message，先 sanitize 悬空 `tool_use`，再对已有 append-only messages 调用 `run`（#277）。匹配词表/策略属 spec；**不是** ACI 工具。
_Avoid_: continue 工具；把续跑口令一律当普通新 user 任务句；新建 session 挂旧历史；无确认自动续跑

## ASSUMPTIONS（parent #277 / explorer 已收；不重开）

1. 产品逻辑在 host，**不是** ACI 工具、不进 `createDefaultAciRegistry`。
2. **Stop first**：对人停住之后才续跑。**EXIT `busy_stop_first`** 只在 CLI/TUI/Web _client_ idle/busy-guard：busy 时拒绝**发起** continue，不 abort 原 turn。HTTP **没有**该 EXIT（EXIT `http_serialize_like_compact`）。
3. 触发（**#277 产品逻辑，不重开**）= `/continue` **或** pending-only NL（ZH+EN 整行词表）；同一 `conversationId`；**不**新建 session。**本 slice 落地（OPTION 2 / EXIT `web_slash_http_only`）：** CLI/TUI = slash + pending NL；Web = 仅 `/continue` slash + `POST .../continue`。Web Composer NL matcher **OUT this slice**（不是取消 #277 NL；后续 slice 可补 Web NL）。本 slice **不**加 `GET /pending`。
4. **不**追加新任务 user message；`run()` 必须有 skip-append / prior-only 缝（今日 `run()` **总是** `encodeUserText`）。
5. 悬空 `tool_use` 用 load 投影 `closeoutOrphanToolUses`，不用 `sanitizeSessionFile` 修 tool 对。
6. `MaxTurnsExceeded` 后 JSONL 通常已提交上一 turn；host DTO/chat state 可能 stale → continue **必须** `store.load`。
7. ask oneshot OUT；worker OUT；`/goal` auto EXCLUDE。
8. serve **在本 slice**：专用 `POST .../continue`，镜像 `POST .../compact`，**禁止**空 `postMessage`。
9. 无新 runtime 依赖；栈仍 TypeScript + vitest。

→ 以上视为已确认。实施不得把 #277 当未决问题重开。

## Problem

工具环被人停住、撞上 `maxTurns`、进程补洞之后，用户没有「接着跑完」的口令。今日 `run(userText)` 总会 `encodeUserText` 再追加一条 user；空 `POST /messages` 被 `validateText` 拒绝。host 在 `MaxTurnsExceeded` 路径上返回的 session 投影可能落后于 JSONL。续跑若误走 schema sanitize，修不好 tool 对。

## Solution

Host 增加 **continue_pending**：先停、再由用户触发；`store.load`（closeout 投影）→ 纯函数 pending 谓词 → 对已有 messages 调 `run`（skip-append）→ 同一 `conversationId` 落盘。CLI/TUI：NL 只在 pending 时吃词表。Web 本 slice：**不**跑 Composer NL matcher（slash → HTTP）。`/goal` 钉着则拒绝。

## Objective

chat REPL / TUI 用户在 HITL 截断之后，用 `/continue` 或 pending 词表 NL，在**同一会话**把未完成的工具环跑完；serve+Web 用户用 `/continue` slash（`POST .../continue`）达到同一效果。不把 slash / HTTP continue 口令写成新任务句、不注册 continue 工具、不进 `/goal` 自动循环。Web Composer 续跑意图 NL **不是**本 slice 成功条件（#277 的 NL 由 CLI/TUI 覆盖）。

成功 = 谓词可测、skip-append 不追加 user、MaxTurns 后续跑读盘不读 stale DTO、五类边界测试绿。

## Boundaries

- **Does:**
  - `src/harness/loop-engine.ts` 现有 `run()` 增加 skip-append 缝（默认关 = 今日行为）。
  - 纯函数 pending 谓词（load 后的 messages + `session.goal`）；CLI/TUI NL 整行词表（§Trigger）；Web 无 NL 表。
  - Host：`SessionHub` 专用 continue（与 `compactSession` 同 serialize 队列）；`src/session-api/http.ts` `POST /sessions/:id/continue`；`src/cli/slash.ts` + `chat-session.ts`；`src/tui/slash.ts` + busy-guard（镜像 `/compact`）；`web/src/lib/slash.ts` 对齐 TUI **slash 词表**，走专用 POST。CLI/TUI 可 import session-api 谓词；Web **只** HTTP，**禁止**用 `ChatUiMessage` / SPA timeline 算 P0–P7。
  - 续跑前用 `store.load` 的 closeout 投影；不把 `sanitizeSessionFile` 当 tool 对修复。
- **Confirms with human:** 无（#277 已收）。词表扩 alias 只允许 plan 在同一整行 helper 里加行，见 Open Questions。
- **Out of this spec:**
  - ACI / `createDefaultAciRegistry` 增工具。
  - `iknow ask` / oneshot；`src/harness/subagent/worker.ts` continue API。
  - `/goal` 自动循环续跑（`src/session-api/goal-auto.ts` / `src/harness/verify/` 零改）。
  - 空 `POST /messages`、空 `userText` 冒充 continue。
  - 新持久化字段（不 bump schema 存 `lastStopReason`）。
  - 改 compact 触发、任务摘录、rewind UX、FaultClass / fused 检测本身。
  - 无确认自动续跑。
  - Web Composer / pending NL continue-intent matcher（本 slice OUT；#277 产品 NL 仍由 CLI/TUI 实现）。
  - `GET /sessions/:id/pending` 或任何 pending 探测 HTTP（OPTION 2：Web 不算谓词，slash 直接 POST）。
  - 从 `ChatUiMessage` / SPA timeline / DTO turns 推导 P0–P7。

## Inherits / Changes

**Inherits（现行抄录 / 指针）：**

- **append-only messages**: Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加（`[...prev, x]`）更新，禁止原地修改或建立第二份权威副本。磁盘形态见 **session transcript**（JSONL 事件投影出当前头的 messages）。
- **session transcript** / **rewind head**：ADR-0027；`specs/session-jsonl-resume.md`。
- **in-flight closeout** 与 load 投影 SSOT：`closeoutOrphanToolUses`（`src/session-api/store/closeout-projection.ts`）；session-jsonl-resume D5–D6。
- **StopReason**: completed / maxTurns / nonSuccessStop / protocolError / emptyFinalResponse / cancelled / timeout / fused（ADR-0029 末尾追加，不重排）。
- **ACI tool set**: 现有 registry；continue **不是**其中一件。
- **oneshot / ask**、**Session HTTP API**、**正常模式** / **自动模式** / **goal**：`docs/CONTEXT.md` 现行条。
- ADR-0011：`MaxTurnsExceeded` throw；摘要不进 `_messages`。Hub catch **不**把 throw 路径当「磁盘无新 messages」——commit 钩子可能已写完上一 turn。
- ADR-0012：`maxTurns` 每 **run** 从 0 计；continue 是一次新 `run()`，预算重置，这是续跑能越过上次上限的原因。
- ADR-0013：PromptTooLong reactive compact 仍在该次 continue `run` 内，不另开机制。
- ADR-0027 / session-jsonl-resume：Loop Engine 零 IO；host 注入 commit；同一 store。
- ADR-0024 / `specs/verify-goal-gate.md`：HITL vs `/goal` 两套模块。continue 只走 HITL `run` 包装（允许既有 verify-loop HITL）；**禁止** `runGoalAutoLoop`。

**Changes：**

- `run()` skip-append（见 §Harness entry）。
- Host continue 入口：`/continue`；CLI/TUI pending NL；Web 仅 slash + `POST .../continue`。
- 索引：`specs/README.md` 本文件一行。

## Pending predicate

权威输入 = `store.load(conversationId)` 之后的 `file.messages`（**已**走 `closeoutOrphanToolUses`）+ `file.goal`。**禁止**用 TUI `lastStopReason`、hub catch 返回的 `PostMessageResponse.session`、或未 reload 的 `CliChatState.messages` 当 SSOT。**禁止**从 `ChatUiMessage` / SPA timeline / DTO turns 计算 P0–P7。CLI/TUI 可 import session-api 谓词；Web 客户端不算谓词，只调 `POST .../continue`。

分类时若末条是 interrupt system（`text === "Interrupted by user."`，与 `loop-engine.ts` `SYSTEM_INTERRUPT_TEXT` 同一字面），**只为谓词**剥掉末条再看前一条。剥掉不得改盘、不得改传入 `run` 的 prior（§cancelled EXIT keep）。

| #   | 形状（load + closeout 后）                                                               | pending? | 命名 EXIT                                              |
| --- | ---------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------ |
| P0  | `messages.length === 0`                                                                  | no       | `nothing_pending`                                      |
| P1  | `goal` 已钉（`source = user_pin` 且 text 非空）                                          | no       | `goal_active`（即使尾部是 tool_result）                |
| P2  | 谓词所见最后一条 user 文本 === `LOOP_DETECTED_TEXT`（`src/harness/tool-loop-detect.ts`） | no       | `fused_clean_stop`                                     |
| P3  | 最后一条 assistant **无** `tool_use`，且至少一块非空 `text`                              | no       | `nothing_pending`（HITL 已交还）                       |
| P4  | 最后一条是 **仅** `tool_result` 的 user                                                  | yes      | maxTurns / 工具中 cancel·timeout / process closeout 尾 |
| P5  | 最后一条 assistant **含** `tool_use`                                                     | yes      | 防御：load 后按契约不应再有孤儿；若有仍 pending        |
| P6  | 最后一条是普通文本 user（非 tool_result、非 LOOP_DETECTED）                              | yes      | 用户句已落盘、assistant 未提交                         |
| P7  | 最后一条 assistant 无 `tool_use` 且无非空 text（空/仅 thinking）                         | yes      | `emptyFinalResponse` 类未交还                          |

busy（in-flight turn 或 in-flight compact/continue）**不是** transcript 谓词。

- **EXIT `busy_stop_first`（仅 CLI/TUI/Web _client_）：** idle/busy-guard 先于 continue 调用。busy → 拒绝发起（不调 hub / 不发 `POST .../continue`），不 abort 原 turn。
- **EXIT `http_serialize_like_compact`（HTTP / hub）：** `POST .../continue` **没有** `busy_stop_first`。in-flight 与 `POST .../compact` 相同：hub serialize/queue。HTTP 不得因「已有 in-flight」返回 `busy_stop_first`。

## Trigger surface

`/continue`：trim 后 slash；command 大小写不敏感；**禁止参数**（任何 args → `usage`）。显式命令：即使 NL 不会匹配，slash 仍走 continue；谓词失败则 EXIT，**不**把 `/continue` 当 user 任务句。Web slash 经 `POST .../continue`：谓词/校验失败见 EXIT `continue_http_no_fallback`。

NL（**仅 CLI/TUI this slice**）：**仅当 pending 为 true** 才查表。命中 → continue（skip-append）。未命中 → 普通新任务（append）。pending 为 false 时 NL **永不** continue（「please continue」当普通 query）。Web Composer **不**查此表（EXIT `web_slash_http_only`）。

词表 = **整行**精确匹配：`trim`；英文 `toLowerCase`；**不**子串、**不**分词、**不** LLM 分类、**不**折叠行内空白。禁止单短词当匹配（避免 `continue the migration` / 单字口令误伤）。

| 命中（整行）      | 语言 |
| ----------------- | ---- |
| `please continue` | EN   |
| `continue please` | EN   |
| `keep going`      | EN   |
| `go on`           | EN   |
| `请继续`          | ZH   |
| `接着做`          | ZH   |
| `接着跑`          | ZH   |
| `继续跑`          | ZH   |

**EXIT `nl_not_single_token`：** 整行 `continue` / `resume` / `go` / `续` / `继续` **不**在表内 → 一律当普通 query（pending 时也会 **append** 成新任务句）。用户要用 slash `/continue`。（CLI/TUI；Web 无 NL 表。）

**EXIT `nl_pending_only`：** CLI/TUI：不 pending 时不查表、不 continue。Web：无 NL 表（不适用）。

**EXIT `web_slash_http_only`：** 本 slice Web = `/continue` slash + `POST .../continue` only。Web NL continue-intent matcher **OUT**。不新增 `GET /pending`。

| Surface               | `/continue`                                  | pending NL                               | 备注                                                                                                                             |
| --------------------- | -------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| CLI `iknow chat`      | yes（`parseChatLine` + `applySlashCommand`） | yes（query 分支、谓词为真时先于 `run`）  | 有 `conversationId` 则 `store.load`；测试无盘路径用当前 freeze 的 messages 当 load 替身                                          |
| TUI                   | yes（`VOCABULARY` + help/hint）              | yes（`parseTuiInput` kind=message 之后） | _client_ busy-guard 镜像 `/compact`：in-flight turn/compact/continue → `busy_stop_first`；Ctrl+C 停 turn，不拿 continue 当 abort |
| session-api           | `POST /sessions/:id/continue`                | 无（HTTP 显式）                          | 镜像 `POST .../compact`：可空 body；**禁止**空 `POST .../messages`；**无** `busy_stop_first`（serialize/queue）                  |
| Web SPA               | yes（`SLASH_COMMANDS` 对齐 TUI；走 POST）    | **OUT this slice**                       | Composer 普通发送仍 `postMessage`。slash/`POST .../continue` 失败 → EXIT `continue_http_no_fallback`，**禁止**再 `postMessage`   |
| `iknow ask` / oneshot | OUT                                          | OUT                                      |                                                                                                                                  |
| worker                | OUT                                          | OUT                                      |                                                                                                                                  |
| `/goal` auto          | EXIT `goal_active`                           | EXIT `goal_active`                       |                                                                                                                                  |

serve unbound：与 `postMessage` 相同，`ValidationError` `field=workspaceRoot`。

## Harness entry

今日（必须改）：

```ts
// loop-engine run(): 总会
freezeMessage(deps.adapter.encodeUserText(effectiveUserText));
```

本 spec 缝（现有 `run` 签名上加 opts，**不**新入口文件）：

```ts
opts?: {
  priorMessages?: ReadonlyArray<AnthropicNativeMessage>;
  onStream?: (event: HarnessStreamEvent) => void;
  appendUserText?: boolean; // default true — 缺省与今日 byte-identical
};
```

| `appendUserText`             | 行为                                                                                                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true` / 缺省                | 今日：`prior + encodeUserText(userText)`                                                                                                                                                                                                      |
| `false`                      | **不**调用 `encodeUserText`；`messages = freeze(priorMessages ?? [])`；`userText` 必须是 `""`（否则 harness typed throw `skip_append_with_text`，类定义在 `src/harness/errors.ts`：new typed class extending existing harness error pattern） |
| `false` 且 prior 缺席或 `[]` | harness typed throw `skip_append_empty_prior`（同上，`src/harness/errors.ts`）                                                                                                                                                                |

Host continue：`appendUserText: false`，`userText: ""`，`priorMessages` = load 后 messages（含 trailing interrupt system，见下）。Secret roundtrip：skip-append 不跑 `recognize(userText)`（无新 user 文本）。

## Sanitize vs closeout

| 函数                     | 职责                                                                          | continue 用？                                  |
| ------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| `sanitizeSessionFile`    | schema / 版本 / 缺字段；**拒绝**坏 `messages` 形状，**不**补 tool 对          | 否（load 内部照旧；continue **不**靠它修孤儿） |
| `closeoutOrphanToolUses` | load 投影：孤儿 `tool_use` → `encodeToolResults` `process` closeout；API 合法 | **是**（经 `store.load`；SSOT）                |

continue **禁止**再写一套 sanitize 去删/改 `tool_use`。发给 `adapter.step` 的 messages **不得**含未配对 `tool_use`（继承 session-jsonl-resume）。

## MaxTurnsExceeded reload

事实：超限在**下一** `step` 入口 throw；上一 assistant+tool_result 多半已 commit 进 JSONL。Hub catch 仍 `summarize({ file: session })` 用 **run 前** 的 `session` → DTO stale。CLI `CliChatState.messages` 同样可能停在 throw 前快照。

**EXIT `reload_before_continue`：** 每次 continue（CLI/TUI slash 与 NL；HTTP `POST .../continue`；Web slash 经该 POST）在谓词与 `run` 之前 `store.load`（**host/hub** 执行；Web 客户端不 load、不算谓词）。测试必须构造「host 数组缺最后一轮 tool_result、盘上有」→ continue 的 `priorMessages` 含盘上那轮，且 `encodeUserText` 调用次数 = 0。`store.load` 失败：走既有 `mapStoreError`（**不**新 store error kind）。

ADR-0012：此次 continue 是新 `run`，`turnCount` 从 0；显式 `maxTurns` 可再次撞上限。

## Surfaces / `/goal` isolation

- continue = 一次 HITL `run`（可走既有 verify-loop **HITL** 模块）。**禁止** `runGoalAutoLoop` / 把 continue 当自动模式下一跳。
- **EXIT `goal_active`：** `session.goal` 钉着 → 拒绝 continue（slash 与 CLI/TUI NL；HTTP continue 同）。用户先 `/goal clear`。零改 `src/harness/verify/`。
- **EXIT `fused_clean_stop`：** fused 是环检测的干净停（ADR-0029）。continue 不把 LOOP_DETECTED 尾当未完成工具环。用户要换思路就发**新**任务句（会 append；信封留在历史上）。
- **EXIT `cancelled_keep_interrupt`：** 不剥、不 rewind 掉 trailing `Interrupted by user.`。谓词分类可忽略它；`priorMessages` 与盘一致。禁止为 skip 改 append-only。
- **EXIT `serve_dedicated_post`：** serve 在本 slice；`POST /sessions/:id/continue`；空 `POST /messages` 仍 400 `message text must be non-empty`。
- **EXIT `http_serialize_like_compact`：** HTTP in-flight 与 compact 相同——serialize/queue on hub。HTTP **没有** `busy_stop_first`。
- **EXIT `busy_stop_first`：** 只在 CLI/TUI/Web _client_ idle/busy-guard（发起 continue 之前）。
- HTTP 失败映射：
  - 谓词拒绝 `nothing_pending` / `goal_active` / `fused_clean_stop` / `usage` → `ValidationError` 400（`field=continue` 或已有 `workspaceRoot`）。
  - harness `skip_append_with_text` / `skip_append_empty_prior`（`src/harness/errors.ts` typed class）→ host 映射为 HTTP `ValidationError` 400；**不**把 harness 类直接当 wire kind。
  - `store.load` 失败 → 既有 `mapStoreError`；**不**新 store error kind。
  - 409 仍只用于既有 `concurrent_write`，不征用。
- **EXIT `continue_http_no_fallback`：** `POST .../continue` 返回 `nothing_pending`（或任何 continue `ValidationError`）时，CLI/TUI/Web **client 只展示该 EXIT**——**永不** auto-fallback 到 `postMessage` / 新任务 NL（即使 Web NL matcher 本 slice OUT，slash/HTTP continue 仍遵守本条）。
- 成功 wire：复用 `PostMessageResponse`（一次 turn）。不新造 compact 那种 `compacted` 形。

建议 PR 切分（文件名不新造模块；helper 是否抽出由 plan 定，落点只能是既有 capability：`src/harness/`、`src/session-api/`、`src/cli/`、`src/tui/`、`web/`）：

1. `run()` skip-append + harness 测
2. 谓词 + CLI/TUI NL 表纯函数 + 测
3. hub continue + HTTP（serialize/queue；`mapStoreError`；skip_append → ValidationError 400）
4. CLI slash + NL
5. TUI slash + _client_ busy-guard
6. Web slash → `POST .../continue`（无 Composer NL；无 GET `/pending`；`continue_http_no_fallback`）

## Testing（5 boundary classes）

命令：

```bash
npm run typecheck
npx vitest run tests/harness/loop-engine.test.ts tests/session-api tests/cli tests/tui tests/web
```

（plan 可收窄 glob；合入前上列领域相关测必须覆盖本 spec 行。）

- **empty：** 空会话 `/continue` → `nothing_pending`，`run` 不调用；`encodeUserText` 不被 continue 路径调用。Web/HTTP：`POST .../continue` → `ValidationError` 400；client 只展示 EXIT，不 `postMessage`。
- **negative：** 末条 text-only assistant → `nothing_pending`；LOOP_DETECTED 末 user → `fused_clean_stop`；已钉 goal + tool_result 尾 → `goal_active`；CLI/TUI 整行 `continue` / `继续` → 当普通 query（pending 时 **会** append）；`continue the migration` → append 新任务；ask/worker 无 continue API；spy：continue 不调「用 sanitizeSessionFile 修 tool 对」。本 slice **不**要求 Web Composer NL 命中 continue。
- **overflow：** 超长非精确 NL → 普通 query，仍受 `MAX_MESSAGE_CHARS`（CLI/TUI）；skip-append 不因 continue 再追加 user 文本。
- **concurrent：** CLI/TUI/Web _client_ in-flight 时 `/continue` → `busy_stop_first`，原 turn 不被 abort，且 **不发** HTTP continue；TUI compact in-flight 时 `/continue` → 同 EXIT。HTTP：并发 `POST .../continue` 走 hub serialize（与 compact 同），**不**返回 `busy_stop_first`。MaxTurns 后 stale host vs 盘 → load 赢。
- **exception：** `store.load` throw → 既有 `mapStoreError`，不 `run`、不新 store kind；崩溃孤儿 `tool_use` → load closeout 后 step 输入无未配对 id；`appendUserText: false` 且 `userText !== ""` → `skip_append_with_text`（`src/harness/errors.ts`）；host 映射 HTTP `ValidationError` 400；trailing interrupt 仍在 continue 的 prior 里。`POST .../continue` 任意 continue `ValidationError` → client **不** fallback `postMessage`。

## Success Criteria

每条 yes/no：

1. `run({ appendUserText: false, priorMessages })` 不调用 `encodeUserText`；缺省 `run("hi")` 仍调用一次。
2. continue 不向 messages 追加任务 user 句（slash、CLI/TUI 表内 NL、HTTP POST continue 皆然）。Web Composer NL 本 slice 无此 SC。
3. 同一 `conversationId`；不 create session。
4. `src/harness/aci/` 无 continue 工具名。
5. 谓词表 P0–P7 各有测试锁 EXIT（输入 = load 后 messages + goal；**不是** `ChatUiMessage`）。
6. MaxTurns：盘上有最后 tool_result、host 快照没有 → continue prior 含盘上块。
7. 孤儿 `tool_use` 经 load closeout 后不进 `adapter.step`。
8. `/goal` 钉着 → continue 拒绝；`goal-auto` / `verify/` 本 slice 零 diff。
9. fused 尾 → 拒绝 continue。
10. ask oneshot 与 worker 无 continue 入口。
11. `POST /sessions/:id/messages` 空 text 仍 400；continue 只走 `POST /sessions/:id/continue`。无 `GET .../pending`。
12. TUI/Web `/continue` 在 slash 词表；_client_ busy 时不发起第二次 continue（HTTP 无 `busy_stop_first`）。
13. CLI `/help` 含 `/continue`；表内 ZH+EN NL 在 CLI/TUI pending 时 skip-append。
14. `npm run typecheck` 与上列 vitest 路径 exit 0。
15. Web 本 slice：slash → `POST .../continue` only；不算 P0–P7；无 Composer NL matcher。
16. `POST .../continue` 的 `nothing_pending` / 任何 continue `ValidationError` → client 只展示 EXIT，永不 `postMessage` fallback。

## Open Questions

已关闭（命名 EXIT，实施不得当未决）：

| EXIT                                                | 决议                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nl_not_single_token`                               | 单短词不进 NL 表（CLI/TUI）                                                                                                                      |
| `nl_pending_only`                                   | CLI/TUI：NL 只在 pending 时触发 continue                                                                                                         |
| `web_slash_http_only`                               | 本 slice Web = slash + POST only；Web NL matcher OUT；无 GET `/pending`；禁止 `ChatUiMessage` 算 P0–P7                                           |
| `fused_clean_stop`                                  | fused = 干净停，不 pending                                                                                                                       |
| `goal_active`                                       | `/goal` 钉着 → continue 拒绝                                                                                                                     |
| `cancelled_keep_interrupt`                          | 不剥 trailing interrupt system                                                                                                                   |
| `serve_dedicated_post`                              | serve 在本 slice；专用 POST                                                                                                                      |
| `ask_out` / `worker_out`                            | oneshot 与 worker 不做                                                                                                                           |
| `reload_before_continue`                            | continue 前必须 `store.load`（hub）；失败走既有 `mapStoreError`                                                                                  |
| `closeout_not_schema_sanitize`                      | 补洞 SSOT = closeout 投影                                                                                                                        |
| `busy_stop_first`                                   | 仅 CLI/TUI/Web _client_ idle/busy-guard；busy 时拒绝发起，不 abort                                                                               |
| `http_serialize_like_compact`                       | HTTP in-flight = hub serialize/queue（同 compact）；HTTP 无 `busy_stop_first`                                                                    |
| `skip_append_with_text` / `skip_append_empty_prior` | harness 守卫：`src/harness/errors.ts` typed class（new typed class extending existing harness error pattern）；host → HTTP `ValidationError` 400 |
| `nothing_pending` / `usage`                         | 空/已交还/带参 `/continue`                                                                                                                       |
| `continue_http_no_fallback`                         | POST continue 的 `nothing_pending` / 任何 continue `ValidationError` → client 只展示 EXIT，永不 `postMessage` / 新任务 NL                        |

留给 plan 的 `[decision]`（不得推翻上表）：

- [decision] 是否在**同一**整行 helper 为 CLI/TUI NL 表加 alias（仍 ZH+EN、禁止子串与单短词、禁止分类器；不把 alias 扩到 Web Composer）。
- [decision] EXIT 用户可见中英一句的最终 copy（测试锁语义；字面可在 plan 定一种）。
- [decision] pending 纯函数放在 `src/session-api/` 既有邻域（如 `goal-auto.ts` 旁）还是 inline；**不**新开 capability 目录。
- [decision] `PostMessageResponse` 是否加 optional `continued?: true`（缺省不加也能 SC 过）。
