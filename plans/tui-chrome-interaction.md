# Plan: TUI chrome interaction

**Goal:** Long-running TUI turns keep honest folds, prompt-vs-model chrome, skill-load as a chip, and subagent identity in the input chrome — not as a second tool card.
**Approach:** Skip-spec grilling (operator declined a wayfinder map and a spec file). Slice display contracts into one-commit bullets; T6 lands a chrome-focus reducer so T7 can wire keyboard and footer order without growing `app.tsx` into a god-handler. Web skill-load UI is out of this round. Write-tool content streaming stays out (operator withdrew it); only the false `0 行` count is in.
**Spec link:** none (skip-spec). Contract = grilling resolution in session 2026-09-07 plus this plan's Inherits.
**ACR:** all-yes after split (pre-slice ACR blocked MCV/DCV/CAD; bullets below are the fix)
**Tracker:** 本地 markdown（操作员明确不开 GitHub issue；#914–#920 已关）。子弹与依赖只以本文件 Tasks 为准。
**Worktree:** `/home/winner/projects/iknow/.claude/worktrees/tui-chrome-interaction` on `worktree-tui-chrome-interaction`
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on `worktree-tui-chrome-interaction`

```
bounded-context-guardian: yes — display-only in TUI; SubagentInfo.role remains harness read projection; no session-api schema, no spawn semantics, no new bounded context.
defensive-contract-validator: yes — each implementation bullet names empty / negative / overflow / concurrent / exception for that slice (see Acceptance).
error-handling-enforcer: yes — no new failure policy; incomplete write JSON keeps the existing typed EXIT (no dump, no null status line); skill-load projection never throws on missing remainder.
complexity-anti-drift: yes — T6 is the named chrome-focus reducer (one abstraction for input | subagent-row | graph); fold / slash / write-summary stay in their existing TUI modules; layout in T7 only composes.
minimal-change-verifier: yes — seven logical tasks, one commit each; this file is the split that unblocked the pre-slice MCV no.
```

## 待写入

（已 flush：`unit fold` / `skill-load display projection` / `chrome focus` → worktree `docs/CONTEXT.md`）

## Tasks (ordered by dependency)

1. **Running unit fold + historical retract gate** — tag: `[implementation]`
   - **Inherits:** Fold by **completed unit**, not by whole-turn idle. Live thinking that has ended becomes `思考了 N 秒` while tools still run. Successful retract-class tools enter the count fold as they finish (they must not vanish from live tail with nowhere to go). `showTurnFold` / equivalent must **not** key off only the **current** turn's retract total: if the live turn has `turnToolTotal = 0`, earlier turns' retract folds still render. Keep keep-class (bash etc.) expanded. Insertion order (fold after the matching text) stays.
   - **Surface:** TUI (`chat-view` / turn-activity / think-fold)
   - **Acceptance:** empty: no thinking and no retract → no fold lines. negative: `thinkingMs` missing/0/non-finite → no `思考了 N 秒` row (empty string skip). overflow: many retract tools → count line, not one row per call. concurrent: two fold computations do not share mutable boundary. exception: hidden user messages still map `thinkingMs` via source index (no silent hideThinking double-kill). Running frame shows unit folds for finished units; idle last-turn bash-only does not strip earlier retract folds. Guard: `bun test tests/tui/`. Complexity gates: `complexity-anti-drift` skill, not copied here.
   - Status: [ ] pending
   - [parallel]

2. **Assistant fill off; user prompt fill on** — tag: `[implementation]`
   - **Inherits:** Model / assistant text has **no** `assistantBg` panel; Markdown formatting stays. Submitted user messages keep `userBg`. Prompt input should share that filled family (border-only today is a gap). Code fences keep their own `codeBlockBg` (contrast after the outer shell goes away). Fold rows follow assistant (no panel), not user fill.
   - **Surface:** TUI (message shell / message-blocks / prompt-input / theme tokens)
   - **Acceptance:** empty: empty assistant text → no leftover filled box. negative: user message still filled. overflow: long markdown still formats. concurrent: live draft and history assistant share the no-fill rule. exception: missing palette token does not blank the transcript. Visual: fence background still distinct from terminal default.
   - Status: [ ] pending
   - [parallel]

3. **write_file running count is honest** — tag: `[implementation]`
   - **Inherits:** While running, omit line count until `content` is a string with length &gt; 0; never show `（0 行）` in running. Settled empty file may show `（0 行）`. Path-only running line: `写入 path`. Do **not** stream write `content` into a CodeBlock this round.
   - **Surface:** TUI (tool-summary / live-tool-preview)
   - **Acceptance:** empty: no partial JSON → `[运行中] write_file` (or equivalent running name line), no `0 行`. negative: `content` missing or `""` while running → path without count. overflow: large content → count when known, still 6-line completed preview unchanged. concurrent: two runs' counts isolated. exception: incomplete JSON EXIT unchanged (no raw dump). Settled empty file → `0 行` allowed.
   - Status: [ ] pending
   - [parallel]

