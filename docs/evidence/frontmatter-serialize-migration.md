# Evidence: memory `serializeMemoryEntry` vs `yaml.stringify` (PR-③ / ADR-0123)

Measurement only. This file records what the shared-frontmatter migration changed on
disk-shaped bytes, and what a `serialize → yaml.stringify` switch would cost. It makes
no recommendation — the decision is listed as an open question at the bottom.

Privacy: no memory body text and no real title/identifier string appears here. Only key
names, value _shape_ classes, counts, byte lengths and byte offsets. Every literal in a
code sample is a synthetic stand-in.

## 1. Corpus

Searched at `<dataDir|~/.iknow>/projects/<slug>/memory/*.md` (`MEMORY.md` index files
excluded), plus the pre-projects legacy layout `<repo>/.iknow/memory/<slug>/*.md`, which
is where most on-disk entries still live on this machine.

| fact              | value                                                      |
| ----------------- | ---------------------------------------------------------- |
| files             | 19                                                         |
| total bytes       | 11 494 (8 784 legacy + 2 710 projects; see §9 corpus note) |
| frontmatter lines | 169                                                        |
| layout            | 2 `~/.iknow/projects/…` + 17 legacy                        |

## 2. Shape census (169 lines, blanks counted in the shortest bucket)

Keys observed — 8 of the 9 canonical fields (`body` is never a frontmatter key) plus one
unknown extra key:

| key          | n   | shapes present                                                                               |
| ------------ | --- | -------------------------------------------------------------------------------------------- |
| `id`         | 19  | unquoted/ascii len 9-24 = 17 · blank = 2                                                     |
| `type`       | 19  | unquoted/ascii len 9-24 = 10 · len 1-8 = 9                                                   |
| `importance` | 19  | integer = 19                                                                                 |
| `ttl_days`   | 19  | integer = 19                                                                                 |
| `disabled`   | 19  | boolean = 19                                                                                 |
| `supersedes` | 19  | null-literal = 19 (**no real file carries a non-null list**)                                 |
| `title`      | 19  | unquoted/ascii: 40+ = 5 · 25-40 = 4 · 9-24 = 1; unquoted/cjk: 40+ = 4 · 25-40 = 1 · 9-24 = 4 |
| `updated_at` | 19  | iso-datetime = 19                                                                            |
| `source`     | 17  | unknown extra key, unquoted/ascii len 1-8 = 17                                               |

Value-length buckets over all 169 lines: 1-8 → 104, 9-24 → 51, 25-40 → 5, 40+ → 9.
All 19 files end without a trailing newline; none uses CRLF.

Absent from the whole corpus: quoted values (0), values containing `: ` (0), values
containing `#` (0), block scalars (0), YAML lists (0), CRLF (0).

## 3. Read-side equivalence actually delivered by PR-③

| measurement                                           | result  |
| ----------------------------------------------------- | ------- |
| fence matched by the deleted per-line regex           | 19 / 19 |
| fence matched by the shared `FENCE`                   | 19 / 19 |
| files where the two fences disagree                   | 0       |
| blocks the shared YAML parse rejects                  | 0       |
| per-field parse divergences, old parser vs shared     | 0       |
| `computeSignature` divergences, old vs shared         | 0       |
| `serializeMemoryEntry(parseMemoryEntry(raw)) === raw` | 19 / 19 |

The same fence comparison run over the 15 installed agent-role files that reach the
subagent catalog (`~/.iknow/agents` + `~/.iknow/plugins/cache/*/*/*/agents`): fence
disagreement 0, but **2 blocks are rejected by the shared parse** — both carry an
unquoted `description:` whose text contains `": "` (`Nested mappings are not allowed in
compact mappings`). Under the old per-line parser those 2 files kept a description; under
block-atomic degradation they fall back to the synthesized
`User-defined subagent role '<id>'.` and emit one warn each. This is a live third-party
authoring shape, not a hypothetical.

## 4. Byte comparison per distinct shape

For each shape: one canonical entry, `serializeMemoryEntry(entry)` ("hand", the current
writer) vs `stringify(entry)` ("yaml", `yaml@^2.9.1` defaults). Totals are whole-document
bytes; `obs.` is how many times the shape occurs in the 19 real files. All values are
synthetic stand-ins.

