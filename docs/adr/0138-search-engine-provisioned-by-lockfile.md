# ADR-0138: the search engine is provisioned by the lockfile

- Status: accepted
- Date: 2026-10-04
- Supersedes: nothing. Extends ADR-0089 (the Node fallback is not a second engine) and ADR-0005 (notice over failure).
- Decided by: operator decision #1 in `docs/handoff/2026-10-04-search-engine-decisions.md`

## Context

The grep and glob tools run on a pinned ripgrep binary. That binary was not in the
repo and not in the lockfile: `scripts/install-search-engine.ts` downloaded a
GitHub release asset, verified a SHA-256, and unpacked it into a gitignored
`vendor/ripgrep/<version>/<platform>-<arch>/` tree at the install root. Nothing in
`npm ci` ran it, so the engine was absent on every fresh clone and in CI — which is
why `grep.test.ts` carried a CI exclude entry.

The downloader was also where two defects lived: a non-atomic write and an
unhandled `void main()`.

## Decision

Adopt `@vscode/ripgrep` as a runtime dependency. It ships a prebuilt `rg` per
platform as its own `optionalDependencies`, so `npm install` / `npm ci`
provisions the engine for the machine it runs on. `scripts/install-search-engine.ts`
and the version/asset half of `engine-manifest.ts` are deleted; the path comes from
the package.

**No `postinstall` hook.** The package used to do exactly that and abandoned it
after GitHub rate-limit, 403, proxy and yarn incidents; npm RFC-0054 is moving
install scripts to opt-in by default. The dependency resolves the binary at
import time, so no hook is needed.

## The engine version is 15.0.0, downgraded from 15.1.0

This is the part worth recording, because the decision that produced it rested on
an inference that measurement contradicted.

`@vscode/ripgrep@1.18.0` ships **ripgrep 15.0.0** (rev `3a612f88b8`). The repo
pinned **15.1.0** (rev `af60c2de9d`). The handoff inferred the package shipped
15.1.0 under an earlier label and expected zero test changes; it ships 15.0.0, so
this is a downgrade. Measured delta between the two binaries:

- `rg --help` differs only in the version string and the `cursor` hyperlink alias.
- `rg --type-list` differs by exactly one entry: 15.1.0 has `ssa: *.ssa`, 15.0.0
  does not (218 vs 217 types).
- Every flag `argv.ts` emits exists in both.
- The other 15.1.0 change (a `--line-buffered` regression fix) is never used.

Accepted because the provisioning model is worth more than one file type: the
model loses a 162-line downloader with two known defects, a manual provisioning
step nothing in CI performed, and a vendored binary tree.

## Consequences

- `type-table.ts` is regenerated from the pinned binary's `--type-list`, so the
  Node fallback stays a fallback and not a second engine. It loses `ssa`.
- `RIPGREP_VERSION` is a documentation constant: the binary that runs reports its
  own version. The dependency is pinned **exactly** (`1.18.0`, no caret) and
  `tests/harness/aci/search/engine-pin.test.ts` asks the binary (`--version`,
  `--type-list`) and compares both against the constant and the table. That test
  is the binding; without it the three sources of truth drift silently and the
  model is told a false version.
- Engine absence is unchanged as a contract (ADR-0089): the resolver answers
  `undefined` and the Node scan answers the call. The resolution is lazy and
  inside a `try`/`catch`, because the package's entry throws at import time when
  its platform package is absent — a module-scope import would turn a missing
  optional dependency into a process-wide crash, a failure class the downloader
  could not produce. Only a successful resolution is cached; a negative is
  dropped so a later call retries, since a long-lived `serve` must recover once
  its install settles.
- `.gitignore` keeps `/vendor/*` to hold back a stale tree from a prior install.
  Nothing produces it any more.
- `grep.test.ts` leaves the CI exclude set: `npm ci` now provisions the engine.

## Open follow-up

~32 comments across `src/harness/aci/search/` and
`src/harness/aci/tools/bash-read-extract.ts` record rg behaviour as "verified
against 15.1.0". They were not re-verified against 15.0.0, and at least one cited
pin no longer reproduces (`glob-match.ts:63` claims `rc=1`; the shipped binary
returns `rc=2` for `rg --glob '!'`). Sweeping them is a separate ticket.
