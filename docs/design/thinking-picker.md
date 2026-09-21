# thinking-picker design (editor-minimalist style)

> Status: **final (two-panel version)** — implement directly from this
> document.
> Input: `/thinking` or `/effort` + Enter → **does not take effect directly**;
> an overlay panel pops up.
> Semantic baseline: same source, same values as the live `/thinking` toggle +
> `/effort` level states (`thinkingEnabled` / `thinkingEffort`). This design
> only changes the interaction entry point and does not touch
> `computeThinkingOverride` semantics.

## Revision record (two-panel version, final)

The early version (§0–§8 below) merged `/thinking` and `/effort` into a
**single three-state panel** (off/auto/manual): Enter submitted and closed, Esc
cancelled. After user clarification that version was **discarded**; the final
design uses **two independent panels**:

- **`/thinking` = a pure toggle panel** (ON/OFF): affects only
  `thinkingEnabled`, never `thinkingEffort`. Its on-screen title is the
  "thinking toggle" label (exact string in `src/tui/thinking-picker.tsx`).
- **`/effort` = a pure level panel** (low/medium/high/xhigh/max, 5 levels):
  affects only `thinkingEffort` (implicitly `thinkingEnabled=true`), never the
  toggle. Its on-screen title is the "thinking intensity" label (exact string
  in `src/tui/thinking-picker.tsx`).
- The two panels share one visual style: rounded flowing-light border + purple
  gradient progress bar + boundary water-line.
- **Enter = select and pin**: pins the current choice as the panel's committed
  value while the **panel stays open** for further adjustment (in the toggle
  panel Enter pins the current ON/OFF preview without flipping it; in the level
  panel Enter pins the focused level as the committed one).
- **Esc = save and exit**: writes the panel's pinned values into the real
  `thinkingEnabled` / `thinkingEffort`, then closes the panel. **There is no
  cancel/discard path.**

§0–§8 below are kept as the historical design process; key routing and
rendering follow the source `src/tui/thinking-picker.tsx` —
`reduceThinkingSwitchKey` / `reduceThinkingEffortKey` / `ThinkingPicker` (the
`ThinkingPickerState` discriminated union).

---

## §0 Design baseline (code facts, required reading for the implementer)

- The state already lives in `src/tui/app.tsx` (introduced in 9f8a4e0):
  - `thinkingEnabled: boolean` — the `/thinking` toggle (affects model
    requests), initial `props.defaultThinking?.mode === "adaptive"`,
    **default off**.
  - `thinkingEffort: ThinkingEffortWire` —
    `"" | "low" | "medium" | "high" | "xhigh" | "max"`, initial
    `props.defaultThinking?.effort ?? ""`, **default medium** (env
    `IKNOW_LLM_THINKING_EFFORT` default `""` → the display layer maps it to
    `medium`).
  - Effect path: `runTurnOnce` →
    `computeThinkingOverride(defaultThinking, thinkingEnabled, thinkingEffort)`
    → `bridge.postMessage({ thinking })`. **This design does not modify that
    gate**; the picker is only a new entry point to `setThinkingEnabled` /
    `setThinkingEffort`.
- Semantics (this design must preserve them):
  - **Auto on** → `setThinkingEffort("")`; the 5 levels gray out
    (unselectable).
  - **Pick a level** → `setThinkingEffort(picked)` +
    `setThinkingEnabled(true)` (implicit on); the Auto dot flips to ○
    automatically.
  - **Level default medium** (env default `""` → displays `medium`; an
    explicit env level echoes that level).
  - **Auto default off**.
- After the panel opens, **the input box is already cleared** (`handleSubmit`
  starts with `setInputValue("")`); it stays empty after Enter/Esc — this
  design keeps that behavior.
- Key routing conflict: OpenTUI's global `useKeyboard` is **single-channel**
  (app.tsx's existing rewind/ask modals all use the "exclusive while active"
  pattern). The picker follows the same discipline: **while pickerOpen ≠ null,
  `useKeyboard` intercepts ←/→/Tab/Space/Enter/Esc/printable chars at the
  top**, otherwise they fall through to existing routing. The interception
  **must** be inserted **after** the Shift+Tab / Ctrl+C branches and **before**
  the rewind-picker branch (priority: Ctrl combos > picker > rewind > double
  Esc > ask modal).
