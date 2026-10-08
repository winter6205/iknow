# Plan: Issue #1228 — LSP Symbol Resolution

**Issue:** [#1228](https://github.com/winner6205build/iknow/issues/1228)
**Status:** Architecture review passed; all implementation tickets pending.
**Goal:** Make symbol-identity queries resolve top-level and nested declarations at positions language servers can answer, while keeping ambiguous resolutions safe for read and mutation tools.
**Approach:** First settle how the resolver treats flat symbol responses and distinguishes resolution failures from a legitimate empty hover. Then advertise hierarchical document-symbol support and resolve positions from symbol identity using the server's precise selection range. Finally, exercise the production query and mutation paths against real TypeScript and Python servers and make the existing symbol trajectory checks fail on missing or invalid results.
**Spec/context links:** Historical [ADR-0038](https://github.com/winner6205build/iknow/blob/5cddedd7cf33ef118a3886e5c30c5b88147c52b6/docs/adr/0038-symbol-primary-path.md) and [symbol-primary-aci spec](https://github.com/winner6205build/iknow/blob/5cddedd7cf33ef118a3886e5c30c5b88147c52b6/specs/symbol-primary-aci.md#L55), [specs/251-lsp-tool.md](../specs/251-lsp-tool.md), [specs/host-read-policy.md](../specs/host-read-policy.md), [docs/CONTEXT.md](../docs/CONTEXT.md), [docs/guides/lsp-client-analysis.md](../docs/guides/lsp-client-analysis.md), [docs/guides/prompt-development.md](../docs/guides/prompt-development.md). The historical ADR/spec were deleted from the current worktree; use the pinned sources, not missing local paths.
**ACR:** All five verdicts are yes; reviewed for the planned implementation scope. This is not a claim that the repair has been implemented.

```text
bounded-context-guardian: yes — T1–T3 use the existing LSP client and ACI resolver/tool boundary, including mutations.
input-contract-tests: yes — empty identity, invalid/out-of-range server positions, concurrency, and exception/cancellation paths are covered.
error-handling-enforcer: yes — explicit failures and legitimate null hover remain distinct, with EXIT conditions for new fallback branches.
complexity-anti-drift: yes — policy, resolution, and end-to-end acceptance are separate tasks without prescribing a god-function or god-module.
minimal-change-verifier: yes — query, mutation, call-hierarchy, and trajectory checks stay within #1228 symbol resolution.
```

**Implementation loop:** TDD (RED first) → focused tests + `npm run typecheck` → after all bullets, `code-review` → if `GATE: BLOCKED`, `review-report-repair` → `verification-before-completion` → commit. No push.
**Persist:** none — this incident fix adds no domain term or ADR decision.

## Incident evidence and scope

- In the current production path, `src/harness/lsp/client.ts:807` does not advertise `textDocument.documentSymbol.hierarchicalDocumentSymbolSupport`.
- Measured TypeScript Language Server and Pyright responses to that client are flat `SymbolInformation` entries without `selectionRange` or `children`. The resolver's `positionOf` (`src/harness/aci/tools/symbol-resolver.ts:295`) therefore falls back to `location.range.start`; for a top-level TypeScript export or Python `def`, hover lands on `export` / `def` and returns `null`, while a probe at the identifier returns hover content. Nested `Class/method` lookup also fails because path matching follows `children`.
- Separate protocol probes that advertised hierarchical support received nested symbols with `selectionRange` from both servers, and top-level hover worked. Those probes did not exercise the modified production client or production symbol tools; implementation acceptance must do so.
- This is a defect in the symbol-identity implementation that superseded #850 in merged PR [#854](https://github.com/winner6205build/iknow/pull/854) (merge commit `5cddedd7`), not a request to restore the coordinate API. Keep `{ file, symbol_path }` as the model-facing identity and keep line/character resolution internal, as decided by the historical ADR/spec linked above. Neither document freezes the flat-response fallback implementation.
- The shared resolver also supplies symbol mutation tools. A position that is merely plausible for hover is not sufficient: an unsafe or ambiguous resolution must never direct a rename or other edit to a different token.

## Tasks (ordered by dependency)

1. **Set the flat-response and resolution-failure contract** — `[decision]`
   - **Inherits:** “The model-facing surface is symbol identity, not coordinates.” The model supplies `{ file, symbol_path }`; line/character resolution stays internal. (ADR-0038 and the symbol tool surface in `docs/CONTEXT.md`.)
   - **Surface:** Existing symbol resolver and query/mutation result contracts.
   - **Acceptance:** Record a deterministic policy that prefers hierarchical `DocumentSymbol` data and `selectionRange`. If flat `SymbolInformation` remains supported, any position fallback is limited to a unique, token-safe occurrence of the exact symbol name inside that symbol's reported range; a parent path may be followed only when its container identity is unique. Ambiguous, absent, or out-of-range locations return the existing explicit resolution-failure form. A raw `indexOf` guess is not accepted. A legitimate LSP hover result of `null` remains distinguishable from failure to resolve a symbol.
   - **Status:** [ ] pending
   - **Depends on:** none.
   - **Completion/headroom:** The decision fixes the safety and result semantics while leaving helper structure and test layout to implementation.

2. **Resolve symbol identities through the advertised hierarchy and precise name ranges** — `[implementation]`
   - **Inherits:** The T1 policy and the existing `{ file, symbol_path }` API. Preserve the document-open/read-policy flow and the existing distinction among `not_found`, `ambiguous`, `no_position`, and server capability failure.
   - **Surface:** Existing LSP client initialization, ACI symbol resolver/query tools, and their unit tests.
   - **Acceptance:** A client-initialization contract test verifies hierarchical document-symbol support is advertised. With the production client, TSLS and Pyright return usable hierarchy and name ranges; top-level symbols resolve to the identifier rather than a declaration keyword, and `Class/method` resolves by its parent-child identity. Flat-response handling follows T1. Tests cover nested and top-level symbols, overloads or repeated names, names repeated in comments/strings, and multiline declarations; ambiguous cases fail without choosing a candidate. Malformed server ranges with negative/non-integer line or character, reversed bounds, positions beyond the actual document, or excessive values must not dispatch a query/edit to an invalid coordinate or cause an unbounded scan; lock the explicit failure result in boundary tests. Keep public inputs as symbol identity, without adding coordinate parameters. Known top-level TypeScript function/interface and Python function/class/method hover requests return symbol-specific content, while an actual server `null` hover remains a valid hover response rather than a resolver failure.
   - **Verification:** `npx vitest run tests/harness/lsp/client.test.ts tests/harness/aci/lsp.test.ts tests/harness/aci/symbol-mutate.test.ts tests/harness/aci/symbol-mutate-preimage.test.ts`; `npm run probe:lsp -- --lang typescript`; `npm run probe:lsp -- --lang python`. The probes establish real server availability; acceptance also requires a production symbol-tool test path, since the existing `probe:lsp` operation surface alone does not cover the live symbol resolver.
   - **Status:** [ ] pending
   - **Depends on:** T1.
   - **Completion/headroom:** Different resolver helpers or fixture layouts are acceptable if symbol identity, exact query position, and the stated failure distinctions are observable through the production tool path.

3. **Prove safe query, mutation, and interactive trajectories** — `[implementation]`
   - **Inherits:** T1's accepted ambiguity/refusal policy and the existing resolver's ambiguity protection. Preserve the read and write boundaries in [specs/host-read-policy.md](../specs/host-read-policy.md). For model-visible trajectory coverage, follow [docs/guides/prompt-development.md](../docs/guides/prompt-development.md): extend the golden set beside the behavior and keep offline and real-model halves distinct.
   - **Surface:** Existing ACI symbol query/mutation tests, LSP integration tests, the tracked `worktree-trajectory` golden set, and the TUI/REPL PTY path.
   - **Acceptance:** Against isolated temporary projects and real servers, querying a known top-level symbol and a nested `Class/method` returns the intended hover/declaration; a call-hierarchy fixture with known call edges returns those edges where the server supports that operation. A production `rename_symbol` test changes the intended declaration and its real references, leaving unrelated declarations and incidental comment/string text untouched; ambiguous resolution fails before any file bytes change. Retain the existing single-segment method golden case and add explicit top-level and nested-path cases; the existing case is not nested-path coverage. Replace the current relevant `RESIDUAL` pass-throughs with hard failures for missing required tool dispatch, `null`/empty/sentinel output where symbol content is required, invalid call-hierarchy output, or a result naming the wrong symbol. Capture a real PTY interaction through the configured terminal tool showing a user-requested top-level hover result; stop the TUI and language-server processes and remove temporary files in cleanup paths.
   - **Verification:** `npx vitest run tests/harness/lsp/worktree-trajectory.test.ts tests/harness/aci/lsp.test.ts tests/harness/aci/symbol-mutate.test.ts tests/harness/aci/symbol-mutate-preimage.test.ts`; `npm run test:real-llm` (a missing key is reported as **Not run**, never a pass); `npm run typecheck`; `npm test`. Run the real TSLS and Pyright probes from T2. Capture the PTY start/input/output/stop sequence and its observable hover result.
   - **Status:** [ ] pending
   - **Depends on:** T2.
   - **Completion/headroom:** The real-server fixture and interactive route may use different harness seams if production symbol handlers, exact changed file bytes, required golden trajectories, and the user-visible PTY result are all exercised end to end.

## Implementation handoff and verification boundary

Start a fresh implementation session with this plan, issue #1228, AGENTS.md, the pinned historical decision, and the current LSP source through LSP. Reproduce the production failures before fixing them. Keep #1227 independent: this incident reproduces without a live-root cell. T1 must record the flat-response policy before code; no new protocol fallback is already approved by the historical ADR.

Measure and record TSLS and Pyright response shape, top-level hover, and nested-path behavior before and after the capability change through the production client/tool path. A direct protocol experiment or a green coordinate-based probe alone does not satisfy that acceptance. Cover empty/invalid symbol identity, overload or ambiguous matches, malformed server data, exceptions/cancellation and concurrent requests where affected, preserving existing failure carriers and lifecycle behavior. Do not turn resolution failure into successful `null` or `[]`; add `// EXIT:` conditions for new fallback branches.

All implementation checks above are future acceptance. Plan authoring did not run a repaired production client, regression suite, real-model set, or PTY. The earlier investigation's existing tests were green despite the defect. Use fresh temporary projects/files and synthetic content; remove `.iknow/probe-lsp` artifacts after the probes and stop every started process. Do not change settings, lockfiles, permission policy, or the public coordinate API. Finish the single end-of-round code-review/repair/verification sequence before committing; do not push without explicit authorization.
