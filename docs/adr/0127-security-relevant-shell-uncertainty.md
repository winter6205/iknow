# 0127. Require review for security-relevant shell uncertainty

Date: 2026-09-27
Status: accepted

## Context

ADR-0124 sends unmodelled shell syntax to the normal permission flow. In `full_auto`, that flow can allow a command even when the parser cannot establish whether a dangerous-looking operand is inert data or code executed by another program. The Stage 2 carrier list and heredoc receiver attribution expose this gap. Existing `ask` callbacks also include non-interactive implementations that return approval without contacting a user.

## Decision

1. Keep confirmed dangerous behavior in the non-overridable deny tier. Inspect all reachable nested command and code-bearing regions before settling an uncertain region: a confirmed inner deny wins over an outer review requirement. Existing pre-parse vetoes and the `malformed`, `aborted`, and `over-cap` hard-deny outcomes remain hard denies. Keep the `parser-unavailable` legacy-scan fallback and warning.
2. Add a security-review requirement outside the deny-only hard-wall rule type. It applies only when a security-relevant pattern is present and execution, data ownership, heredoc receiver, or bounded recursive analysis cannot establish whether that pattern is inert. It is evaluated before ordinary grants and mode-based allowance. In both `default` and `full_auto`, it requires a fresh decision for that call. Interactive host entry adapters supply an explicit review capability; the permission executor checks that capability before invoking the review callback. A worker whose parent session has an interactive host, including a `wait:false` background worker, may use a parent-owned broker to present the request in the foreground UI and relay the answer to that worker call. A worker without this end-to-end route, or a bare ACI caller without an interactive host, returns a typed deny even if its ordinary `ask` callback would return approval. Unknown syntax without security-relevant evidence continues through the existing mode flow.
3. Proven inert text does not trigger a hard wall or security review. It continues through the ordinary permission flow, including `full_auto` allowance. Confirmed sensitive-path access remains subject to its separate wall; inertness for a destructive-command pattern does not imply a path operand is safe.

Every review requirement records a typed cause and the relevant source span. Invalid review input or a review-evaluator exception produces a typed deny with a non-empty reason. A user approval applies to the current call only; denial or unavailable interaction ends that call without execution. Worker broker requests are isolated by task and call id; broker disconnection, timeout, or cancellation denies that call. The caller may retry after changing the command or restoring an interactive review channel.

## Consequences

This changes ADR-0124 Decisions 1–2 only for security-relevant uncertainty in an `ok` tree or `unknown-syntax` result. A historical hard-wall deny may become a user-reviewed ask where the parser cannot prove that text is executable; it must never become an automatic allow. The user can still approve the call, so the contract guarantees a human checkpoint rather than unconditional prevention in that case. Differential review must label these transitions explicitly and reject unreviewed deny-to-allow rows.