- Key names: `KeyEvent.name` values `space`, `left`, `right`, `tab`, `return`,
  `escape` (same pattern as existing `e.name === "return"`). Anything with
  `e.ctrl` / `e.meta` is never intercepted (left to the app layer).

---

## §1 Panel ASCII sketches

### Static skeleton (when open, occupies 5 rows)

```
┌──────────────────────────────────────────────┐
│ 思考控制          auto ●           [Esc 取消] │
│                                                │
│  low  medium  high  xhigh  max                 │
│                                                │
│ ←/→ 切档 · Tab/Space 开关 · Enter 生效          │
└──────────────────────────────────────────────┘
```

Terminal width ≥ 40 columns; the panel is **fixed at 5 rows** regardless of
level/state. Between the dot row and the level row, and between the level row
and the hint row, one blank row each (implemented with
`<box flexDirection="column" gap={1}>`, see §6).

### Variant a: auto off + medium as current level

```
 思考控制          auto ○   [Esc 取消]
                                       ← 提示不换行，整行 dim
  low  medium  high  xhigh  max
                          ↑
                   current 档：BOLD + selected 反白底（50ms 闪后定格）
 ←/→ 切档 · Tab/Space 开关 · Enter 生效
```

### Variant b: auto off + high as current level

```
 思考控制          auto ○   [Esc 取消]

  low  medium  high  xhigh  max
                      ↑
           current 档前移：同款 BOLD + 反白底

 ←/→ 切档 · Tab/Space 开关 · Enter 生效
```

### Variant c: auto on + all 5 levels disabled

```
 思考控制          auto ●   [Esc 取消]

  low  medium  high  xhigh  max      ← 5 档全部 DIM，无反白
                        └ 均灰显，当前档不再高亮（无 current）

 ←/→ 切档 · Tab/Space 开关 · Enter 生效
```

### The fundamental v1/v2 differences (candidate comparison → final choice)

- **Candidate 1 (one `─` rule at top and bottom)**: would need
  `<box borderStyle="single" border={["top","bottom"]}>` or custom
  `customBorderChars`. OpenTUI 0.5's `border` supports `BorderSides[]` so it is
  doable, but it introduces 2 rows of hard rules, conflicts with "zero
  decoration", and the `border` array form has no existing code precedent.
- **Candidate 2 (no border at all, pure blank-row separation + bold title)**:
  the blank-row separation needs panel margins to create visual distance from
  the input box — panel height 5 rows plus surrounding blank rows complicates
  the row budget.
- **Candidate 3 (title row only + single column)**: one column cannot host two
  interaction surfaces (Auto dot + 5 levels in parallel); information density
  is insufficient.
- **Final choice: `rounded` border + `borderColor={pal.border}` gray,
  `paddingX={1}`, `marginBottom={1}`, with a title row**. Rationale: directly
  reuse the **same rounded gray frame as PromptInput** in app.tsx (the
  `chat-view.tsx` banner also uses `borderColor={pal.border}`) — single-color
  gray, low visual noise; `rounded` is a row-count shape already asserted by
  existing tests; the **restrained color scale** is guaranteed by token
  selection (no new colors invented). The key differences from SelectModal are
  listed in §5. Top/bottom `─` rules = **not used**; hint blocks are separated
  by **blank rows** (`gap`) + semantic colors, not by rules.

---

## §2 Visual decision table

| Element                                           | Color token                     | attribute             | Animation                        | Notes                                                                      |
| ------------------------------------------------- | ------------------------------- | --------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| title text (panel heading, see the §1 sketch)     | `text`                          | BOLD                  | none                             | the first token on the left                                                |
| Esc hint in the title row (see the §1 sketch)     | `dim`                           | DIM                   | none                             | shares the title row on the right, space-between layout (`justifyContent="space-between"`) |
| Auto label `auto`                                 | auto on → `running`; auto off → `text` | auto on → BOLD; off → NONE | none                        | value-semantic color + weight                                              |
| Auto dot `●`/`○`                                  | on → `running`; off → `text`    | none                  | **none** (static)                | the dot itself is the state bit                                            |
| 5 level labels (not current, auto off)            | `text`                          | NONE                  | none                             | all same color, no progression                                             |
| current level label (auto off)                    | `accent`                        | BOLD                  | **one 50ms reverse flash (inOutQuad)** | the only animation, see §3                                                 |
| current-level reverse background                  | `selected` (bg)                 | —                     | same 50ms                        | coexists with BOLD; `<span fg={pal.accent} bg={pal.selected} attributes={BOLD}>` |
| 5 level labels (auto on, disabled)                | `dim`                           | DIM                   | none                             | grayed out; no highlight, no reverse                                       |
| separators between levels                         | none (spaces)                   | —                     | none                             | plain 2-column space separators; no pipes, no block characters             |
| hint row (switch levels / toggle / commit; see the §1 sketch) | `dim`           | DIM                   | none                             | fixed text; never changes with state                                       |
| panel border                                      | `border` (gray)                 | —                     | none                             | rounded, `paddingX={1}`, `marginBottom={1}` (same as PromptInput)          |
| panel background                                  | none (transparent)              | —                     | none                             | do not use block backgrounds like `codeBlockBg`                            |

