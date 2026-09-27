# Stage 4a shadow-divergence + perf report (SC-S4-5, SC-S4-7)

Task: plan row T26 (`docs/unified-shell-parsing-plan.md`), integrator T26b.
PRE base: stage3 tip `c5058d76f` (all four consumers on text segmentation).
POST base: branch `shell-parse/stage4a` at `061eddf84` (T26's consumer
migrations plus T26a's splitter-export retirement); the POST column is
replayed live by the test, and the fixture regenerates byte-identically on
that tree, so this report describes the state the gates ran against.

## SC-S4-5 perf battery — `scripts/stage4a-perf-battery.ts`

Run: `npx tsx scripts/stage4a-perf-battery.ts` → exit 0.

| Metric                          | Value            | Binary        |
| ------------------------------- | ---------------- | ------------- |
| steady-state median overhead    | 0.011 ms         | ≤ 5 ms PASS   |
| steady-state p95 overhead       | 0.044 ms         | (reported)    |
| samples                         | 9 900            |               |
| excluded rows (aborted/over-cap)| 2                | (counted)     |
| first-parse init (cold process) | 53.2 ms          | ≤ 200 ms PASS |

Method: per-call overhead = the handler's pipeline (`isDangerousCommand` →
`validateReadonlyCommand`, the pair `bash.ts:839/:849` runs) minus the
no-parse baseline (`legacyFindDangerousPattern`). Population: 32 hot
single-command strings (all memo hits, capacity 64 respected) plus one
never-seen one-word command per pass (fresh parse path, LRU tail only).
Candidates classified `aborted`/`over-cap` (two 64 KiB+ shapes) are excluded
and counted. Warm-up runs through the same production entries; no settings,
fs, or `~/.iknow` access anywhere in the path.

## SC-S4-7 shadow divergence — `scripts/stage4a-shadow-divergence.ts`

Run: `npx tsx scripts/stage4a-shadow-divergence.ts` → exit 0, prints
`open=0` and `deny_to_silence_without_warrant=0`. PRE is materialized by
`git archive c5058d76f src/ | tar -x` into a tmp mirror (setup in the script
header); the script imports both graphs and never executes any corpus
command (no child process at all — gate-checked by `rg execSync|spawn|execFile`).

Corpus: 631 unique shapes = the 421-command column of
`stage2-differential.jsonl` + the 87 pinned lists snapshotted from
`root-find-hard-wall.test.ts` + 128 adversarial shapes drafted from the T22
parity battery populations (non-ok census rows, compound-scope roster,
quote/comment/heredoc boundaries, substitution bodies vs pipeline tails,
wrapper/assignment leads, per-consumer redirect/background/ledger/`git
status:*` shapes). The 64 KiB+ over-cap shapes live only in the perf
population; their non-ok arm is represented here by the pinned
`vetoed`/`malformed`/`unknown-syntax` rows.

Row set: 4 outputs × the rule set → 4 417 committed rows in
`tests/fixtures/shell-divergence/stage4a-shadow.jsonl` (622 KB; each row
carries command, output, rule, PRE value, POST value, label, warrant/cause).

Census:

| label                 | count | warrant                                  |
| --------------------- | ----- | ---------------------------------------- |
| same                  | 4 416 | —                                        |
| expected-relaxation   | 1     | named (below)                            |
| fixed                 | 0     | —                                        |
| open                  | **0** | binary 1 holds                           |
| deny→silence unwarranted | **0** | binary 2 holds                        |

The single divergent row:

- `readpath` / command `"cat\nf"` / PRE `"f"` → POST `null`, tagged
  `expected-relaxation` with warrant:
  `docs/shell-parse-non-ok-consumer-contracts.md` `extractSingleReadPath`
  bullet — a ledger record is an affordance, not a refusal, so recording
  nothing is the stricter side. The generator admits this class only by
  positive proof off the parse facts (recorded value starts after the first
  bare newline; ≥ 2 depth-0 command nodes), and the moved semantics are
  pinned by T24 at `bash-read-extract.test.ts:87` (bare `cat` records
  nothing) and `:851` (newline is a statement boundary). PRE's `"f"` was a
  newline-blind misrecord: `cat\nf` runs `cat` (stdin) then `f`; no file was
  ever read. No deny or refusal anywhere in the corpus moved.

Replay: `tests/harness/permission/shadow-divergence-stage4a.test.ts` re-derives
the POST column for all 4 417 rows from the current tree and re-checks both
binaries against the closed warrant registry (`git` is not re-run there).
Green: 6 passed (6).

## Zero-behavior posture

Three of the four consumers diffed identically everywhere, matching their
SC-S4-1 declarations: readonly keeps today's answer on every verdict (its
text fold stands behind every non-attributed shape), the role gate refuses the
same tokens (B3b newline non-cut preserved in both), declarative matching is
rule-identical for the mirrored specifier set. The one moved answer is the
ledger misrecord above — an affordance removal, not a protection change.
