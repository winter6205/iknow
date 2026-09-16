# Plan: post-merge debt #1029–#1032

**Goal:** After #1025–#1028 landed, close the four leftover issues without mixing a new product model default or a subagent provider registry into the hotfix round.
**Approach:** One recorded scope cut, then four independent landings (iknow fixture / enter tier / worktree copy; arthurpower S5 checker). Same `llm.providers` table stays the only registry; subagent does not get its own providers this round.
**Spec link:** GitHub #1029 #1030 #1031 #1032; `specs/subagent-layers-worktree-deps.md` (Known risk for enter timeout); ADR-0015 / ADR-0093 (model routing, no hardcoded model id); `docs/guides/prompt-development.md` (STATIC for tool description)
**ACR:** all-yes — see block below (round is four sequenced tasks, not one mixed PR)
**待写入:** (empty — no new glossary term; `settings.subagent.model` is explicitly out of this round)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## ACR

bounded-context-guardian: yes — each landing stays in its context (CLI test fixture / worktree ACI / plugin S5 script); no new bounded context; arthurpower checker is not vendored into iknow.
input-contract-tests: yes — no new public CLI/API this round; #1029 only aligns an existing CLI spawn fixture with the already-shipped `provider_model_not_registered` contract; #1030 STATIC-locks description; #1031 is timeout-tier alignment with an existing numeric invariant; #1032 is checker identity pairing, not a public entry.
error-handling-enforcer: yes — product fail-fast for unregistered models stays; #1031 keeps typed timeout/receipt on the existing ensure path (does not swallow timeout into empty catch).
complexity-anti-drift: yes — no new god-component intent; S5 false-positive is fixed by deduping span inputs, not by relaxing uniqueness.
minimal-change-verifier: yes — four GitHub issues, four landings; T1 forbids shipping a default model or `subagent.providers` in these diffs.

## Non-goals (this round)

- Product built-in / seeded default `llm.model` or in-repo default provider.
- Restoring `IKNOW_LLM_BASE_URL` fallback when `providers` is missing.
- `settings.subagent.model` or a second `subagent.providers` table (follow-up: same shape as `verify.classifierModel` if wanted later).
- Rewriting worktree leaf back to `<label>--<conversationId>`.
- Vendoring `s5-complexity/check.mjs` into iknow.

## Tasks (ordered by dependency)

1. **Record the #1029 scope cut: fixture, not a product model** — tag: `[decision]`
   - **Inherits:** ADR-0015 — `settings.llm.model` is the literal unique source; code does not hardcode a model id. ADR-0093 — route is `provider/model` against user-layer `llm.providers`; miss is typed `provider_model_not_registered`. Operator call (this thread): #1029 is not 「自带模型」; a later subagent default would reuse `llm.providers`, not a new registry.
   - **Surface:** this plan (no new ADR unless a later ticket reopens a default-model product question)
   - **Acceptance:** T2–T5 diffs do not add a shipped default model, do not restore env transport fallback, and do not add `settings.subagent` model/provider fields
   - Status: [x] done (this file)

2. **#1029: CLI chat-subagent-trace fixture registers a test provider** — tag: `[implementation]`
   - **Inherits:** T1; existing helper contract `withTestLlmProvider` / `llmSettingsJson` (route `test/<id>`, stub `baseUrl` + `apiKeyEnv`); `7ecdf9bd` retired env transport fallback
   - **Surface:** tests/cli (chat-subagent-trace spawn HOME settings + child env)
   - **Acceptance:** `npx vitest run tests/cli/chat-subagent-trace.test.ts` exits 0 on a HOME that has no real user settings; stub listen port is the provider `baseUrl`; product `resolveLlmTransport` unchanged
   - Status: [x] done (commit 5bc7029c, PR #1033)

3. **[parallel] #1032: S5 scopePairs gets one span list per file** — tag: `[implementation]`
   - **Inherits:** T1 (iknow does not vendor the checker). Issue #1032: `hunks.flatMap(analyze spans)` duplicates full-file spans per hunk; `uniqueNameMatch` requires exactly one name hit.
   - **Surface:** arthurpower marketplace `scripts/s5-complexity` (repo `arthurpower-mirror` / local marketplace — **not this iknow worktree**)
   - **Acceptance:** a same-file ≥2-hunk formatting-only change no longer reports an unchanged exported function as a complexity regression; `uniqueNameMatch` semantics (exactly one name) stay; iknow `lint:s5` still invokes the plugin script, no in-repo copy
   - Status: [x] done (arthurpower plugin repo: assembleSpanLists helper + 2 regression tests, node --test 37/37; A/B verified on real app.tsx 2-hunk scenario — fixed exits 0, buggy reproduces the false positive)
   - [parallel] [blocks: T1]

4. **[parallel] #1031: enter-worktree timeout tier matches create-worktree** — tag: `[implementation]`
   - **Inherits:** `specs/subagent-layers-worktree-deps.md` Known risk: enter can run the same ensure/install as create; create already uses timeout tier `build`; install bound is `PACKAGE_MANAGER_INSTALL_TIMEOUT_MS`. ACI `timeoutTier` is not model-visible.
   - **Surface:** harness ACI worktree tools + existing worktree-deps tests
   - **Acceptance:** enter-worktree timeout tier is `build`; a test asserts that tier duration exceeds the install bound (same relation already pinned for create); spec Known risk for enter timeout is removed or marked resolved; list/exit/remove tiers unchanged
   - Status: [x] done (commit 5bc7029c, PR #1033)
   - [parallel] [blocks: T1]

5. **#1030: create-worktree description matches name-only leaf** — tag: `[implementation]`
   - **Inherits:** `taskWorktreePath` SSOT — labeled leaf is the label, unlabeled leaf is conversationId; no `--` join on create. Operator preference: change copy to match impl, do not change naming. `docs/guides/prompt-development.md` STATIC + register-no-trace-set for tool description.
   - **Surface:** harness ACI create-worktree description (JSDoc/comments optional if they still show the old `--` template)
   - **Acceptance:** model-visible description no longer promises `<label>--<conversationId>`; STATIC assertion covers that; `taskWorktreePath` behaviour and existing naming tests unchanged
   - Status: [x] done (commit 5bc7029c, PR #1033)
   - [blocks: T1]

## Suggested landing order

T2 first (master red test). T3 as soon as someone can land in arthurpower (unblocks later `app.tsx` multi-hunk edits). T4 and T5 independent of T2/T3; T4 before T5 only by risk, not by code dependency.

## Follow-up (not in this plan)

If operator wants a persistent subagent default distinct from the parent: optional `settings.subagent.model` as a `provider/model` route that must already exist in `llm.providers`, default inherit `settings.llm.model` — same pattern as `settings.verify.classifierModel`. New spec + ACR; do not attach to T2–T5.

## Code review phase

End of each landing (not one review for all four): `code-review` → if `GATE: BLOCKED` then `review-report-repair` → `verification-before-completion`.