---

## §3 Animation (0~1 allowed, final: **1**)

**Principle**: only user actions get feedback; feedback <150ms; no
loop/alternate/pulse/breathing; no enter/exit animation (the picker appears the
instant it opens and vanishes the instant Esc is pressed — minimalism rejects
decorative transitions).

**Final: when the level changes, the current-level glyph flashes in reverse
once for 50ms.**

- Implementation: `useTimeline({ autoplay: false })` (created locally in this
  component, not shared globally); `Timeline.add(flashTarget, { duration: 50,
  ease: "inOutQuad", onUpdate, onComplete })`.
  - `flashTarget` = a plain object `{ t: 0 }`; in `onUpdate(a)` read
    `a.targets[0].t` as 0→1 progress and map it to the **reverse intensity**:
    `t < 0.5 ? reverse bg on : off` (first half of the 50ms lit, second half
    off — **no smooth fade-out; it is a hard switch**, which matches "flash").
  - Or simpler: `useTimeline` + `add`, and clear the reverse flag via
    `setState` in `onComplete`. The implementer picks one; mapping `t` to a
    nonexistent "opacity" is **forbidden**.
- Flashes once; switching to a new level re-triggers immediately (reset the
  timeline or add again).
- **The no-animation alternative was rejected**: with a pure state switch the
  current level's position change would be imperceptible (see §8 risk 1); the
  50ms hard flash is the lowest-cost compensation, strictly <150ms with no
  loop.
- **The Auto dot never flashes** and **disabled gray never flashes**: the
  animation budget is spent only on level switching.

---

## §4 Keyboard interaction state machine

```
状态空间：
  pickerOpen: null | "thinking" | "effort"     ← 打开源头（/thinking vs /effort）记录，Esc 后可区分
  autoOn: boolean                               ← 面板内暂存（未提交）
  focusedIndex: 0..4                             ← 5 档（low=0 … max=4）；autoOn 时锁定为 -1 语义（不可选中）

初始：/thinking 回车 → { pickerOpen:"thinking", autoOn:thinkingEnabled, focusedIndex:effortToIndex(thinkingEffort) }
      /effort 回车 → { pickerOpen:"effort",  autoOn:thinkingEnabled, focusedIndex:effortToIndex(thinkingEffort) }
      （两者初始 autoOn 相同、focusedIndex 相同——唯一区别是 Esc 后的提示文案，见下）

事件 → 转移（全部在 app.tsx useKeyboard 顶部、pickerOpen≠null 时短路；无 ctrl/meta）：

  LeftArrow  (pickerOpen≠null && !autoOn)  → focusedIndex = max(0, focusedIndex-1)         [重触发闪]
  RightArrow (pickerOpen≠null && !autoOn)  → focusedIndex = min(4, focusedIndex+1)          [重触发闪]
  LeftArrow  (autoOn)                      → no-op（档位 disabled，不可聚焦）
  RightArrow (autoOn)                      → no-op
  Tab        (pickerOpen≠null)             → autoOn = !autoOn    （Tab 与 Space 同效）
  Space      (pickerOpen≠null)             → autoOn = !autoOn    （Tab 与 Space 同效）
  Enter      (pickerOpen≠null)             → commit() → pickerOpen=null
  Escape     (pickerOpen≠null)             → cancel() → pickerOpen=null
  可打印字符 (pickerOpen≠null)             → ignore（不吞键：滚回输入框无副作用；不设 hotkey 直选）
  其余 (up/down/ctrl组合/etc)              → ignore（让给既有路由）

commit() 语义（写入 app.tsx 既有 state，全部与现网一致）：
  if (autoOn)        → setThinkingEffort("");  setThinkingEnabled(true)   ← 维持 Auto 开 = effort ""；不开 thinking 则违背"显示即生效"（/effort 语义隐式 enabled）
  else               → setThinkingEffort(LEVELS[focusedIndex]); setThinkingEnabled(true)
  // 注：picker 无"仅关思考"通道（Auto off 必须选一个 concrete 档）。纯 off 语义走输入框 `/thinking` 旧路？——
  // 定案：**不提供**。picker 是"把思考开 + 选强度"的面板；关思考仍是 `/thinking` 直接切换（现网行为保留）。
  // 该取舍记入 §8 风险 3。

cancel() 语义：
  → 不写 thinkingEnabled / thinkingEffort（面板是预览，Esc 全放弃）
  → pickerOpen=null
  → 若打开源是 /effort 且用户 Esc：不报"已取消"notice（无噪音）；输入框保持空。
  → 若打开源是 /thinking 且用户 Esc：同上。

无状态变化事件：
  Enter 在 autoOn && focusedIndex 无效时 → 仍 commit（autoOn 分支不读 focusedIndex），合法。
  Esc 重复按 → 第二次时 picker 已 null，落回既有双 Esc 路由（不冲突：picker 分支只在 ≠null 时短路）。
```

