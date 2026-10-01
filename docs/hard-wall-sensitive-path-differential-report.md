# T1 differential report — sensitive-path evidence classification (ADR-0131)

**Scope:** plan task T1 of `plans/hard-wall-denial-alignment.md`; spec
`specs/hard-wall-denial-alignment.md` Success Criteria 1, 2, 3, 14.
**Status of the repair:** implementation complete; two ledger conflicts are open
(see "Open conflicts" — they need a decision, not a workaround).

This report is T1's required acceptance artifact: every denial that changed,
what it changed to, which spec/ADR entry licenses it, and whether it relaxes
anything security-relevant.

## What changed

One new entry point, `classifySensitivePathEvidence(command)` in
`src/harness/permission/hard-walls.ts`, replacing the boolean
`commandContainsSensitivePath` as the *source* of the verdict (the boolean is
kept as its `confirmed` arm, so its existing callers keep compiling and now read
the shared result). It returns a three-way classification:

| class | meaning | effect |
|---|---|---|
| `confirmed` | the match sits at a site the parse established as a path TARGET — an argv operand, a redirect target, a heredoc body a code receiver runs, or an operand of a recursively parsed nested shell | non-overridable hard deny, both modes |
| `non_path` | the match is in a code/data region and its token was NOT established as a path target | no finding from this wall; ordinary permission handling |
| `unresolved` | the match is in a code/data region and the token IS path-shaped, but the consuming program is not proven to treat it as data | ADR-0127 fresh per-call review; existing typed deny when no interactive route |

`commandContainsSensitivePath` and the Bash handler (`bash.ts`, the
sensitive-path gate) now both read this one result. The handler's
`isDangerousCommand` call is untouched — that is the destructive-pattern family
(`findDangerousPattern`), a different rule, and the spec keeps it separate.

### The discriminator, and why it is not a text-shape heuristic

ADR-0131 records that a narrow `.env.` exception "was rejected because it leaves
the matching-domain error intact", and the coordinator flagged the same hazard
for any exemption keyed on the matched string. Measured on this tree, the shell
parse establishes **no** structural difference between the two decisive tokens:

```
process.env.NODE_OPTIONS   -> 1 command, argv[0] unquoted, 0 quoted spans
/etc/passwd                -> 1 command, argv[0] unquoted, 0 quoted spans
```

They are the same fact. So the classification cannot rest on either token's
shape. What separates them is the role the token is given when the code region
is re-parsed as its own text, plus the receiver's kind:

- re-parsed token lands in **inner operand position** → the inner program was
  told to open that file → `confirmed` (`sh -c 'cat /etc/passwd'`);
- re-parsed token lands in **inner command position**, unquoted, under a
  receiver that is not a shell, AND the token is a name by positive evidence
  (a run of bare-identifier segments joined by dots) → it is a
  property-access member (`process.env.NODE_OPTIONS` under `node`) → `non_path`;
- every other inner command-position match → `unresolved`. That includes a
  **quoted** token, which is a string literal the foreign source carries
  (`fs.readFileSync("/etc/shadow")`), and equally an **unquoted** token that is
  not a name (`F,"/etc/shadow"`).

The third arm is the bypass witness the coordinator named: the same region, the
same interpreter, a real path — and it does not become an allow.

#### Correction (2026-10-01): command position alone is not evidence

The first version of this report claimed the second arm was licensed by the
re-parsed token landing in *inner command position*. That is **wrong**, and the
claim was load-bearing: inner command position is decided by **whitespace** in
the foreign source, so the verdict became a function of formatting rather than
of what the token is. Measured on this tree:

```
perl -e 'open(F,"/etc/shadow")'   -> inner argv[0] swallows the rest, unquoted -> non_path, NO finding
perl -e 'open(F, "/etc/shadow")'  -> inner operand                            -> confirmed, hard deny
```

Two commands that read the same file, one space apart, with opposite verdicts.
At `a094e728a` the first is a hard deny; after the first version of this change
it was an allow. That is an unexplained security-relevant `deny → allow` and it
violates SC1, whose requirement is *no unexplained* row of that kind — the row
was real, and the report below was wrong to record its absence.

`codeRegionEvidence` now requires positive evidence that the token IS a name
(`isEstablishedIdentifier`: `^[A-Za-z_][A-Za-z0-9_]*$` per dot-separated
segment, whole token) **and** that the match is interior to it
(`matchIsInteriorToToken`, so the token is a chain member and not the sensitive
name itself) before a command-position match may produce no finding. Every other
command-position match is `unresolved`. Both requirements together are the whole
of the `non_path` evidence: the first closes the path-shaped family, the second
the two roster entries that are themselves valid identifiers (`id_rsa`,
`id_ed25519`) — see "Open conflicts" §3, where the second requirement's own
derivation and licence are recorded. Neither is a shape whitelist; the roster is
frozen and no fragment's spelling licenses anything.

