# Plan: #119 上下文压缩 — 滑动窗口 + 阈值 + 估算

> **Spec**: `specs/119-compression-landing.md` (PASS · 5/5 ACR verdict)
> **ADR context**: ADR-0004 / ADR-0006 / ADR-0008 / ADR-0009 / ADR-0010
> **Implementation branch**: `worktree-compression-119-landing` (worktree 已就绪)
> **Implementation base**: master HEAD `b902a8a`
> **Tracker**: GitHub Issues(gh CLI available;主路径非 local markdown fallback)

## 依赖顺序与并行性

文件依赖图:

- T1(env.ts)独立 → 必须先做(配置 shape 定)
- T2-T5(compress/ 子模块)互不依赖,可并行;为安全 sequence
- T6(index.ts)依赖 T2-T5(re-export estimate / threshold / window)
- T7(loop-engine + build-engine + tests + eval)依赖 T1 + T6

并行标记:`[blocks: T2-T5]` T1 完成是 T2-T5 前置;`[blocks: T6]` T2-T5 完成是 T6 前置;`[blocks: T7]` T1+T6 完成是 T7 前置。

---

## Tracer Bullets

### T1. `[implementation]` config layer — `IknowEnv.compress.*` 接入

- **Affects**: `src/config/env.ts`(IknowEnv 形态 + loadIknowEnv 接入)
- **Acceptance**:
  - `npx tsc --noEmit` exit 0
  - `grep -n "compress: IknowCompress" src/config/env.ts | wc -l` ≥ 1
  - `grep -n "IKNOW_MODEL_CONTEXT_WINDOW\|IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS" src/config/env.ts | wc -l` ≥ 2
  - `grep -n "compress\\.contextWindow\|compress\\.thresholdTokens" src/config/env.ts | wc -l` ≥ 2
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T2. `[implementation]` constant layer — `src/harness/compress/constant.ts`

- **Affects**: `src/harness/compress/constant.ts` (new)
- **Acceptance**:
  - `npx tsc --noEmit` exit 0
  - `grep -n "AUTOCOMPACT_BUFFER_TOKENS\|TOKEN_ESTIMATION_PADDING\|DEFAULT_KEEP_RECENT\|COMPACTION_BOUNDARY_PLACEHOLDER" src/harness/compress/constant.ts | wc -l` ≥ 4
  - `grep -n "MAX_OUTPUT_TOKENS_FOR_SUMMARY\|MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES\|_DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE\|COMPACT_TIMEOUT_SECONDS\|MAX_COMPACT_STREAMING_RETRIES" src/harness/compress/constant.ts | wc -l` ≥ 5(留 L3b 门后常量)
  - `npm test tests/harness/compress/constant.test.ts` 1/1 pass
- **Tests**: `tests/harness/compress/constant.test.ts`(摘出常量值断言;不在本 bullet 覆盖业务)
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T3. `[implementation]` estimate layer — `src/harness/compress/estimate.ts`

- **Affects**: `src/harness/compress/estimate.ts` (new)
- **Acceptance**:
  - `npx tsc --noEmit` exit 0
  - `grep -n "estimateTokens\|estimateMessagesTokens" src/harness/compress/estimate.ts | wc -l` ≥ 2
  - `grep -n "TOKEN_ESTIMATION_PADDING" src/harness/compress/estimate.ts | wc -l` ≥ 1
  - `npm test tests/harness/compress/estimate.test.ts` 1/1 pass(覆盖 5 boundary: 空/单字符/纯 emoji/超大文本/混合 block 类型)
- **Tests**: `tests/harness/compress/estimate.test.ts`(纯函数单测,真 FS 不需要)
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T4. `[implementation]` threshold layer — `src/harness/compress/threshold.ts`

- **Affects**: `src/harness/compress/threshold.ts` (new)
- **Acceptance**:
  - `npx tsc --noEmit` exit 0
  - `grep -n "getAutoCompactThreshold\|validateThreshold" src/harness/compress/threshold.ts | wc -l` ≥ 2
  - `npm test tests/harness/compress/threshold.test.ts` 1/1 pass(覆盖 5 boundary: 显式 0 reject / 显式 ≥ window throw / 显式负数 reject / 缺省推导 / 显式优先)