| #   | shape (key)                             | obs. | hand line                      | yaml line                        | hand B | yaml B | ΔB  | hand lines → yaml |
| --- | --------------------------------------- | ---- | ------------------------------ | -------------------------------- | ------ | ------ | --- | ----------------- |
| 1   | blank (`title:`)                        | 2\*  | `title: `                      | `title: ""`                      | 104    | 111    | +7  | 11 → 10           |
| 2   | unquoted ascii (`title`)                | 10   | `title: Use bar() not foo()`   | `title: Use bar() not foo()`     | 123    | 128    | +5  | 11 → 10           |
| 3   | unquoted CJK (`title`)                  | 9    | `title: <cjk 15 chars>`        | identical text                   | 126    | 131    | +5  | 11 → 10           |
| 4   | iso-datetime (`updated_at`)             | 19   | `updated_at: 2026-…000Z`       | identical text                   | 128    | 133    | +5  | 11 → 10           |
| 5   | integer (38) / boolean (19) / null (19) | 76   | `importance: 3` etc.           | identical text                   | 104    | 111    | +7  | 11 → 10           |
| 6   | comma-flat list (`supersedes`)          | 0†   | `supersedes: aaaa…,cccc…`      | `supersedes:` + 2 seq lines      | 125    | 140    | +15 | 11 → 12           |
| 7   | scalar extra key (`source`)             | 17   | `source: auto` (last)          | `source: auto` (last)            | 117    | 124    | +7  | 12 → 11           |
| 8   | value containing `": "` (`title`)       | 0    | `title: Fix the parser: today` | `title: "Fix the parser: today"` | 125    | 132    | +7  | 11 → 10           |
| 9   | value containing `" #"` (`title`)       | 0    | `title: cost #1 note`          | `title: "cost #1 note"`          | 116    | 123    | +7  | 11 → 10           |
| 10  | real long ascii title, folded           | 3    | 1 line, len 101/89/84          | 2 lines, break at a space        | —      | +2 ea  | +2  | 12 → 13           |

\* the 2 observed blanks are on `id`, not `title`. † shape 6 is what the current writer
_produces_ for a list; no real file is in that state yet.

Divergence classes, named:

- **Fences.** Hand emits `---\n…\n---\n`; `stringify` emits none (hand doc starts `"---\nid"`,
  yaml doc starts `"id: \"\""`). A switch must re-add the wrapper.
- **Trailing newline.** Hand emits no trailing newline (doc ends `"\n---\n"` + body), which is
  what all 19 real files look like. `stringify` always ends `"\n"`, so a naive switch also
  shifts the fence/body seam by one byte.
- **Blank values.** Hand emits `key:` + a trailing space; yaml emits `key: ""`. +2 bytes per
  blank line — this is the single most common real divergence here (2 of 5 rewritten files).
- **Key order.** Hand = `KNOWN_FRONT_KEYS` order, extras appended in encounter order
  (`id,type,importance,ttl_days,disabled,supersedes,title,updated_at,aextra,zextra`).
  `stringify` = object insertion order, and `body` is emitted as an ordinary key at its
  position in the record (`…,title,body,updated_at,zextra,aextra`). A switch must both drop
  `body` from the mapped record and decide whether the known-key order survives.
- **List rendering.** Hand joins with `,` on one line; yaml emits a block sequence (+15 bytes,
  +1 line per element here).
- **Line folding.** `stringify`'s default `lineWidth: 80` breaks long plain scalars at spaces
  (3 of 19 real files gain one line, +2 bytes each). Values with no break opportunity (60-char
  CJK run with no spaces, `a  b  c` double-spaced) were **not** folded — no forced-chop hazard
  measured, and every folded value read back byte-equal.
- **Quoting.** Hand never quotes; yaml quotes exactly the values that would be misread
  (shapes 8, 9, and a value starting with an indicator such as `[`).

## 5. Blast radius of a writer switch, on the real corpus

Wrapping `stringify` in `---\n…\n---\n` with `body` excluded from the mapped record,
**`stringify` at its defaults (`lineWidth: 80`)** — i.e. this table prices the switch as it was
under consideration, before §8's `lineWidth: -1` pin. The landed writer's blast radius is
re-measured in §9.

| metric                                                             | value               |
| ------------------------------------------------------------------ | ------------------- |
| files whose bytes would be identical                               | 14 / 19             |
| files a next save would rewrite                                    | 5 / 19              |
| first differing byte offset in those 5                             | 8, 8, 143, 169, 171 |
| byte delta per rewritten file                                      | +2 (all five)       |
| non-`body` fields that change when the rewritten form is read back | 0                   |
| `body` values that change when the rewritten form is read back     | 0                   |
| `computeSignature` stability across the rewritten form             | 19 / 19             |

