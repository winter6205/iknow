---
name: error-handling-enforcer
description: Use when modifying error handling in a diff, adding try/catch blocks, returning null/-1/empty string on failure, introducing magic error codes or string codes, adding fallback branches without exit criteria, mixing error path with main logic, throwing generic Error without a typed class, or seeing empty catch swallowing failure silently in code review.
bucket: engineering
---

# Error Handling Enforcer

## Overview

Errors are typed contracts with explicit exit conditions, not log lines and fallbacks. Empty catch swallows failure; returning `null` makes failure indistinguishable from "no result"; magic strings rot. Every catch must re-throw typed, every fallback must declare when it exits, and every generic `Error` must become a typed exception class.

## When to use

- Adding or modifying any `try` / `catch` (or `try` / `except`) block
- Changing a function's failure return value (`null`, `-1`, `""`, magic code)
- Adding a fallback branch (`if cached: return cached`) anywhere
- Mixing happy-path and error-path in the same function
- Throwing a generic `Error` / `Exception` without a typed class
- Reviewing a diff that touches any of the above

## When not to use

- Pure declarative config with no error path
- Test fixtures that intentionally exercise the error path
- Pure type definitions (no runtime behavior)
- `unwrap()` / `panic` in clearly non-recoverable code paths

## Dispatch

本环节由 `arthurpower:error-handling-enforcer-agent` 承接。识别到修改错误处理、新增 try/catch、失败时返回 null/-1/"" 、出现 magic 错误码/字符串码、或无退出条件的 fallback 分支等验证时机时，用 Agent 工具以 `subagent_type: "arthurpower:error-handling-enforcer-agent"` 派发，而非在主线程自跑。派发时传：diff 范围 + 本 skill 判据 + 证据格式（file:line + PASS/FAIL）。软触发：应当派，非必须派；偶发主线程自跑属可接受降级，不视为违规。

## Procedure

1. Locate every `try/catch` in the diff. For each — confirm catch either re-throws typed error, converts to `Result<T,E>`, or documents explicit recovery.
2. Locate every function whose failure-mode return is `null` / `-1` / `""` / magic code. Replace with typed exception OR `Result` return.
3. Locate every fallback branch. Add `// EXIT:` comment that names the exit condition (e.g. `// EXIT: stale cache older than TTL`).
4. Split any function where the return value depends on the `try/catch` outcome. Error path goes to a separate handler.
5. Replace generic `throw new Error("...")` with a typed exception class in the appropriate module.
6. No `catch (e) {}` (empty catch) survives. No silent `console.log` in catch.
7. For full worked examples (Python + JS/TS, before/after pairs), see `references/error-handling-examples.md`.
8. For grep gates and CI integration, see `references/error-handling-verification.md`.

## Rationalization Table

| Excuse                                                | Reality                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| "Just `console.log` and return null, easy to debug"   | Caller cannot distinguish "no result" from "failed". Debug info dies with the log.                |
| "Generic Error is fine, type doesn't matter"          | Caller cannot `catch (NetworkError)` vs `catch (ValidationError)`. Handler collapses to one path. |
| "Fallback `if cached: return cached` is just-in-case" | Just-in-case fallback never exits. Stale data masquerades as fresh. Add `// EXIT: stale TTL`.     |
| "Empty catch to keep tests passing"                   | Tests pass while production silently fails. Add `assert.fail` or rethrow.                         |
| "Time crunch, ship the catch + log, fix later"        | Later is never. The catch becomes a load-bearing silent failure.                                  |
| "Returning -1 is idiomatic in this codebase"          | Idiomatic rot. Migrate by typing the return and stopping the -1 spread.                           |

## Red Flags — Stop and Start Over

- `catch (e) {}` / `except: pass` / `catch (_) {}` anywhere in the diff
- `return null` / `return -1` / `return ""` on failure path
- `if cached: return cached` with no `// EXIT:` comment
- `throw new Error("...")` without a typed class
- Function where happy path and error path return at different points in the same body
- Magic number like `throw "E_NETWORK"` or `return 500`

## Acceptance Criteria

- [ ] No empty catch in the diff
- [ ] No function returns `null` / `-1` / `""` / magic code on failure
- [ ] Every fallback has a `// EXIT:` comment with explicit exit condition
- [ ] Every generic `Error` is replaced with a typed exception
- [ ] Error handling is structurally separate from main logic
- [ ] All 5 boundary exception cases have explicit assertions (cross-check with `defensive-contract-validator`)

## Required Baseline

Zero tolerance: empty catch forbidden; `null` / `-1` / `""` return on failure forbidden; generic untagged throw forbidden; silent `console.log` in catch forbidden; fallback without `// EXIT:` comment forbidden. Any of these is a fail-fast violation that ships broken-by-design code.

## Verification

- Grep gates and CI workflow → `references/error-handling-verification.md`
- Worked examples (Python + JS/TS, before/after pairs) → `references/error-handling-examples.md`
- Cross-check boundary-case coverage with `defensive-contract-validator`
