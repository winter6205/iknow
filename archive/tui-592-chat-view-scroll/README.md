# ARCHIVED #592

Frozen snapshot of `tests/tui/chat-view-scroll.test.tsx` at `5bf185de` (`fix(tui): mount only a tail window of ChatView history`). Live tests dropped the tail-window / pagination cases in `2d07e5a9`.

These assertions are the **wrong** product:

- `↑ 68 条更早的消息`
- `not.toContain("msg-000")`
- `revealOlder`

Do not restore them. Live contract is **viewport mount** + a **full scroll document**: scroll to top shows `msg-000`, no stub. Banner leaving the viewport as messages grow is intended **方案 B**.

Not collected: `vitest.config.ts` excludes `archive/**`; `npm test` runs `bun test tests/tui/` only.
