# Plan: settings 机制完善——loop 配置（maxTurns · 压缩阈值）继承通道

Issue: #353
Parent: #331 [wayfinder:map] 子代理能力 V1
Source: #335 [wayfinder:grilling] 子代理 loop 配置独立可配
ADR: 0012 (maxTurns 默认无限), 0013 (reactive compact)

---

## Architecture Change Reviewer verdict

- bounded-context-guardian: yes — 变更集中在 `src/config/`（既有 env SSOT 旁），新增 `settings.ts` 作为配置 bounded context；不引入 controllers/services 分层，不跨模块泄露实现细节。
- defensive-contract-validator: yes — 边界测试覆盖：settings 文件不存在、坏 JSON、缺字段、非法数值、project 覆盖 user、env 覆盖 settings；env 现有边界测试保持不变。
- error-handling-enforcer: yes — 文件不存在/坏 JSON/非法字段均降级（空对象/忽略），不抛错，不中断启动；阈值硬校验仍保留在 `threshold.ts`。
- complexity-anti-drift: yes — `settings.ts` 保持单一职责（加载+merge），目标 < 150 行；`env.ts` 仅增加 settings 作为可选输入与 merge 层。
- minimal-change-verifier: yes — 1 commit = 1 logical task：建立 `.iknow/settings.json` 机制并把 loop 配置（maxTurns / compress）迁移到该单一事实源。

---

## Problem statement

Current loop config lives in `env.ts` SSOT as env-only values:

- `IKNOW_LLM_MAX_TURNS` → `env.llm.maxTurns`
- `IKNOW_MODEL_CONTEXT_WINDOW` / `IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS` → `env.compress`

Because sub-agents are independent subprocesses (#331 Q2: 独立进程，重新走 `loadIknowEnv()` + `buildHarnessEngine()` 自装配), in-memory `LoopEngineDeps` values cannot be inherited across process boundaries. Issue #335 originally wanted `spawn_subagent` to carry a `compact` field, but review showed:

1. `compress` is assembled from env at `build-engine.ts:283-289`, not from user settings.
2. Reactive compact is an intrinsic loop contract (ADR-0013), not a user switch.
3. Sub-agents re-assemble via `loadIknowEnv()`; parent memory values do not cross.
4. OpenHarness uses process-level CLI flags for compact thresholds and `AgentDefinition.max_turns` only for `max_turns`; it does not forward compact thresholds via spawn params.

Therefore we need a **settings file mechanism** so that loop config becomes user-settable and inheritable by subprocesses.

---

## Tracer bullets

1. Add `src/config/settings.ts`: load and merge user-level `~/.iknow/settings.json` and project-level `<cwd>/.iknow/settings.json` (project overrides user). Return a typed `IknowSettings`.
2. Update `src/config/env.ts`: accept an optional `settings` injection and merge it into the precedence chain `process.env > .env.local > .env > settings > hardcoded defaults`. Existing callers without settings keep byte-identical behavior.
3. Move loop-config defaults (maxTurns, compress contextWindow / thresholdTokens) out of hardcoded env defaults into settings defaults, while keeping env override the highest user-facing precedence.
4. Add `tests/config/settings.test.ts` covering: missing files, malformed JSON, missing fields, invalid values, project overrides user, env overrides settings.
5. Add `tests/config/env.test.ts` cases: settings-provided maxTurns/compress values flow through `loadIknowEnv`; env still wins over settings.
6. Update `src/index.ts` if needed to export `loadIknowSettings`/`IknowSettings`.
7. Verify: `npm test` passes; `npm run typecheck` passes.

---

## Files expected to change

- `src/config/settings.ts` (new)
- `src/config/env.ts`
- `src/index.ts` (export new API)
- `tests/config/settings.test.ts` (new)
- `tests/config/env.test.ts` (add settings merge cases)

---

## Validation

- `npm run typecheck`
- `npm test -- tests/config/settings.test.ts tests/config/env.test.ts`
- Full suite: `npm test`