- **Tests**: `tests/harness/compress/threshold.test.ts`
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T5. `[implementation]` window layer — `src/harness/compress/window.ts`

- **Affects**: `src/harness/compress/window.ts` (new;含 `preserveToolPairs` 内部 helper)
- **Acceptance**:
  - `npx tsc --noEmit` exit 0
  - `npm test tests/harness/compress/window.test.ts` 1/1 pass(覆盖 5 boundary: 0 条 / 1 条 / N < keepRecent 不动 / tool_use 配对不切 / 不变式破坏 throw / 边界占位符文本字节级)
  - `grep -n "preserveToolPairs" src/harness/compress/window.ts | wc -l` ≥ 1
  - `grep -n "COMPACTION_BOUNDARY_PLACEHOLDER" src/harness/compress/window.ts | wc -l` ≥ 1
- **Tests**: `tests/harness/compress/window.test.ts`
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T6. `[implementation]` compress api — `src/harness/compress/index.ts`

- **Affects**: `src/harness/compress/index.ts` (new)
- **Acceptance**:
  - `npx tsc --noEmit` exit 0
  - `grep -n "shouldAutoCompact" src/harness/compress/index.ts | wc -l` ≥ 1
  - `npm test tests/harness/compress/index.test.ts` 1/1 pass(estimate < threshold false / estimate >= threshold true)
- **Tests**: `tests/harness/compress/index.test.ts`
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T7. `[implementation]` integration layer — loop-engine 接线 + build-engine 透传 + integration test + eval 017

- **Affects**:
  - `src/harness/loop-engine.ts`(LoopEngineDeps.compress 字段 + run() 主循环 proactive check)
  - `src/harness/build-engine.ts`(构造 LoopEngineDeps 时透传 env.compress → deps.compress)
  - `tests/harness/compress/integration.test.ts`(new;覆盖 100 回合长对话 + prefix 字节级 + turnCount 锚点)
  - `.evals/tasks/017-compression.yaml`(new;`npx vitest run tests/harness/compress/`)
- **Acceptance**:
  - `npx tsc --noEmit` exit 0
  - `npm test` all green
  - `npm test tests/harness/compress/integration.test.ts` 1/1 pass
  - `bash .evals/run.sh --task 017` 1/1 passed
  - `grep -n "lastCompactTurn" src/harness/loop-engine.ts | wc -l` ≥ 1
  - `grep -n "shouldAutoCompact" src/harness/loop-engine.ts | wc -l` ≥ 1
  - `grep -n "deps.compress" src/harness/loop-engine.ts src/harness/build-engine.ts | wc -l` ≥ 2
  - `grep -n "deps.compress" src/harness/build-engine.ts` 命中 ≥ 1(env.compress 透传)
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## Per-ticket loop (verbatim from ADR-0012)

Each implementation ticket above embeds:

1. `arthurpower:test-driven-development` — failing test first
2. `typecheck + tests` — green
3. `arthurpower:code-review` — conditional on code diff;severity-gated
4. `arthurpower:verification-before-completion` — evidence captured
5. `commit on ticket branch` — 1 commit per bullet

---

## Tracker 落地

每个 tracer bullet 立为 GitHub issue,label `ready-for-agent`,挂父 issue #119(closed)append-only reference。新 PR 用 `gh pr create --base master --draft` 在 T7 完成后 open。

```bash
gh issue create --label "ready-for-agent" \
  --title "[T1] config layer — IknowEnv.compress.* 接入" \
  --body "per plans/119-compression-landing.md#t1"
```

每个实施 agent claim 1 issue,跑 per-ticket loop,commit 后 close issue。

---

## 验证

按 writing-plans 4 步:

1. `grep -E "^\s*### T[0-9]+" plans/119-compression-landing.md | wc -l` → 7(tracer bullets)
2. PR merge 后 `git log master --oneline | head -7` → 7 commits(T1-T7)
3. `git diff b902a8a..master --stat` → scope 闭合:7 个新增 src/harness/compress/* + 2 个改动 (loop-engine / build-engine) + 1 个改动 (env.ts) + 6 个新增 tests + 1 个新增 eval
4. `npm test` + `bash .evals/run.sh --task 017` all green

完成 = plan has 7 tracer bullets, each with binary acceptance + one `[implementation]` tag, dependency-ordered.