Verified across interpreters, quote shapes and whitespace: 25 command-position
matches that the old rule answered `non_path` now answer `confirmed` or
`unresolved`, including `perl -e 'open(F,"<","/etc/shadow")'`,
`python3 -c 'import shutil;shutil.copy("/etc/shadow","/tmp/x")'`,
`php -r 'fputs("/etc/shadow","x");'`,
`node -e 'process.env.NODE_OPTIONS+fs.readFileSync("/etc/shadow")'` and
`node -e 'fs.readFileSync(id_rsa)'`. The `non_path` shapes the report's §2 and
the JSCA1 fixture name (`process.env.NODE_OPTIONS`, `process.env.HOME`,
`x.env = 1`, `os.environ['X']=1`, `$ENV{HOME}`) are unchanged.

## The differential table

30 probe commands, run before and after through `findDangerousPattern`,
`commandContainsSensitivePath` and `analyzeSecurityReview`. **Exactly 2 of 30
changed**, both the reported false denial:

| # | command | before | after | license | security relaxation? |
|---|---|---|---|---|---|
| 1 | `node -e 'process.env.NODE_OPTIONS'` | `sens=true` (hard deny) | `non_path`, no finding; ordinary permission flow | ADR-0131; spec SC1's named example | **Yes — and it is the intended one.** No path target is touched: the token is a property-access member, not a file. |
| 2 | `node -e "console.log(process.env.HOME)"` | `sens=true` (hard deny) | `non_path`, no finding | same | same |

Every other probe case is byte-identical before and after, including all of
these, which are the ones a relaxation would have damaged:

- confirmed direct `cat /etc/shadow`, `cat /etc/passwd` — still hard deny
- nested shell `sh -c 'cat /etc/passwd'` — still hard deny
- substitution `echo $(cat /etc/passwd)` — still hard deny
- redirect `echo a > '/etc/passwd'`, `echo a >> /etc/shadow` — still hard deny
- expanded / quoted operands `test -r "$HOME/.ssh/id_ed25519"`,
  `cp '/home/u/.ssh/id_rsa' /tmp/x`, `mv "$HOME/.aws/credentials" /tmp` — deny
- assignment value `FOO='id_rsa' printenv` — deny
- loop list `for f in .ssh/id_rsa; do cat $f; done` — deny
- `eval 'cat /etc/shadow'`, `echo /etc/shadow | xargs cat`,
  `docker cp ~/.ssh/id_rsa host:/tmp/x`, `export NODE_OPTIONS=--require /etc/shadow` — deny
- `awk '{ print }' /etc/passwd` — **confirmed** (argv operand), deny
- anchored miss `cat .env | head` — still not denied (unchanged non-goal)
- inert `cat <<'EOF'\nid_rsa\nEOF\n` and the comment case — still no finding
- T6 root-find `find / -maxdepth 3` and T5 `rm -f tmp_pycheck.cjs` — untouched
  (different walls; their verdicts are byte-identical)

### Diagnostic string changes (not verdict changes)

Two operator-visible strings changed. Neither changes a verdict.

| surface | before | after | why more accurate |
|---|---|---|---|
| sensitive-path deny reason | `dangerous command: sensitive path targeted by command` | `… (matched \`.ssh/\` at the argv-operand)` | Before, every confirmed match on every command rendered one identical string, so the operator saw THAT a sensitive path was targeted but not WHICH roster entry fired. This is the same information the `pattern=` arms already carry, and what `boundary-refusal-copy.test.ts` requires of the path-bearing arm. |
| `malformed` diagnostic | `verdict=malformed` | `verdict=malformed 语法不完整：解析树带有 ERROR/MISSING 节点（如引号未闭合）` | **SC14.** `routeParseVerdict` dropped the parse layer's own reason, so the deny named a structural token and nothing the operator could act on. `over-cap` and `vetoed` already carried theirs; `malformed` is now consistent. `malformed` remains a hard deny. |

Golden expectations updated for both: `deny-reason-golden.test.ts` (2 rows +
the sensitive-path arm), `substitution-matrix.test.ts` (6 strings),
`degrade-full-strength.test.ts` (2 rows), and the `head` side of 3 rows in
`tests/fixtures/shell-divergence/stage2-differential.jsonl` (regenerated, see
below).

## Unchanged contracts (checked, not assumed)

