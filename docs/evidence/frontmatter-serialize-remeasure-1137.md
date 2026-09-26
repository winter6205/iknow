# Evidence: SC-Corpus re-measurement on a rebuilt stand-in corpus (#1137, 2026-09-26)

Regression evidence for `specs/memory-frontmatter-write-signals.md` SC-Corpus: the
memory writer as landed after #1137 part A (`serializeMemoryEntry` refuses a
non-scalar extra, `463cf5663`) and part B (quarantine warns, `7570a86c0`) is measured
against §9's procedure once more. **This note measures a rebuilt, shape-faithful
stand-in corpus — synthetic values throughout, not the original bytes.**
`docs/evidence/frontmatter-serialize-migration.md` §1–§9 are left exactly as recorded
there; nothing in this note edits them.

Privacy: same rule as that document — no memory body text and no real title,
identifier or filename appears here, only key names, shape classes, counts, byte
lengths and offsets.

## 1. Why the corpus was rebuilt

The 19 files §9 measured cannot be read again on this machine. Verified in this
session:

| check                                                                 | result                                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `<repo>/.iknow/memory/<slug>/*.md` (17 entries, `MEMORY.md` excluded) | present, sizes total **8 784 B** — §1's legacy figure — with **0 non-zero bytes** in each |
| `<dataDir>/projects/<slug>/memory/` (the 2 projects-layout entries)   | directory exists and is **empty**                                                         |
| `git ls-tree -r --name-only HEAD -- .iknow`                           | only `mcp.json`, `settings.json`, `skills/` — no memory entries                           |
| `git log --all --oneline -- '.iknow/memory'`                          | empty (never tracked; `.gitignore:143` `.iknow/*` covers it)                              |

So the byte sizes survived and the content did not: the legacy entries are zero-filled,
the projects pair is gone, and no git object holds either. The operator ruled
(2026-09-26) that the re-measurement proceeds on a corpus rebuilt to §2's shape census
and §4's pinned title lengths, and that the §1–§9 record stays untouched.

## 2. Reconstruction fidelity — target shape → emitted shape

`scripts/measure-frontmatter-corpus.ts` writes the corpus into a fresh temp directory
in both on-disk layouts and then reads it back from disk, so the census below is
measured from emitted bytes, not from the plan that produced them. It is a hard
requirement of the script: a mismatch exits non-zero.

| key          | target (evidence §2)                                                                | emitted   |
| ------------ | ----------------------------------------------------------------------------------- | --------- |
| `id`         | `blank`=2 `unquoted/ascii len 9-24`=17                                              | identical |
| `type`       | `unquoted/ascii len 1-8`=9 `unquoted/ascii len 9-24`=10                             | identical |
| `importance` | `integer`=19                                                                        | identical |
| `ttl_days`   | `integer`=19                                                                        | identical |
| `disabled`   | `boolean`=19                                                                        | identical |
| `supersedes` | `null-literal`=19                                                                   | identical |
| `title`      | `ascii 9-24`=1 `ascii 25-40`=4 `ascii 40+`=5 `cjk 9-24`=4 `cjk 25-40`=1 `cjk 40+`=4 | identical |
| `updated_at` | `iso-datetime`=19                                                                   | identical |
| `source`     | `unquoted/ascii len 1-8`=17                                                         | identical |

Corpus-level facts, all reproduced: 19 files (17 legacy-layout + 2 projects-layout),
169 frontmatter lines, value-length buckets `1-8`=104 `9-24`=51 `25-40`=5 `40+`=9,
whole-corpus **11 494 B (legacy 8 784 + projects 2 710)** — §1's totals, hit by
matching each file to the per-file byte size the damaged corpus still reports.
Absent-from-corpus shapes all measure 0: quoted values, values containing `": "`,
values containing `#`, block scalars, YAML lists, CRLF; 0 files end with a trailing
newline. §4's three long-fold titles are emitted at exactly **101 / 89 / 84** chars
(single-line plain scalars with break opportunities), and one 40+ CJK title carries no
space at all — §4's no-break-opportunity class.

Disclosed choices where the surviving record is silent:

- §1 and §2 do not cross-tabulate layout against blank-ness, so the two blank-`id`
  entries are placed among the 17 legacy files and are also the two entries without
  the `source` extra (§2 counts 17 of each). No measured number depends on either
  placement.
- The 2 projects-layout sizes are a split of §1's 2 710 B (1 455 + 1 255); only the
  pair total was recorded.
- Entries, ids, filenames and bodies are synthetic. A body is prose plus a final
  deterministic pad line whose length absorbs the remainder so the file lands on the
  recorded size.
- Values that must read back as strings are rejection-sampled for it — see §4 below.

What a stand-in cannot give back: the real values themselves (only their shape
classes), and any §2 fact that is not expressible as a shape count. Everything §9
measured is a shape fact, which is why this rebuild is admissible as its regression
evidence — but it re-measures the writer, not the store's contents.

## 3. Measured result vs the §9 baseline

§9's procedure, run per file: raw bytes → `parseMemoryEntry` →
`serializeMemoryEntry` → byte-compare → re-parse the produced form → field-by-field
diff → `computeSignature(original)` vs `computeSignature(re-read)`.

| metric                                                | §9 (real corpus, 2026-09-23) | this run (stand-in, 2026-09-26) | match   |
| ----------------------------------------------------- | ---------------------------- | ------------------------------- | ------- |
| files read back byte-identical                        | 17 / 19                      | 17 / 19                         | yes     |
| files a next save rewrites                            | 2 / 19                       | 2 / 19                          | yes     |
| first differing byte offset in those                  | 8, 8                         | 8, 8                            | yes     |
| byte delta per rewritten file                         | +2                           | +2                              | yes     |
| blocks the reader rejects (`parseMemoryEntry` throws) | 0                            | 0                               | yes     |
| non-`body` fields that change on re-read              | 0                            | 0                               | yes     |
| `body` values that change on re-read                  | 0                            | 0                               | yes     |
| `computeSignature` stability                          | 19 / 19                      | 19 / 19                         | yes     |
| warnings emitted by the shared parse                  | —                            | 0                               | new row |

Both rewritten files are the two blank-`id` entries (`id: ` → `id: ""`), the one
divergence class `lineWidth: -1` cannot remove, and the 3 long-title files stay on one
line as §8 predicted. So parts A and B moved the corpus result by nothing: A's refusal
fires only on a non-scalar extra, and §2 records that every extra in this corpus is
scalar; B changed only what a consumer reports about a file the reader rejects, and
this corpus rejects none.

## 4. What the rebuild itself caught

The first run reported 16/19 identical with one file shrinking 4 bytes at offset 8 —
not a writer regression, a reconstruction defect. A generated 12-hex stem happened to
come out as `1e5850667870`, which the YAML core schema resolves as a float exponent
before it is any name: the reader returned `Infinity` for `id`, and the writer handed
back an 8-char value. §2 records every present `id` as `unquoted/ascii`, i.e. a value
that reads back as a string, so the real corpus held no number-shaped id; the harness
now rejection-samples stems against that hazard (`YAML_NON_STRING`), and the numbers
above are the run after that fix. Worth stating plainly, since it is the one place
where a careless stand-in corpus would have reported a false regression — and it is a
property of the shape, not of this script: a hex-looking memory `id` that YAML can read
as a number does not round-trip through this writer unchanged, and nothing in the write
path rejects it.

## 5. Reproduce

```bash
npx tsx scripts/measure-frontmatter-corpus.ts          # measure, clean up, exit 0
npx tsx scripts/measure-frontmatter-corpus.ts --keep   # also print the temp corpus path
```

The script imports the production `parseMemoryEntry` / `serializeMemoryEntry` /
`computeSignature` from `src/harness/memory/frontmatter.ts` and nothing else; it adds
no dependency, writes only under `os.tmpdir()`, prints the fidelity census and the
measured table, and never asserts §9's outcome (its only expectations are the §1/§2/§4
construction targets it checks against its own emitted bytes). It is not wired into
CI; the vitest guard for the behavior parts A and B landed is
`npx vitest run tests/harness/memory/frontmatter.test.ts
tests/harness/memory/tools-save.test.ts tests/harness/memory/gc.test.ts`.
