# Plan: search-engine lifecycle

**Goal:** the search engine is provisioned by the lockfile instead of a manual download step, its absence is disclosed to the model instead of being silent, and the cloud CI gate runs again.

**Approach:** three independent units from `docs/handoff/2026-10-04-search-engine-decisions.md`, ordered so each unblocks the next. T1 restores the CI gate the later PRs depend on. T2 moves provisioning into the lockfile, which retires T1's reason for excluding `grep.test.ts` and shrinks T3's test surface. T3 discloses the Node fallback in-band, last because its test churn lands on the same file T2 already touches. Out of scope: remote access to `serve` (operator ruled it out of scope, handoff §1.4), and a `postinstall` provisioning hook (rejected, handoff §3.2 — `@vscode/ripgrep` abandoned it after four upstream incidents).

**Spec link:** none — no `specs/` file governs this. Source of record is the handoff plus the three wayfinder tickets it names.

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## ACR

First pass returned **BLOCKED** on 3 axes. All three were planning-completeness gaps, closed below with facts rather than operator decisions.

```
bounded-context-guardian:  yes — engineBinaryPath keeps its name and its module (search/engine-manifest); grep.ts / glob.ts call sites keep the same shape; only the parameter list shrinks. No new top-level directory, no cross-boundary import.
input-contract-tests:      yes — the "engine absent" contract is unchanged (resolver returns undefined → {kind:"unavailable"} → Node fallback, rg-engine.ts:66) because the package's throwing import is caught inside the resolver, never at module scope. Pinned by a new test + the existing degrade-arm injections (grep.test.ts:141-158, :155, :1428, :1444, :1831).
error-handling-enforcer:  yes — T1 is data-only; T2 deletes install-search-engine.ts:141-143 (non-atomic write) and :162 (unhandled `void main()`); T3 adds no throw and leaves pipeline.ts:56 / dropUnrepresentable:105 intact.
complexity-anti-drift:    yes — net -222 lines, no new branch depth; type-table.ts is regenerated from `--type-list`, not hand-extended. S5 gates owned by the complexity-anti-drift skill, not restated here.
minimal-change-verifier:  yes — T2's file list below is the full enumeration including call sites, tests, README, package.json and the lockfile; no second feature, one new dependency with a stated justification.
```

**Blocker 1 — who owns `engineBinaryPath` after T2?** `src/harness/aci/search/engine-manifest.ts` keeps the symbol as a thin adapter over the package. The `installRoot` / `platform` / `arch` parameters are **removed**, not retained-and-ignored: once the path comes from the package they are dead, and carrying them would be a false implementation. `glob.ts:177-182` and `grep.ts:371-376` keep their `?? ` seam and their shape; the test call sites that pass the removed arguments are updated.

**Blocker 2 — what is the new "engine absent" contract?** Unchanged. `@vscode/ripgrep`'s entry rethrows a plain `Error` when the per-platform `optionalDependencies` package is absent, so a module-scope import would be a **new** failure class that crashes instead of degrading. The adapter therefore resolves lazily inside a `try`/`catch` and returns `undefined` on any resolution failure, preserving today's typed absence. ADR-0089 stays intact: cannot-start never fails the call.

**Blocker 3 — T2's scope was under-enumerated.** Corrected below.

## Tasks (ordered by dependency)

1. **Register the 12 unregistered bwrap-dependent test files** — tag: `[implementation]`
   - **Inherits:** the guard's own remediation line, verbatim: "修法：加进 vitest.ci-excludes.ts 的 CI_EXCLUDES（整目录慢路径才用 CI_FAST_EXCLUDES）。原因：runner 无 user-namespace ⇒ requireBwrap() 在装配期 throw，test-fast（不装 bwrap）会红。" And the module's entry rule at `vitest.ci-excludes.ts:34-51` — every entry carries a note giving its class and why. The guard enforces only that the entry matches a file on disk; **the reason is a human rule and no script checks it** (`.iknow/rules/ci.md:31-32`).
   - **Surface:** the CI test-exclude SSOT (`vitest.ci-excludes.ts`), consumed by both `vitest.ci-fast.config.ts:21` and `vitest.ci.config.ts:27`.
   - **Acceptance:** `npx tsx scripts/ci-check-test-excludes.ts` exits 0. In this sandbox the `npx tsx` route fails on an IPC pipe (`listen EINVAL` on the fence tmp path) and `bun run scripts/ci-check-test-excludes.ts` is the working equivalent — the implementer must report the exit code of the run it actually used, not the pipe's. The reverse check (no dead entries) and the `tests/tui` ban must also pass, since they run in the same process. Each of the 12 entries carries a class + reason comment; `grep.test.ts:74` — which today has **no reason of its own**, the ADR-0117 comment above it belongs to the entry above — is not in scope for this bullet, it is handled by T2.
   - The 12 files, as the guard actually reports them:
     `tests/harness/aci/bash-background-deadline.test.ts`, `bash-cleanup-roots.test.ts`, `bash-foreground-deadline.test.ts`, `bash-protected-erofs-feedback.test.ts`, `bash-protected-targets-wiring.test.ts`, `tests/harness/aci/tools/bash-substitution-description.test.ts`, `tests/harness/cleanup-roots-production-wiring.test.ts`, `tests/harness/permission/root-find-readonly-allowance.test.ts`, `tests/harness/permission/sensitive-path-evidence.test.ts`, `tests/harness/route-budget-wire.test.ts`, `tests/harness/sandbox/cleanup-evidence.test.ts`, `tests/harness/subagent-thinking-propagation.test.ts`.
   - Status: [ ] pending

