# TUI transcript mount window

## Problem

`ChatView` maps every `session.messages` entry into a live OpenTUI tree inside `<scrollbox>`. `#343` deleted `MessageBlocksClipped` on the assumption that scrollbox culls off-screen rows; OpenTUI is retained-mode — off-screen `MessageBlocks` / `Markdown` nodes still exist. Long sessions freeze. LLM `/compact` does not fix the UI tree.

Mainstream agents (Claude / Cursor / ChatGPT) keep full session data but only mount a near-end window, with an “earlier messages” affordance.

## Root cause

Unbounded UI mount of the transcript, not unbounded session storage.

## Plan

1. Pure `selectTranscriptMountWindow` in `src/tui/transcript-mount-window.ts`.
2. `ChatView` mounts the window + stub; `PgUp` at scroll top reveals another page; preserve scroll-from-bottom on prepend.
3. Session data unchanged.

## Files

- `src/tui/transcript-mount-window.ts` (new)
- `src/tui/chat-view.tsx`
- `tests/tui/transcript-mount-window.test.ts` (new)
- `tests/tui/chat-view-scroll.test.tsx`

Out of scope: Web `MessageList`, restoring row-window math, LLM compact.

## ACR verdict

- bounded-context-guardian: yes — stays in TUI capability (`src/tui/`); no web/harness reverse import
- defensive-contract-validator: yes — window fn covers empty / negative / overflow / concurrent (pure) / exception
- error-handling-enforcer: yes — invalid `messages` is typed `TypeError`; no empty catch
- complexity-anti-drift: yes — slice helper is one abstraction; ChatView still maps one window
- minimal-change-verifier: yes — one logical task, no compact/web/row-ledger revival
