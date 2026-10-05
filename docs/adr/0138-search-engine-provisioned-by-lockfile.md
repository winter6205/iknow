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

## Comment sweep — done, and its premise did not survive measurement

The follow-up named when this ADR was drafted is complete (`2b6441118`). Its
two load-bearing claims were both wrong, so the correction is recorded here
rather than left to be re-derived:

- **The count was wrong.** "~32 comments" was exact for `src/`, but the test
  suite carried 23 more comment lines plus one test title — 55 comment sites
  and 1 title in total, 56 places.
- **The named example was wrong.** `glob-match.ts:63` claims `rc=1`, and
  `rc=1` is what actually happens: `rg --glob '!' hello .` returns 1 on both
  15.0.0 and 15.1.0. `rc=2` appears only when the path argument is omitted
  entirely, which is not the invocation the comment cites. There is no known-
  wrong `rc` claim in the swept set.

An A/B against the residual 15.1.0 binary (still on disk) found **no
downgrade-induced drift**: every mechanically checkable cited `rc`, flag and
verbatim output form is identical on both versions. The sweep was therefore a
re-attribution, not a re-litigation — historical numbers keep the binary they
were taken on, and "vendored rg" became "bundled rg" because
`vendor/ripgrep/` is no longer produced.

Three claims were not mechanically checkable and were re-measured; two were
wrong:

- `rg-output.ts` said rg "doesn't slice at all when the cut would land
  mid-character". It snaps the cut forward to a whole code point, so the body
  can exceed the byte budget — 7,999 ASCII + 300 CJK under an 8,000 budget
  yields 8,002 bytes. Also recorded: under `--max-columns-preview` the marker
  is emitted before the `\r`.
- `scope-guard.ts` quoted `--max-filesize=1MiB`, an rc=2 parse error on both
  binaries that exits in ~8ms without scanning anything, and derived its
  headroom from a 17.8s figure that does not reproduce. The number is kept
  only as a record of what was believed; nothing derives the limit from it.
- `bash-read-extract.ts` non-read flags re-confirmed. **`bat` is still not
  installed on the measuring host, so its row remains unverified** — the one
  item from this ADR still outstanding.
