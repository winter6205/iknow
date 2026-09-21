# 0012. maxTurns demoted to a user-explicit switch, default unlimited; runaway protection stripped out to a cost guardrail

Date: 2026-08-08
Status: accepted

## Context

`src/harness/build-engine.ts:172` hardcodes `maxTurns: 6` at the assembly layer with no env/config override. It serves as both a "run ceiling" and the de facto **runaway guardrail**. But a turn counter cannot distinguish "an out-of-control tool loop" from "legitimate long-horizon exploration" — when an exploration task hits the 6-turn ceiling, the in-flight exploration is cut off by `MaxTurnsExceeded` with no way to continue or degrade. Using turn count as the guardrail means a "crude round counter" indiscriminately chops every task, including legitimate long-exploration scenarios. That is the fatal flaw.

## Decision

1. **maxTurns is demoted to a "user-explicit switch", default unlimited.** Semantics aligned with `query.py:700` `while context.max_turns is None or turn_count < ...`: `None` / unset = no ceiling; exploration is never killed by mistake via turn counting; enforcement happens only when the user explicitly sets a ceiling.
2. **Configuration source = CLI flag `--max-turns` + env variable `IKNOW_LLM_MAX_TURNS`.** chat/ask set it on the command line (`parse-args.ts` following the `--max-bytes` precedent); serve takes the env default. No serve per-session ceiling (no demand, no over-design).
3. **Runaway protection is stripped from maxTurns**, recorded as a TODO in the 017 conditional remediation layer: token-cost guardrail / total-wall-time guardrail (already listed at 017:27, explicitly forbidden by the conditional layer, to be added after 018 lands real connectivity, per the 013 conditional-remediation principle). Until cost guardrails land, maxTurns defaulting to unlimited means **no runaway safety net** — a deliberate trade-off, not an oversight.
4. **Assembly**: `build-engine.ts:172` reads `LoopEngineDeps.maxTurns` from `env.llm.maxTurns` (env variable) or the CLI flag; both absent -> `undefined` (unlimited).
5. **Over-limit semantics**: once the user explicitly sets a ceiling and it is hit -> ADR-0011's `throw MaxTurnsExceeded` + model closing summary.

## Considered Options

- **A high default (200) instead of unlimited**: keeps a runaway safety net, but 200 is still a "crude counter", long-horizon exploration may still hit it, and the internal escape-default 200 (`query.py:153`) contradicts the user-facing default 8 (`query_engine.py:36`), reflecting that "turn ceiling as runaway protection" does not stand up. Rejected: every "set it a bit higher" only defers the mistaken kill, never solves it.
- **Keep hardcoded 6 / build a complex layered config (env + CLI + serve settings tri-state)**: the former is the current flaw; the latter (`react_launcher.py`'s `enforce_max_turns` tri-state) builds machinery for the rare case where a user wants a limit — over-design. Rejected.
- **Default unlimited with cost guardrails landing simultaneously**: the most correct option, but it pulls forbidden items of the 017 conditional layer into this round, expanding scope — a different hard-to-reverse decision. Not force-expanded this round; recorded as a TODO.

## Consequences

- (+) The fatal "exploration hits the guardrail" problem is solved: default unlimited, long-horizon tasks are never killed by mistake via turn counting.
- (+) Semantics aligned (default None = unlimited; set only when the user explicitly asks).
- (+) Minimal configuration: one CLI flag + one env variable, zero new mechanisms, no serve settings.
- (−) **No runaway safety net** until cost guardrails land — a deliberate default-unlimited trade-off, already recorded in the conditional-layer TODO; the backstop for runaway loops is deferred to token/wall-time guardrails.
- (−) If the user sets no `--max-turns`, one run may iterate forever (stopping only on text completion). Acceptable: text completion (no tool_use) is the natural termination; only a pure tool loop runs away, and that is what cost guardrails should manage.
- Rollback = restore the `maxTurns: 6` hardcode; but once surface consumers have adapted to CLI-flag passthrough, rollback cost rises.

## Evidence pointers

- `src/harness/build-engine.ts:172` — the current `maxTurns: 6` hardcode.
- `src/cli/parse-args.ts:120-129` — the `--max-bytes` flag precedent (new flags follow this pattern).
- `src/config/env.ts:9-36` (`LlmEnv`) + `:299-308` — env configuration precedent (`IKNOW_LLM_MAX_OUTPUT_TOKENS` / `IKNOW_LLM_TIMEOUT_MS` via `envInt`).
- `docs/archive/wayfinder/issues/017-loop-hardening-for-migration.md:27` — "time, token, or cost guardrails beyond maxTurns, where genuinely necessary" listed under the conditional layer's explicit prohibitions (translated).
- `docs/CONTEXT.md:17` — `maxTurns` is "the runtime ceiling checked before each model call".
- Baselines: `query.py:700,882-883` (None = unlimited) · `query_engine.py:36` (default 8) · `query.py:153` (escape default 200) · `react_launcher.py:85-100` (`--max-turns` flag).
- `docs/adr/0011-loop-stop-summary-and-max-turns-exceeded.md` — over-limit semantics (throw + closing summary); this ADR's over-limit behavior depends on it.