**Boundary**: `pickerOpen` is mutually exclusive with the existing rewind
picker / ask modal — this design intercepts **before** the rewind branch in
`useKeyboard`, so the two can never be active at once. Render slots are
mutually exclusive for the same reason (§5 row budget 5).

---

## §5 Relationship to existing modals

**Not to copy (SelectModal traits):**

- rounded border `borderColor={pal.running}` (gold frame) → switch to the
  gray `pal.border` frame.
- title in running color + BOLD → switch to `text` BOLD.
- `❯ ` selection cursor prefix → **not used** (minimalist: the current level
  uses a reverse background, no cursor prefix).
- key-hint row wording style (the SelectModal "up/down select · Enter confirm
  · Esc collapse" pattern) → replaced by this panel's own hint (switch levels
  / toggle / commit; see the §1 sketch).

**To borrow (chat-view.tsx banner minimalism):**

- `borderStyle="rounded"` + `borderColor={pal.border}` (gray-brown, low
  noise).
- `paddingX={1}`, `marginBottom={1}` (same distances the existing chrome uses
  to the input box / picker).
- left-aligned title (`titleAlignment="left"` is a pattern the banner already
  uses).

**Module ownership: a standalone `src/tui/thinking-picker.tsx`, not inlined
into app.tsx.**

- Rationale: same shape as `rewind-picker.tsx` (picker as its own module +
  host holds state); a pure-function reducer (`reduceThinkingPickerKey`) is
  unit-testable (the existing rewind/ask follow the same discipline); render
  component + row-budget function share one file (SSOT).
- File contents: `THINKING_LEVELS` (reuse `ADJUSTABLE_EFFORT_LEVELS`, no
  duplicate definition), `effortToIndex` / `indexToEffort` (SSOT mapping),
  `ThinkingPicker` render component, `reduceThinkingPickerKey` pure function,
  `thinkingPickerRows()` row budget.
- app.tsx responsibilities: hold the `pickerOpen / autoOn / focusedIndex`
  state; short-circuit routing at the top of `useKeyboard`; render
  `{pickerOpen !== null && <ThinkingPicker .../>}`; `commit/cancel` write the
  existing `setThinkingEnabled/setThinkingEffort`.

**Row budget (5 rows; wrapModalLines not needed):**

```
thinkingPickerRows(cols) 恒返回 5：
  行1 标题行（标题 + auto + [Esc 取消]）
  行2 空行（gap 1）
  行3 档位行（5 档）
  行4 空行（gap 1）
  行5 提示行
```

- No wrapping (the 5 level labels are fixed width; the title row's auto + Esc
  hints are fixed length; the minimum 40 columns is enough); it produces no
  `wrapModalLines` physical-row prediction (modals never wrap).
- But it must be **counted into chromeReserveRows**: a new `pickerRows`
  parameter (the same `+1` marginBottom accounting as `modalRows`), otherwise
  the viewport height gets squeezed. Together with the useKeyboard
  short-circuit, these are the only two places app.tsx must change in sync.

---