4. **Slash hint hides after a committed skill/command name** — tag: `[implementation]`
   - **Inherits:** Suggestion list is for **disambiguation**. Exact unique first-token match (skill or static command) → empty list. Exact match plus space/remainder → empty list even if longer sibling names exist. Prefix ambiguity (`/way` → two skills) → list remains. Exact name without space but longer siblings exist → list shows **only** longer siblings, not the already-complete name. Tab/Enter send paths stay.
   - **Surface:** TUI (`slash` + prompt hint consumption)
   - **Acceptance:** empty: non-`/` input → no hints. negative: unknown `/zzzz` → no hints (or unknown path unchanged). overflow: many skills with shared prefix still filter. concurrent: two `slashSuggestions` calls isolated. exception: mixed-case exact skill match still hides. `/skillname remainder` → 0 hint rows. Unique `/skillname` → 0 hint rows.
   - Status: [ ] pending
   - [parallel]

5. **Skill-load chip, not a user-prompt dump** — tag: `[implementation]`
   - **Inherits:** Model still receives `buildSkillLoadText` envelope. TUI never paints SKILL body as the user bubble. Visible: `loading skill <name>` plus remainder as the human prompt when remainder is non-empty; remainder-empty → chip only. Survives `turnFinished` session reload (projection at render, not only echo). `↑` history already skips skill-load envelopes; transcript must match. English chip, not `加载技能`.
   - **Surface:** TUI (session-state projection / message-blocks user branch)
   - **Acceptance:** empty: remainder empty → one chip line, no body. negative: non-skill user message unchanged. overflow: huge SKILL body in JSONL → still chip-only on screen. concurrent: two sessions' projections isolated. exception: malformed `[skill-load` without closed name → do not throw; treat as ordinary user text or skip body if prefix matches short form. Reload after turn still chip-only.
   - Status: [ ] pending
   - [parallel]

6. **Chrome-focus reducer (input | subagent | graph)** — tag: `[implementation]`
   - **Inherits:** One reducer owns focus: `input` | `subagent` (row index) | `graph`. Down from input (last visual line, no slash hint capturing Down) → first visible subagent row if any, else graph if snapshot exists. Up from first subagent row → input. Down past last subagent row → graph if present, else stay. Up from graph → last subagent row if any, else input. Multiline input still consumes Down/Up inside the textarea until visual overflow. Named split: **one chrome-focus reducer**; wiring stays out of this bullet.
   - **Surface:** TUI
   - **Acceptance:** empty: no subagents and no graph → Down from input does not steal focus. negative: Down while slash hints open → hint cursor, not chrome. overflow: many subagent rows → index clamps. concurrent: two reduce calls isolated. exception: missing snapshot / empty panel → skip that ring. Pure reducer tests cover the 5 classes; PromptInput not required to rewire yet.
   - Status: [ ] pending
   - [parallel]

7. **Subagent chrome stack + spawn leaves the tool card** — tag: `[implementation]`
   - **Inherits:** No dual render. `spawn_subagent` / `subagent_result` do **not** appear as `▣ 子代理` live/history tool cards or ContextBar suffix. Identity: immediately **above** the prompt, `{role} running...` (catalog id, e.g. `general-purpose running...`; multiple joined with `·`; dim/default, no task text). **Below** the prompt: colored rows `{name} {current task}` (focus widens task). Footer order below the prompt: subagent task list → ContextBar (model + ctx) → **worktree isolation line** → graph. Unbound worktree still 0 lines. Completed subagents still omit standing rows (failed short window unchanged).
   - **Surface:** TUI (app chrome compose / subagent-panel / context-bar / live tool display / graph chrome)
   - **Acceptance:** empty: no live subagents → no above-prompt strip and no list. negative: missing `role` → do not print `子代理`; use catalog fallback `general-purpose` or omit strip if no id (implementer picks one; tests lock it). overflow: long taskPreview truncates unfocused, expands when that row is focused. concurrent: two conversations' subagent lists do not leak. exception: spawn still executes; only display changes. ContextBar has no `▣ 子代理`. Worktree line, when present, is below ContextBar not above. Down/Up match T6 once wired. `bun test tests/tui/`.
   - Status: [ ] pending
   - [blocks: T6]

## 收尾

全部 bullet 落地后跑一轮 code review（整轮改动，非每 bullet 重复），对照本文件 Inherits。
