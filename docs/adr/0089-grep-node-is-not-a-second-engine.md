# 0089. The Node grep fallback is not a second ripgrep

Date: 2026-09-13
Status: accepted

## Context

ADR-0004 defines grep as: ripgrep subprocess first, Node fallback on ENOENT. `feat/aci-grep-surface` read "search must still work when the bundled rg won't start" as "the JS `RegExp` must reproduce rg's exact hit set", and made a gate fuzz `DIVERGE=0` (even `--engine=auto`) the acceptance criterion. Two formal languages share no common criterion; testing the wrong function cannot prove the production handler.

## Decision

**When rg is usable, matching comes only from rg, never re-filtered in JS.** Without rg (ENOENT for that binary / not executable), Node does only traversal plus whatever patterns the current `RegExp` can compile, and the call still succeeds. The two paths may return different hit sets. Node does **not** imitate rg's default-engine rejection set. The release gate is the `createGrepTool` handler, not a dialect-alignment fuzz. Flipping rg engine flags to force a shared criterion is prohibited. The landing point is not in this ADR (ADR-0088).

## Why not

**Why not full rg semantic alignment in Node:** there is no maintainable isomorphism; a green fuzz in the gate is a false pass.

**Why not refuse the call when rg is absent:** machines without a bundled or PATH rg still need to search (the operator has chosen this).

## Consequences

- (+) Acceptance returns to the production handler.
- (−) In the no-rg tier, lookarounds and the like may be broader than rg; docs and tests must treat this as a feature, not a missed failure.
