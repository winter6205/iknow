# Markdown fenced code-block rendering candidates · c4 final

> Task: a side branch of the logo redesign — moving the TUI fenced code block
> from the ink-era baseline through 5 candidates to the c4 final. **Formal
> implementation**: the merged PR (commit `30df69d`). This file archives the
> exploration so we don't regress.
>
> Related: `docs/design/DESIGN-BANNER.md` (the same-batch banner redesign
> wrap-up), `docs/design/DESIGN-BANNER-GRADIENT.md` (the same-batch gradient
> final).

## Decision in one sentence

Fenced code block = **c4**: dark-gray background `#1e1e1e` (same as the VSCode
dark+ editor area) + default text color `#d4d4d4` + 4-color syntax highlighting
(keyword purple `#c586c0` / string orange `#ce9178` / number light-green
`#b5cea8` / comment green `#6a9955` + DIM + ITALIC) + inline codespan keeps
`#66b8ae` unchanged + **no border + no lang label**.

## The 5 candidates

The 5 candidates were rendered by `scripts/codeblock-preview/c1.tsx` ~ `c5.tsx`
(the scripts were deleted with the prototype worktree; this file records the
decision process). Each candidate came with a real TUI screenshot, and the
operator chose by visual feel.

### c1 current baseline

- Form: box border single (top / bottom / left / right single-line border) +
  a centered `<lang>` label inlaid in the top border
- Colors: the whole block in one color `#66b8ae` (same as the inline codespan)
- Problems:
  - the top border + lang label make the block read as a "panel", not like
    inline content
  - single color = no token distinction; indentation / quotes / keywords all
    carry the same visual weight, hard to skim
  - the border is visually too heavy inside the scrollbox

### c2 light-gray background + no border

- Form: no border, no title, whole-block background `#2b2f36`
- Colors: the whole block in one color `#e6e4dc` (warm off-white)
- Pros: without the frame the block blends into the body text, no visual
  clash
- Problems:
  - same single-color problem as above (no token distinction)
  - under a dark theme, the light-gray background has weak edge contrast and
    the block boundary is unclear

### c3 light-gray background + regex syntax highlighting

- Form: same as c2 (light-gray background `#2b2f36` + no border)
- Colors: hand-written regex tokenizer, 4-color syntax highlighting:
  - keyword purple `#c586c0`
  - string orange `#ce9178`
  - number light-green `#b5cea8`
  - comment green (c3 tried adding DIM + ITALIC)
- Default text color: `#e6e4dc` (kept from c2)
- Pros: skimmability clearly improved
- Problems:
  - the light-gray `#2b2f36` doesn't sit close enough to the brand dark;
    research decided to go one step darker
  - inline codespan and code-block text color clash (both warm-family),
    weakening the inline-to-block transition

### **c4 (final)**

- Form: no border, no title, dark-gray background `#1e1e1e` (same as the
  VSCode dark+ editor area)
- Colors:
  - whole-block background `#1e1e1e`
  - default text color `#d4d4d4` (VSCode dark+ default editor fg)
  - keyword purple `#c586c0` / string orange `#ce9178` / number light-green
    `#b5cea8` / comment green `#6a9955` + DIM + ITALIC
- Inline codespan: **keeps** `#66b8ae` untouched (differentiated from the
  fenced block)
- Geometry:
  - over-wide lines don't wrap: `wrapMode="none"`
  - empty lines still paint the background, no collapse (each row's bg stays
    `#1e1e1e`)
  - marginTop/Bottom between blocks = 1
- diff fences: lines starting with `+` / `-` get a full-line green/red
  background mask (`#2ea043` / `#d73a49` fg + `#1f3d2b` / `#3d1f24` bg,
  aligned with the 4 `add`/`del`/`bgAdd`/`bgDel` tokens in theme.ts)
- Pros:
  - same as the VSCode dark+ editor area → zero cognitive cost for users
  - 4-color syntax highlighting + DIM/ITALIC comments = maximum skimmability
  - inline codespan vs block text color differentiated (`#66b8ae` vs
    `#d4d4d4`), so the inline context flows naturally
  - no border makes the block read as part of the text stream, not stealing
    the scene
- Selection rationale (operator's decision): "the VSCode style matches at a
  glance, the dark-gray background suits the product's dark theme, and no
  border + no lang label makes the code block feel like part of the markdown"

### c5 c3 + leading language tag on the first row

- Form: c3 plus a leading `ts │` tag on the first row (inline, not a border)
- Problems:
  - c4 already proved "no lang label" is the better answer; c5 re-adding a
    label backtracks
  - the leading tag breaks the markdown text flow (the first row gains an
    extra column of special characters)

## Product implementation (commit `30df69d`)

### 6 new tokens in theme.ts

```ts
codeBlockBg: "#1e1e1e",   // VSCode dark+ editor area
codeDefault: "#d4d4d4",   // plain text (no syntax token matched)
syntaxComment: "#6a9955", // comment (+ DIM + ITALIC)
syntaxString: "#ce9178",  // string
syntaxNumber: "#b5cea8",  // number
syntaxKeyword: "#c586c0", // keyword
```

The `code: "#66b8ae"` field stays, used **only** for the inline codespan,
differentiated from code blocks.

### markdown.tsx rewrite

- `tokenizeCodeLine(line: string): CodeToken[]` is an **exported** pure
  function — the split exists so unit tests can exercise the regex / capture
  group logic without rendering JSX (assert on `CodeToken[]` directly). Return
  type `CodeToken { kind: CodeTokenKind, text: string }`,
  `CodeTokenKind = "plain" | "comment" | "string" | "number" | "keyword"`.
- `CodeBlock` container + `CodeBlockLine` row renderer rewritten:
  - `CodeBlock` outer `<box backgroundColor={codeBlockBg}>`, no border no
    title
  - `CodeBlockLine` renders each row as `<text bg={codeBlockBg}
    wrapMode="none">`, split by `tokenizeCodeLine`, then each token embedded
    in `<span fg={matching color}>`, with `comment` tokens also carrying
    `attributes={DIM | ITALIC}`
- All other markdown elements (heading / paragraph / list / quote / table /
  html / inline codespan) are untouched.

### Tests

`tests/tui/markdown.test.tsx`:

- removed 1 old test (the lang label sat in the border row; c4 has none)
- added 11 c4 contract assertions (`codeBlockBg` background color / 4 syntax
  token classes colored / plain coloring / no border characters / no lang
  label / diff `+` / `-` rows / empty lines keep their background)
- 4 `tokenizeCodeLine` unit tests (keyword / string / number / comment
  splitting)

## Verification record

- `tests/tui/markdown.test.tsx`: the 11 c4 + 4 tokenize tests above all green
- Real-TTY smoke: `npm run dev:tui` renders code blocks matching the VSCode
  dark+ look in a real terminal
  (`docs/handoff/2026-08-10-tui-321-regression-fixes.md` acceptance checklist)

## References

| Type                         | Path / reference                                                      |
| ---------------------------- | --------------------------------------------------------------------- |
| product implementation (merged) | commit `30df69d` — feat(tui): markdown code blocks to the c4 form |
| theme 6-token SSOT           | `src/tui/theme.ts:42-53` (comments + values at 86-91)                 |
| CodeBlock rewrite            | `src/tui/markdown.tsx:158-` `CodeToken` type + `tokenizeCodeLine`     |
| unit tests                   | `tests/tui/markdown.test.tsx`                                         |
| related                      | `docs/design/DESIGN-BANNER.md` (same-batch banner redesign)           |
| related                      | `docs/design/DESIGN-BANNER-GRADIENT.md` (same-batch gradient final)   |
