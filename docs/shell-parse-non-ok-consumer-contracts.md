# Non-`ok` consumer contracts for the shared parse

Status: preparation evidence for Stage 4a (SC-S4-1 / SC-S4-2 of
`specs/hard-wall-ast-migration.md`). Nothing here moves a production caller:
the facts live on the `ok` payload of `parseForSecurity`
(`src/harness/permission/shell-parse.ts`), and every consumer answer below is
either today's answer, restated, or a parity demonstration in
`tests/harness/permission/shell-parse-segmentation-parity.test.ts` and
`tests/harness/permission/shell-parse-facts-c.test.ts`.

**Later edits are marked and layered, not folded back.** The Stage-4a framing
above, the census counts, and the "zero behavior change" close remain the
historical record of that preparation. Where **#1188** has since changed a
roster member or a fact's meaning, the change is added in place with that
label rather than rewriting the Stage-4a numbers — see the `vetoed` routing
note for `validateReadonlyCommand`, the `isAllowedCommand` prototype row, and
the escape-parity paragraph in the newline-fact section. A Stage-4a
measurement is not re-stated as a post-#1188 one.

## The closed set

`SecurityParseResult` (`shell-parse.ts:200`) is a closed verdict set: `ok`,
then the five non-`ok` verdicts `unknown-syntax` / `malformed` / `aborted` /
`over-cap` / `parser-unavailable`, plus the pre-parse `vetoed` arm, which is
not one of the five and never a seventh verdict (SC-S4-1 preamble). Of the
five, `malformed` / `aborted` / `over-cap` are the post-parse hard-deny
verdicts; `vetoed` fires before the parser runs.

Each of the four segmentation consumers must declare, in its own words, what
it answers for every non-`ok` verdict, because a consumer called directly
(not through `checkPermission`) does not inherit the wall's pre-emption. The
declarations, as SC-S4-1 states them and as this preparation honors them:

- **`validateReadonlyCommand` (`bash-readonly.ts:196`) — keep today's answer,
  add no throw.** For all five verdicts and the `vetoed` arm the gate returns
  what it returns today. The ordering does most of the work: `bash.ts:839`
  runs the wall before the readonly gate at `:849`, and `malformed`,
  `over-cap` and `vetoed` are denied at that wall, so the gate is pre-empted
  for exactly those three and needs no answer of its own. `aborted` is not
  among them (SC-GATES-3 boundary (i)). For `unknown-syntax` without
  security-relevant evidence, ADR-0124 retains today's mode behavior
  (`docs/adr/0124-parse-verdict-contract.md:33`); a `unknown-syntax` → refusal
  arm was explicitly abandoned and would breach this consumer's no-new-throw
  contract. The gate's own text rules keep their answers — those are throws of
  *recognition*, not of verdict (`echo a & ls` throws on the background
  operator). Any `vetoed` answer still reaches the same text path, because
  `validateReadonlyCommand` routes every non-`ok` verdict to
  `validateReadonlyTextPath` unchanged (`bash-readonly.ts:221-232`).
  **The backslash+whitespace representative for this consumer changed with
  #1188:** `echo\ test` is no longer a representative at all — escaped U+0020
  in a complete, maximal unquoted word is now an admitted spelling that never
  reaches this gate's denial path (ADR-0124 Amendment 2026-10-04). The
  retained representatives are the shapes whose Bash behavior still
  disagrees: unquoted backslash+TAB (`a\` TAB `b`, one Bash argument vs. two
  modeled words) and the mid-word LF continuation (`a\` LF `b`, one Bash
  argument `ab` vs. two modeled words). Both keep answering `vetoed` /
  `backslash-whitespace` and therefore keep this gate's existing answer; the
  consumer's own rules are untouched by the roster amendment.
- **`extractSingleReadPath` (`bash-read-extract.ts:783`) — record nothing.**
  All five verdicts and the `vetoed` arm → `undefined`. A ledger record is an
  affordance, not a refusal, so recording nothing is always the stricter side.
  `malformed` must be spelled out because the extractor is reached from
  `bash.ts:1236` (the ledger path), where no wall pre-emption runs in front
  of it.
- **`detectBashGrepSubstitution` (`role-substitution.ts:173`) — stay silent.**
  All five verdicts and the `vetoed` arm → `undefined`, no refusal. The gate
  refuses by recognizing a segment-leading grep word and never saw inside a
  shape it cannot tokenize. The one admitted relaxation is an
  `unknown-syntax` command the user then *approves* at the ask prompt, where
  silence replaces a possible recognition; it is tagged `expected-relaxation`
  citing ADR-0117's not-a-hard-wall scope (SC-S4-1, SC-S4-7), never waved
  through.
- **`declarative.ts` rule matching — fail toward no match.** Quote-blindness
  is this module's deliberate fail-toward-no-match property (SC-S4-3): a
  separator inside quotes makes the rule miss, never a silent grant. On a
  non-`ok` parse the same direction holds — no match, and no match is not an
  allow through this gate.

`isAllowedCommand` answers with the SC-S4-2 pins: an `ok` parse must ALSO
prove the syntactic no-bare-line-break fact (next section) before any
allowlisting is considered, and the closed non-`ok` set keeps today's
refusal (`false`) — see the parity battery's census, which grades each
non-`ok` row against exactly that answer.

## Known #1188 residual: `isAllowedCommand` on an admitted continuation

**This is the one place where the admitted spelling's semantics and a shared
consumer still disagree, and it is a deliberate, bounded deviation rather than an
oversight.** Recorded here rather than silently narrowed.

`isAllowedCommand("cat -n \\` LF ` b.ts")` answers `false` while its
equivalent `cat -n b.ts` answers `true`. Mechanism: the admitted parse
publishes no newline fact for the escaped LF, so `parseBoundedUnits` keeps the
command as one unit whose raw text still contains the byte, and
`isSegmentAllowed`'s metachar roster still refuses a unit carrying `\n`
(`hard-walls.ts:3372`, roster at `:3389`).

Direction and bounds:

- **Fail-closed only.** Measured across eight continuation placements — split
  destructive flags, split `rmdir` flags, a destructive command after a
  continuation, a sensitive operand, a redirect to a sensitive path, a pipe into a
  destructive command, a nested command substitution, and a destructive command
  after `&&` — plus the escaped-space spelling: **zero** admitted forms are less
  restrictive than their equivalent. Where the answers differ, the continuation is the *stricter* one
  (`false` against `true`). `findDangerousPattern` keeps matching on the facts,
  so `rm \` LF ` -rf /tmp/x` still returns `destructive-rm` even though the
  parse admits it.
- **Not a regression.** While the shape was `vetoed` the same text fold denied
  it, so #1188 moved this input from a hard denial to an ask, never the reverse.
- **Not fixed in #1188, deliberately.** `isSegmentAllowed` is an *allow* gate.
  Aligning it turns a refusal into an allow — a security-direction change in the
  central wall module. The amendment fixes a false refusal by admitting a
  measured spelling; it does not grant the authority to loosen an allowlist
  whose deny direction is the safe one. The parity rule that would be needed
  there (skip an LF/CR escaped by an odd-parity run) is the same rule the fact
  layer now applies in `bareLineBreaks`, so a follow-up can share one
  definition rather than re-deriving it.
- **Consumer scope.** `extractSingleReadPath` had the same disagreement and DID
  get fixed, because it is a ledger affordance rather than an authorizer and
  Bash's line-continuation semantics are unambiguous: `stepEscape`
  (`bash-read-extract.ts`) now drops both bytes of a backslash-newline instead
  of appending the escaped byte, so `cat -n \` LF ` b.ts` books `b.ts` exactly
  as `cat -n b.ts` does. Its 143-test suite and the readonly suite are green.

## The newline / carriage-return fact: the derived-fact arm

The Open Question at `specs/hard-wall-ast-migration.md:139` asks T22 to
expose either raw command text or an equivalent fact so `isAllowedCommand`
retains its `\n`/`\r` refusal (SC-S4-2's keep). **This preparation chooses the
derived-fact arm**: `SecurityParseOkFacts` publishes
`bareNewlineOffsets` and `bareCarriageReturnOffsets` (`shell-parse.ts:134`
onward) — sorted offsets at which a `\n` / `\r` occurs **outside** every
quoted span (`quotedSpans`) and outside every heredoc body span. Consumers
read booleans and offsets off the `ok` payload; nobody re-scans the raw text,
and the `over-cap`/`vetoed` arms never hand a re-scanner a reason to run.

Consequences pinned by `shell-parse-facts-c.test.ts`: `echo a\nls` →
`bareNewlineOffsets = [6]`; `echo a\rb` → CR at the `\r` byte even though the
parse shows one command (`echo` with words `a`, `b`); quoted and heredoc
newlines are absent from the lists; CRLF yields both offsets. The keep itself
(`isAllowedCommand("echo a\nls") === false`, `isAllowedCommand("echo a\rb")
=== false`) is asserted two-sided in the parity battery so the fact and the
answer are wired, not just the fact.

**Escape parity is now part of this fact (in force since #1188).** The two
lists name **bare** statement separators, so a `\n` / `\r` preceded by an
**odd-parity** backslash run is an escaped line break and is **absent** from
both; only an even-parity (unescaped) line break is reported. This changes
what the fact means for the admitted separator continuation: `a \` LF ` b`
reaches the fact layer and its LF is absent from `bareNewlineOffsets`, so it
does not present as a bare statement separator to `isAllowedCommand`,
`declarative.ts`'s cuts (`src/harness/permission/declarative.ts:528-529`),
readonly validation, or read-path extraction. Testing only the previous
character is insufficient — parity is what distinguishes an escaped break from
a bare one, and both spellings of the run must be covered. The Stage-4a comment
that assumed escaped line breaks never reached this scan (`…:1673-1677` at
`2523c1497`) is retired by the roster amendment.

## Security-review attribution is preserved, never flattened

Non-`ok` never collapses into an allow. The wall's route keeps the *class*
visible: `routeParseVerdict` (`hard-walls.ts:978-996`) turns `malformed`,
`aborted`, `over-cap` and `vetoed` into a `dangerous` hit with
`id = "unparseable"` and a verdict-bearing `pattern`, so the operator sees
which state refused, and the deny rides the non-overridable tier
(SC-GATES-5). Where ownership or recursion is unresolved with
security-relevant content, the result is the Security review requirement
(`securityReviewRouteFromAsk`, `build-engine.ts:675`), a separate pre-mode
route — not an `ask` member of `HardRuleSpec` and not an allowance. This
preparation adds no path from any non-`ok` verdict to a permit: the parity
battery's census grades every non-`ok` row as `isAllowedCommand === false`
and records zero rows where facts-derived logic answers `true`.

## Parity evidence (read-only oracle, no production caller moved)

Population: the 57 `DENIED` + 21 `ALLOWED` + 9 `NOT_THE_WALK_WALL` spellings
of `root-find-hard-wall.test.ts` plus the 421-command column of
`tests/fixtures/shell-divergence/stage2-differential.jsonl` = 507 shapes, of
which 503 parse `ok` and 4 are non-`ok` (the census above).
`splitShellSegments` is the exported oracle; the dangerous-scan splitter is
private, so the battery runs a replica that first proves itself
byte-identical to the oracle on the whole population.

- dangerous-scan boundary parity: E1 (oracle boundary the facts miss) = 0,
  E2 (facts boundary the oracle misses) = 0; every splitter-only boundary is
  provably inside a quoted span, heredoc body, or comment (the licensed
  quote-blind class, SC-S2-6 family).
- declarative superset cuts (`&`, `|&`, `\n`, `\r` added): 0 / 0 against the
  effective-cuts replica of `splitCommandSegments`.
- `isAllowedCommand` facts prototype: 499 / 503 agree; the 4 divergences are
  pinned rows whose refusal today rests on inert quote/comment punctuation
  (`[[ a == b ]]`, `echo hi &&`, the trailing-backslash PowerShell row, and
  the unquoted backslash+TAB row `a\` TAB `b`) — three are non-`ok` census
  rows, one is quote-blind punctuation — and each keeps today's `false` via
  the census route instead. **The fourth row was `echo\ test` at Stage 4a;
  since #1188 that spelling is admitted, so it is replaced here by a
  genuinely retained representative** (unquoted backslash+TAB), which keeps
  the row's original role — a shape whose Bash argument structure still
  disagrees with the modeled one. The mid-word LF continuation `a\` LF `b`
  (Bash: one argument `ab`; facade: two words) is the second retained
  representative if a further row is needed.
- role-substitution prototype: 503 / 503 identical (pipeline tails flagged,
  substitution bodies exempt — `echo $(grep x f)` → `undefined` both ways).
- readonly strictenings (SC-S4-1 rules 1a/1b/1c): 502 / 503; the single
  pinned row is the quoted-heredoc-body fork bomb, whose upstream `false` is
  owned by the wall (SC-S2-1 / SC-S2-8), not by this gate.
- roster discipline: no separator shape widened the modelled node-type
  roster; `case x in a|b)` stays `unknown-syntax` and the operator fact
  abstains (`operators = []`) on every shape outside statement scopes.

Re-running the Stage 2 generator after all of this leaves
`tests/fixtures/shell-divergence/` byte-identical — the preparation is
additive facts and tests, zero behavior change.