- **Fragment roster** — `SENSITIVE_PATH_FRAGMENTS` is byte-identical; nothing
  added or removed. No fragment was exempted by name.
- **Anchors** — `cat .env | head` still does not deny, the named non-goal.
- **ADR-0124 non-`ok` destinations** — each is pinned by a test in
  `sensitive-path-evidence.test.ts` §6: `unknown-syntax` keeps the ask tier,
  `over-cap` keeps its hard deny with ADR-0124 §5's reason, `vetoed` keeps its
  hard deny naming the character class, `malformed` keeps its hard deny.
- **Degrade path** — `parser-unavailable` has no `ok` payload to classify, so a
  fragment there is `confirmed` at full strength exactly as before (ADR-0124
  §4). This was a real regression caught by
  `degrade-full-strength.test.ts` during the work and is fixed.
- **Recursively parsed nested-shell access** — still denied (`sh -c`, `$( )`).
- **ADR-0127 review semantics** — unchanged, except that the `unresolved` class
  now reaches it. Reviewer unavailability still yields the existing typed deny
  and is never a confirmed violation (pinned by two executor-level tests).
- **T5 / T6 scope** — `findDangerousPattern` and the destructive branch are
  untouched; T5's scratch/workspace and T6's root-search allowances are not
  implemented here.

## Unexplained security-relevant `deny → allow`

**Two, both now fixed. The first version of this report said "None"; that was
wrong.**

1. `perl -e 'open(F,"/etc/shadow")'` — at `a094e728a` a hard deny; the
   command-position arm read the re-parsed token as a name because the foreign
   source had left no word boundary in front of the fragment, and answered
   `non_path`, so the wall produced **no finding at all** — not a deny and not
   an `unresolved` review. Its twin `perl -e 'open(F, "/etc/shadow")'` denied
   throughout. Cause and fix are in the "Correction" subsection above; the 20
   further command-position matches the same rule mis-sorted are listed there.
   Licence for the resulting `unresolved`: ADR-0127's fresh per-call review,
   which with no interactive route is the existing typed deny — the same
   destination `node -e 'fs.readFileSync("/etc/shadow")'` already had.

2. Residual, **closed** — see "Open conflicts" §3 below. A roster entry that is
   itself spellable as a bare identifier (`id_rsa`, `id_ed25519`) still reached
   the exemption, because "looks like an identifier" was the only test and
   `id_rsa` passes it. Fixed by adding the second necessary condition: the match
   must be **interior** to the token, so the token is a property-access chain
   MEMBER and not the sensitive name itself. Pre-existing, not introduced by the
   correction above.

After both fixes, no probe case loses a denial that the parse had established as
a target, and no case in which a roster fragment names a real path classifies as
`non_path`. Across the ~100-case adversarial probe the count of real paths
answering `non_path` went 21 → 4, and the 4 remaining are the deferred
roster-reach gap in "Open conflicts" §4 — every one of them carries **no
fragment at all**, so they are a question about which text the roster matches,
not about `non_path` evidence.

One case deserves to be called out because it is the natural next false-positive
and it was checked rather than assumed: `node -e 'fs.readFileSync("/etc/shadow")'`
is a real read of a real file, and the classification answers `unresolved`, not
`non_path` — it routes to ADR-0127 review, and with no interactive route to the
existing typed deny. It is never an allow.

## Open conflicts (need a decision)

### 1. The differential ledger authorizes exactly one `{id, pattern}` move; SC14 mandates a second

`tests/fixtures/shell-divergence/stage2-differential.jsonl` is a generated
ledger whose `base` side is a frozen observation from the pre-migration commit
`3b31b5562` and whose `head` side is the current tree. It authorizes exactly one
`{id, pattern}` move — the fork-bomb id move — and labels any other
`deny → deny` string change as `open`, which
`stage2-floor-differential.test.ts` treats as a merge blocker.

Re-running the generator
(`npx tsx scripts/stage2-floor-differential-generate.ts`) after the SC14 change
produced exactly this, and nothing else:

```
line 23   echo hi &&                                    -> open
line 151  powershell -c Remove-Item -Recurse -Force C:\  -> open
line 803  python3 <<'EOF'\nopen('/etc/passwd').read()\nEOF -> open
```

All three are the `malformed` diagnostic, on both `base` (bare
`verdict=malformed`) and `head` (with the reason). Two assertions fail as a
result: "no row was recorded as an unlicensed divergence" and "exactly the one
authorized id move".

This is a genuine conflict between SC14 (which requires the diagnostic change)
and the ledger's single-authorized-move invariant. I implemented SC14 literally
and did **not** self-authorize a second move, because that invariant is a
deliberate anti-regression gate: a second unauthorized `{id, pattern}` move is
exactly the shape of a silent re-plumbing that keeps its own text. Options for
the coordinator:

1. Extend the ledger's authorized-move set with the `malformed` diagnostic
   (keeping the label `same` for the id and the tier, since the id did not move
   and both sides still deny) — requires editing the generator's
   `AUTHORIZED_ID_MOVE` and the test's `AUTHORIZED_MOVE`, or
2. Record these rows with a distinct label for "diagnostic text corrected, tier
   and id unchanged", or
3. Re-baseline the ledger's `base` observation to a post-SC14 commit.

Option 3 is the cleanest if the ledger is meant to track the pre-migration
baseline only; option 1 is the most conservative if it is meant to remain a
live anti-regression gate. **This is not a code defect and I did not work
around it.**

### 2. `awk '{ print }' /etc/passwd` classifies `confirmed`, not `unresolved`

I initially expected the unclassified-consumer case to be `unresolved` and wrote
a test asserting that. It is not, and the spec is right: `/etc/passwd` is an
argv **operand**, and an operand is a site the parse established as a path
target — the shell opens it whatever `awk` would have done with it, and
ADR-0131's rule 1 covers it. The review layer separately prices the
`execution-unresolved` question about `awk`'s program operand, and both still
happen; only the sensitive wall's class is `confirmed`. My test table was wrong
and was corrected. Flagging it because it is the boundary between rules 1 and 3
and a reader will reasonably expect the other answer.

### 3. CLOSED — a token that IS the fragment is not a chain member

`isEstablishedIdentifier` alone was not a sufficient condition for `non_path`.
Two roster entries — `id_rsa` and `id_ed25519` — are themselves valid bare
identifiers, so a token consisting of nothing but the secret name cleared the
test and was exempted:

```
node -e 'id_rsa'                      -> non_path   (before this fix)
node -e 'fs.readFileSync(id_rsa)'     -> non_path   (a real read of a real key)
node -e 'a.b.id_rsa'                  -> non_path
```

That is a third `deny → allow`, pre-existing and not introduced by the §Correction
above — measured by running the probe with the name requirement removed, where
these cases answer identically.

**The fix is a second necessary condition, not a stricter shape list.** For
`non_path`, the roster match must be **interior** to the token — something must
follow it:

```
process.env.HOME      `\.env\.` matches `env.`, `HOME` follows   -> interior  -> exempt
process.env.NODE_OPTIONS                                                          -> exempt
id_rsa                the fragment is the ENTIRE token          -> terminal  -> NOT exempt
a.b.id_rsa            the fragment ends the token               -> terminal  -> NOT exempt
```

Framed as "does anything follow the match" rather than as a list of exempt
spellings, deliberately: the roster is frozen by the spec (`specs/hard-wall-denial-alignment.md`
accepted decision 1; ADR-0131 "does not add fragments, re-anchor end-of-command
patterns per operand"), and any criterion keyed on *which* fragment matched
would be a shape whitelist — the remedy ADR-0131 rejected and the one that
produced the bypass. A token that **is** the sensitive name is not inert content
whatever its letters are, so it routes to ADR-0127 review like every other
unproven case.

`sh -c 'id_rsa'` already answered `unresolved`, because the shell arm
short-circuits before this one.

Implementation note: the interiority test measures the **matched text**, not the
pattern. A regex arm's pattern is longer than what it matches (`\.env\.` is six
characters and matches `.env.`, five), so `sensitiveFragmentAt`'s existing `end`
— a diagnostic span the deny reason quotes — cannot answer this question;
`rosterMatchEndAt` measures it separately so no reported offset moves.

### 4. DEFERRED — the `$`-anchored roster arms do not reach a quoted literal

Found while probing, and explicitly **not** fixed here: the roster's end-of-
command arms never fire on a quoted string literal, so a file read by name in
foreign code is not classified at all rather than classified wrongly.

```
rosterHit('server.pem') = \.pem$
rosterHit('"server.pem"') = null          <- the arm does not reach the quotes

node -e 'fs.readFileSync("x.pem")'   -> non_path, fragment "-"  (no match at all)
python3 -c 'open("server.pem").read()' -> non_path, fragment "-"
php -r 'echo file_get_contents("tls.key");'  -> non_path, fragment "-"
ruby -e 'File.read("cert.p12")'      -> non_path, fragment "-"
```

These are the last 4 of the probe's real paths answering `non_path`, and they
are a different question from the two above: there is no match to classify, so
no amount of tightening the `non_path` evidence can reach them. The fix is in
the roster's matching domain, which the spec freezes for this round. Carried
forward as a separate decision.