2. **Provision the search engine from the lockfile** — tag: `[implementation]`
   - **Inherits:** the operator's decision #1, "Take ripgrep from npm, not from a GitHub download — adopt `@vscode/ripgrep`" (sel-2), and its rejected alternative: **no `postinstall` hook** (sel-2 — the package abandoned it after GitHub rate-limit, 403, proxy and yarn incidents; npm RFC-0054 is moving install scripts to opt-in).
   - **Surface:** the ACI search engine layer (`src/harness/aci/search/`) and the two tool consumers (`grep`, `glob`).
   - **Acceptance:** all four observable properties hold —
     1. `rgPath` comes from the dependency; no code composes a `vendor/ripgrep/<ver>/<plat>-<arch>/` path, and `scripts/install-search-engine.ts` and the `install:search-engine` npm script are gone.
     2. The engine-absent contract is unchanged and pinned by a test: resolver returns `undefined` → `{kind:"unavailable"}` → the Node fallback answers the call. A new test covers the package's throwing import specifically, because that is the new way to be absent.
     3. The in-repo type table matches the engine that actually runs — `type-table.ts:1-14` states the table mirrors the pinned engine's `--type-list` so the Node fallback stays a fallback and not a second engine.
     4. The `grep.test.ts` entry leaves the CI exclude set, because `npm ci` now provisions the engine. Cited check: the full grep and glob suites pass locally with no manual provisioning step.
   - **Measured engine delta — the handoff's premise was wrong, corrected here.** The handoff inferred "the package ships rg labelled 15.0.1, most likely the same code, so 0 of 96 test cases should change." Installed and measured: `@vscode/ripgrep@1.18.0` (latest) ships **ripgrep 15.0.0** (rev 3a612f88b8); the repo pins **15.1.0** (rev af60c2de9d). This is a **downgrade**, not a relabel. Measured delta between the two binaries:
     - `rg --help` differs only in the version string and the `cursor` hyperlink alias.
     - `--type-list` differs by exactly one entry: 15.1.0 has `ssa: *.ssa`, 15.0.0 does not (218 vs 217 types).
     - Every flag `argv.ts` emits exists in both. `--line-buffered` — the other 15.1.0 change, a regression fix — is never used.
     - **Consequence:** the pinned version constant and the model-visible `GREP_DESCRIPTION` become 15.0.0, and the type table loses `ssa`. That is the table catching up to the engine, which is what its own header requires.
   - Full file list (blocker 3 correction): `package.json` + lockfile, `src/harness/aci/search/engine-manifest.ts`, `src/harness/aci/search/type-table.ts`, `src/harness/aci/tools/grep.ts` (call site + version in `GREP_DESCRIPTION`), `src/harness/aci/tools/glob.ts` (call site), `scripts/install-search-engine.ts` (deleted), `vitest.ci-excludes.ts`, `README.md:53-61`, and the test call sites in `tests/harness/aci/tools/grep.test.ts`, `glob.test.ts`, `glob-engine-binding.test.ts`, `host-read-policy.test.ts`.
   - **Dependency justification (minimal-change gate):** adds one runtime dependency; deletes 162 lines of installer plus ~60 of manifest; retires a manual provisioning step that nothing in CI or `npm ci` performs.
   - [blocks: T3]

3. **Disclose the Node fallback in the grep output** — tag: `[implementation]`
   - **Inherits:** the operator's decision #3, "One English notice when grep degrades; silence otherwise" (sel-4). ADR-0005's notice-over-failure shape. **Not** ADR-0089, which forbids *refusing* the call, not disclosing the fallback — the call still succeeds either way.
   - **Surface:** the grep tool and the search pipeline.
   - **Acceptance:** when the handler takes the Node fallback, the returned `output` ends with one English line naming the fallback; when the engine is present, `output` is byte-identical to today. The `{kind:"unavailable"}` tag is **recorded and carried to the render step, not passed into the pipeline** — `pipeline.ts:56` throws on it by design and `dropUnrepresentable:105` handles it; neither may be weakened. The three output modes stay exact-matchable after the notice is accounted for; the mode contract is not weakened to accommodate it. The in-tree precedent for a bare in-band string is `EMPTY_RESULT` (`glob.ts:49`) and `NO_ENTRIES_AT_OFFSET` (`paginate.ts:18`).
   - **Model-visible change:** this appends to what the model reads, so the golden-set rule in `docs/guides/prompt-development.md` applies. State in the commit which registry the change was checked against, or that no registry entry covers it.
   - [blocks: —]

## 待写入 (persist)

- **Engine provisioning model changed** — the search engine arrives with the lockfile, and there is no longer a download-then-unpack step or a `vendor/ripgrep/` tree. `docs/CONTEXT.md` has no search-engine entry today (grep for `ripgrep|search engine` returns zero), so this is a new term, not a revision. Route through `domain-modeling`; a short ADR is the better home than CONTEXT.md because the pin and its refresh procedure are a decision with a rationale.
- **Engine pin is now 15.0.0, downgraded from 15.1.0** — record the measured delta (one lost type, `ssa`) and the reason, so a future session that reads the handoff's "15.0.1 is really 15.1.0" inference does not re-litigate it. Folds into the same ADR.

## End-of-round

Code review phase closes the round after T1–T3 land: `code-review`, and `GATE: BLOCKED` hands to `review-report-repair` in the next slot. `verification-before-completion` runs per bullet during implementation and once more at the end.
