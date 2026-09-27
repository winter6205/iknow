# 0126. Persist the terminal outcome of each model turn

Date: 2026-09-26
Status: accepted

## Context

An observed model call exhausted its 32,000-token output cap in thinking. The Loop Engine currently returns `nonSuccessStop` for a truncated response without tool calls, but the session transcript saves messages without that outcome. Reopening the session causes Web to project every reconstructed answer as `completed`; TUI loses the prior stop reason. A truncated response containing `tool_use` can also enter tool execution before its supplier stop is checked.

## Decision

The model adapter normalizes the supplier stop. The Loop Engine alone maps that signal to the authoritative `StopReason`; output-limit truncation is a failed turn with `stopReason: nonSuccessStop` and separate typed supplier-stop detail `truncation`. A non-success supplier stop terminates the turn before any tool calls from that incomplete response execute, even if the response contains `tool_use`.

The session transcript records one append-only `turn outcome` event per settled host turn, linked by a stable turn identity that does not require an appended user message (`/continue` is one such case). This event owns the terminal `StopReason` and normalized diagnostic detail; message events remain the authority for conversation content. The host persists the outcome after settling the turn and projects it into the live turn response, Web's internal HTTP response, TUI's hub bridge, and reopened history. Neither client may infer `completed` from the presence of assistant text. A turn with no recorded outcome, including legacy history or a crash before the terminal event, has an unknown outcome unless another authoritative terminal record proves success.

`nonSuccessStop` remains a returned, structured failure outcome that callers must handle. It is not promoted to an exception or collapsed into `apiError`; ADR-0011's throw contract for `maxTurns` and its abnormal-stop closing-summary rules remain in force. A closing summary is a display artifact, not a message or a replacement outcome. The wording and placement of partial content, notices, and summaries belong to the later presentation decision.

The persisted message projection must remain replayable when an incomplete response contained `tool_use`; no tool from that response may run. The downstream specification decides the precise closeout representation in harmony with ADR-0108.

## Considered Options

Throwing a typed exception on truncation would align its control flow with ADR-0011's `maxTurns` path, but would require every streaming, HTTP, and session host to recover a partial turn from an exception. A structured failed result and a mandatory persisted terminal event preserve the current runtime boundary while making failure durable and explicit.

## Evidence pointers

- `src/harness/model-adapter/anthropic-adapter.ts` normalizes provider `max_tokens` to `truncation`.
- `src/harness/loop-engine.ts` maps non-success supplier stops only after the no-tool-call branch and returns `nonSuccessStop` without a diagnostic field.
- `src/session-api/store/checkpoint.ts` excludes `nonSuccessStop` from interruption checkpoints.
- `src/session-api/hub.ts` reconstructs historical turns with `stopReason: completed`.