The three offsets beyond the two blanks are shape 10: files whose long ascii title the default
line width broke onto a continuation line. Pinning `lineWidth: -1` removes exactly that class,
which is why §9 measures 2 rewritten files, not 5.

## 6. `computeSignature` consequences

`computeSignature` digests 9 canonical fields joined by `\u0000`; it reads parsed values, not
file bytes, so it is insensitive to fence/quoting/order per se. Measured:

- PR-③ read side: 0 signature changes across all 19 real files.
- Writer switch: 19/19 signatures stable, including the 5 files whose bytes change — a
  switch does not invalidate dedupe/supersede identity on this corpus.
- Round-trip stability `sig(entry) === sig(parse(serialize(entry)))` on synthetic shapes:
  healthy ascii / CJK / comma-list / blank → stable under **both** writers. Values containing
  `": "`, `" #"` or a leading indicator → **unstable under the hand writer, stable under the
  yaml writer**: the hand writer emits them bare, the shared reader then either rejects the
  whole block (all fields default → different digest) or truncates the value at the `#`, while
  the quoted yaml form reads back with the correct title, intact body and the original digest.
  That instability is a property of the _unquoted writer_ meeting the strict shared reader —
  PR-③ is what made it observable; it is reachable from `save.ts` today and 0 real files hit it.

## 7. Open question (not decided here)

Quoted verbatim from the PR plan's 「Confirms with human」list:

> serialize→`yaml.stringify` landing decision — after the PR-③ evidence report.

No preset position: this report was written to serve that decision, not to steer it, and
the measurements above are offered without a recommendation.

## 8. Decision (appended 2026-09-23, after this report served its purpose)

The switch landed: memory `serializeMemoryEntry` now emits its frontmatter map through
`yaml.stringify` instead of the hand-written flat writer. Authority is the operator's
decision in the 2026-09-23 session; the trigger is §6's last bullet read as a defect rather
than a cost — with PR-③'s reader in place the product's own writer produced bytes the
product's own reader rejected (a `": "`-bearing `title` came back with `title` and `id` both
empty). Recorded in ADR-0123's Amendment, spec `specs/frontmatter-shared-parser.md` PR-③ /
SC4 rewritten to match.

Accepted trade-off: the blast radius re-measured in §9 on the landed writer — 17/19 files
byte-identical, 2/19 rewritten by +2 B on their next save (both diverge first at byte offset 8,
the blank-value shape), zero field loss, `computeSignature` stable 19/19. §1–§7 measurements
were taken with `stringify` at its defaults and stand as the pre-decision pricing; §9 supersedes
§5's counts for anything read forward.

Shape pins that survived the switch: `KNOWN_FRONT_KEYS` order then sorted extras, `body`
outside the block, comma-flat `supersedes` (kept as a pre-joined scalar, so shape 6's +15 B
block-ification was not taken), `lineWidth: -1` so shape 10 never folds.

## 9. Re-measurement on the landed writer (2026-09-23)

§5 priced a _hypothetical_ switch with `stringify` at its defaults. The switch then landed with
`lineWidth: -1` pinned, so the delivered cost was measured again against the real implementation:
every corpus file read → `parseMemoryEntry` → `serializeMemoryEntry` → byte-compared with the
original, plus a field-by-field and signature re-read of the produced form.

| metric                                                | value   |
| ----------------------------------------------------- | ------- |
| files read back byte-identical                        | 17 / 19 |
| files a next save rewrites                            | 2 / 19  |
| first differing byte offset in those 2                | 8, 8    |
| byte delta per rewritten file                         | +2      |
| blocks the reader rejects (`parseMemoryEntry` throws) | 0       |
| non-`body` fields that change on re-read              | 0       |
| `body` values that change on re-read                  | 0       |
| `computeSignature` stability                          | 19 / 19 |

Both rewritten files are the two blank-`id` entries of §2 (shape 1: `id: ` → `id: ""`), the one
divergence class `lineWidth: -1` cannot remove. The 3 folding-driven rewrites §5 counted are
gone, matching §8's pin list.

Corpus note: the same 19 files, same 169 frontmatter lines as §1–§2; whole-document bytes
measure 11 494 (legacy 8 784 + projects 2 710), which supersedes §1's 10 002 — that row did not
reproduce under any split of the same glob, and only the byte total moved, not the shape census.
