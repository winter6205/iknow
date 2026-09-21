# Spec: interrupt frozen prefix keep

**Status:** ready for plan  
**Surface:** `src/shared` (freeze splitter), `src/harness` (in-flight closeout), `src/session-api` (persist alignment), `src/tui` (Markdown becomes caller-side; settle still paints the store)

## Goal

On Esc **foreground interrupt**, the already-frozen complete blocks of live generation stay in the authoritative history and on screen; only the block still growing is discarded. All three surfaces (at interrupt / reopen / next-turn prior) show the same shape.

## Settled invariants

1. **Granularity = streaming block freeze** (ADR-0108): `prefixRaw` enters this turn's assistant; `tailRaw` is discarded. No prefix → no assistant is recorded, and cancelled still writes the **interrupt system message**.
2. **The SSOT is in closeout, not the TUI overlay.** The accumulated streaming text must be a buffer the harness/host can read at abort time (same-source bytes as the on-screen draft). After settle removes the overlay, only this history is painted.
3. **The splitter module** lands in a layer the harness can already import (the `src/shared` seam). The TUI only calls it. `src/harness` importing `src/tui` is forbidden.
4. **Tools in flight unchanged**: already-appended assistant content stays; an in-flight tool → `execution_failed` `"cancelled"`. A closed `tool_use` not yet executed → the existing cancelled backfill.
5. **Timeout** uses the same keep splitter; no `Interrupted by user.` is appended.
6. **`/continue`** still only strips the trailing interrupt from this run's prior; the frozen prefix stays on disk and in the prior.
7. **Order:** split → (if there is a prefix, append the assistant and commit) → if cancelled, append the interrupt and commit. If the assistant commit fails, take the existing **MessageCommitError** path — never leave only the interrupt behind and pretend the prefix entered history.
8. Non-string accumulation → the splitter's existing typed failure (consistent with the current freeze input contract); no empty catch.

## Out of scope

- Changing Esc / Ctrl+C key bindings
- Keeping every streamed token (the granularity not chosen)
- Timeout-specific product copy
- Coloring of settle states kept/collapsed/named
- iknow-memory / dream / GC
- Changing `transport-continue-persist.md`'s continue / retry contract (only the interrupt keep composes with it)

## Input-contract classes (public surfaces)

| Surface                     | empty                                                         | invalid/negative                               | overflow                                                     | concurrent                                                | exception                                                              |
| --------------------------- | ------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| freeze split                | `""` → prefix empty, tail empty, boundary 0                    | non-string → typed throw, no keep              | over-long markdown is still split by the same rule; no new truncation cap invented | same discipline as the current freeze unit tests ("reentry / boundary only advances") | lexer failure must not be swallowed by an empty catch                   |
| `run()` cancelled, model in flight | nothing accumulated or no prefix → messages = user + interrupt, no assistant | splitter typed throw → must not be written as a fake successful-cancelled history | with a prefix, the whole prefix goes into the assistant (size governed by the existing message caps) | once abort has happened, stop waiting for a full model step; never double-write two assistants | `commitMessages` throws → **MessageCommitError**; never append an orphan interrupt |
| `run()` timeout, model in flight | same keep splitter; no interrupt line                          | same as left                                     | same as left                                                 | the clock abort must not be labeled a user cancel (existing ADR-0091) | same commit failure                                                    |
| persist / load              | a cancelled disk state without prefix = user + interrupt       | never keep a failed half assistant as protocolError | N/A                                                          | N/A                                                       | save failure bubbles via the existing commit-failure path              |
| TUI settle                  | overlay empty, store has prefix → paint from the store         | never let overlay leftovers overwrite the store | N/A                                                          | if `finally` drops the draft before `turnFinished` swaps the snapshot: the snapshot is authoritative | N/A                                                                    |

## Success criteria

- SC1: with the model in flight and a non-empty `prefixRaw` splittable from the accumulated text, after cancellation `result.messages` contains the assistant carrying that prefix, followed by `Interrupted by user.`.
- SC2: with only `tailRaw` (no prefix), after cancellation there is no assistant for this turn, and still user + interrupt.
- SC3: reopen/load has the same shape as SC1/SC2.
- SC4: an ordinary next-turn prior contains the frozen prefix and the interrupt; `/continue` may drop the trailing interrupt from this run's prior while the prefix remains.
- SC5: timeout with the model in flight keeps the same prefix rules as SC1/SC2, without the interrupt line.
- SC6: harness source contains no `from "../tui/` (or equivalent tui import).
- SC7: tools-in-flight cancelled keeps the existing four-message shape (user / assistant / tool_result / interrupt) without regression.

## Measured / out-of-band

The operator's on-screen feel of really pressing Esc in the TUI is not the CI gate for this spec's landing; SC1–SC7 are locked by unit tests.