## §6 OpenTUI rendering details

- **Border**: `<box borderStyle="rounded" borderColor={pal.border}
  paddingX={1} marginBottom={1}>`; **do not use** `─` single-rule separators
  or top/bottom half frames (the border-array form has no precedent and adds
  visual noise). `rounded` is the shape whose row counts existing tests
  already assert (same family as modal/input/banner), the lowest-risk choice.
- **Inner padding**: `paddingX={1}` (same as PromptInput/banner); inline
  alignment: title row `justifyContent="space-between"`, level row
  `justifyContent="flex-start"` (left-aligned, never centered — centering
  makes the levels jump; minimalist left-alignment is steadier).
- **Column-width budget (≥40 columns)**: title (4 wide CJK glyphs = 8 columns
  in the sketch) + `auto` + dot + the Esc hint + the right-side hint (~24
  columns) — fits within 40 columns; no wrapping or truncation needed.
- **No progressive colors for the 5 levels**: all `text` (auto off) / `dim`
  (auto on, disabled); **only the current level** gets `fg={pal.accent}
  bg={pal.selected} attributes={BOLD}` (reverse background = the `selected`
  token; `TextAttributes.REVERSE` is unavailable — see below).
- **TextAttributes.REVERSE availability**: the `createTextAttributes` signature
  in `utils.d.ts` has an `inverse` bit, but the `TextAttributes` constants
  exposed in `types.d.ts` **have no REVERSE** (only
  NONE/BOLD/DIM/ITALIC/UNDERLINE/BLINK/INVERSE/HIDDEN/STRIKETHROUGH).
  **Final: use the `bg={pal.selected}` reverse background, not
  `TextAttributes.INVERSE`** (INVERSE relies on the terminal's reverse-video
  rendering and is unstable across terminals; an explicit bg is
  deterministic). Reverse background coexists with BOLD:
  `<span fg={pal.accent} bg={pal.selected}
  attributes={TextAttributes.BOLD}>`.
- **Level visualization: plain text labels, space-separated** — `low  medium
  high  xhigh  max` (fixed 2-space separators). **No** `[low] [medium] …`
  brackets (brackets are a code/state-symbol convention; levels are values),
  **no** `|` pipes (a pipe reads as a separator, not an option). 2 spaces
  between levels = the minimum decorative gap, in keeping with minimalism.
- **Title style: bare vs bracketed vs ruled** — **final: the bare heading, no
  brackets, no rules**. The bracketed form is already the established symbol
  of the collapsed thinking line (`THINKING_FOLD_LINE` in
  `message-blocks.tsx`), so bracketing the panel title would visually clash
  with the message-area fold lines; `── ──` rules are decoration, rejected by
  minimalism. Title = undecorated, BOLD, `text` color.
- **Auto dot**: `auto ●` / `auto ○` (fullwidth dots, 2-column aligned, `●`
  U+25CF / `○` U+25CB — stable even on narrow terminals). `running` gold reads
  as "on", `text` white as "off". **When the 5 levels are disabled the dot is
  automatically ●** (autoOn means ●), consistent with variant c in §1.
- **Panel placement**: in the app.tsx render tree the panel sits above
  `ModalHost` and below the notice (positioned ahead of the input box, i.e.
  "directly above the input"). `<box flexDirection="column">` floats it
  naturally in render order.
- **Disabled level row**: when autoOn=true the whole row is `<text
  fg={pal.dim} attributes={DIM}>`, no BOLD, no bg.

---

## §7 Test matrix (≥8; the design is pure functions + render assertions, all directly testable)

**Reducer unit tests (`reduceThinkingPickerKey`,
`tests/tui/thinking-picker.test.tsx`):**

