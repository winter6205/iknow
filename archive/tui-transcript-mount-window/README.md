# tui-transcript-mount-window

> **Status: ARCHIVED.** Frozen snapshot of the #592 message-level tail-window
> unit. Not a live contract; do not restore into `src/` or `tests/`.

## Why

#592 introduced a 32-message tail cap (`TRANSCRIPT_TAIL_DEFAULT = 32`) that
mounted only the last N session messages into the OpenTUI tree. That cap was
a mistaken product choice.

Current product is viewport mount: `specs/tui-transcript-viewport.md`.

## Do not run

Default `npm test` does not collect this tree: `package.json` runs
`bun test tests/tui/`; `vitest.config.ts` excludes `archive/**`.

Snapshot commit: `5bf185de` (parent of revert `2d07e5a9`).