| #   | picker state                       | key event                           | expected output                                  |
| --- | ---------------------------------- | ----------------------------------- | ------------------------------------------------ |
| 1   | autoOn=false, focusedIndex=2(high) | →                                   | move, index=3 (xhigh), flash                     |
| 2   | autoOn=false, focusedIndex=4(max)  | →                                   | move, index=4 (clamped at top)                   |
| 3   | autoOn=false, focusedIndex=0(low)  | ←                                   | move, index=0 (clamped at bottom)                |
| 4   | autoOn=true, focusedIndex=2        | →                                   | ignore (disabled, cannot focus)                  |
| 5   | autoOn=false, focusedIndex=1       | Tab                                 | toggle, autoOn=true                              |
| 6   | autoOn=false, focusedIndex=1       | Space                               | toggle, autoOn=true (same effect as Tab)         |
| 7   | autoOn=true, focusedIndex=1        | Space                               | toggle, autoOn=false                             |
| 8   | any                                | Enter (autoOn=false, focusedIndex=3) | commit, { autoOn:false, level:xhigh }           |
| 9   | any                                | Enter (autoOn=true)                 | commit, { autoOn:true } (focusedIndex not read)  |
| 10  | any                                | Esc                                 | cancel (discard everything)                      |
| 11  | any                                | up / down / ctrl+c                  | ignore (fall through to existing routing)        |
| 12  | any                                | printable char 'a'                  | ignore (no hotkeys defined)                      |

**App-layer integration (`tests/tui/thinking-picker.test.tsx` or an extension
of `app.test.tsx`):**

| #   | operation                                    | expected                                                                                                                      |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 13  | type `/thinking`, Enter                      | input cleared; panel appears; panel heading as in the §1 sketch; auto shows the current `thinkingEnabled` (default ○); the reverse highlight sits on the level mapped from the current effort (default medium) |
| 14  | Space + Enter inside the panel               | thinkingEnabled=true, thinkingEffort="" written (Auto takes effect); panel closes                                             |
| 15  | →→ + Enter inside the panel                  | thinkingEffort=high (2 right of medium); thinkingEnabled=true; panel closes                                                   |
| 16  | Esc inside the panel                         | state unchanged (thinkingEnabled/Effort keep their old values); panel closes                                                  |
| 17  | type `/effort`, Enter                        | panel opens (same panel as /thinking); initial focusedIndex = current level                                                   |
| 18  | `/effort` opened, then plain Enter (autoOn=false) | equivalent to `/effort <current level>`: writes thinkingEffort=current level + thinkingEnabled=true (semantics equal to the existing notice) |
| 19  | Ctrl+O while the panel is open               | Ctrl+O is not swallowed: fold-state toggling still works (the picker branch only intercepts unmodified keys)                  |
| 20  | Ctrl+C while the panel is open               | copy logic is not broken by the picker (the ctrl branch precedes the picker; the interrupt key has since moved to Esc in the keybinding migration) |

**Row-budget unit tests (additions to `tests/tui/chrome-budget.test.ts`):**

| #   | input                                   | expected                      |
| --- | --------------------------------------- | ----------------------------- |
| 21  | thinkingPickerRows(80)                  | 5                             |
| 22  | chromeReserveRows({...}) vs +pickerRows | difference = 6 (5 rows + marginBottom 1) |

---

## §8 Risks and trade-offs (≤5)

1. **No sustained visual feedback; the user may not know the current level**:
   the reverse only flashes for 50ms, after which the current level relies on
   the `accent` + `selected` background (in variants a/b the current level
   keeps a **persistent reverse background** — the flash is the
   switching-moment emphasis; the persistent reverse marks the current
   position). If the implementer builds "flash then disappear" per §3 alone,
   this risk comes back — **the §2 table must keep the persistent `selected`
   reverse background on the current level** (already final).
2. **Missing transitions feel abrupt**: the panel opens/closes with no
   animation. A minimalist trade-off, accepted; compensation = the panel's
   position is fixed (directly above the input) and its height fixed at 5
   rows, so nothing jumps.
3. **The picker has no "turn thinking off" channel**: Auto off requires
   choosing a concrete level (implying enabled=true). Cases needing pure off
   still go through `/thinking` in the input box. If users expect the picker
   to also close thinking, that is a requirements gap — **deliberately not
   extended** (refusing a "second toggle mechanism"), recorded as pending
   confirmation.
4. **Enter commits directly = the user may change state without looking at the
   panel** (plain Enter on `/effort` equals the old `/effort <current
   level>`). Low risk: the old semantics already meant "effective immediately";
   the picker only adds a preview layer, the current level is reversed by
   default, and Enter "confirms the status quo".
5. **Key hijacking risk**: Space types a character into the input box, but
   while the picker is open the input has no focus (`PromptInput disabled`)
   and the global single-channel useKeyboard short-circuits — test #20 must
   confirm Ctrl combos are not swallowed (this design intercepts after the
   Ctrl branches, already mitigated).

---

## One-sentence summary

The defining aesthetic of this version = **restraint**.
