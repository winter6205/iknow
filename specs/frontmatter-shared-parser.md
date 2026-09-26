# Spec: frontmatter shared parser

## Objective

Replace the four hand-rolled `---` frontmatter parsers (skill scanner, skill body fence, subagent user-catalog, memory) with one shared module built on the `yaml` dependency (ADR-0123), ending the silent-corruption and format-chasing bug class (#1128 family); fix the latent memory write-side newline corruption (PR-0); and give the skill model index a second selection signal, `when_to_use` (PR-④). Users: authors of SKILL.md / user-agent / memory files (human and LLM), and the model-facing index that must never carry polluted identity fields.

## Boundaries

- **Does:**
  - PR-0: memory newline guard — `foldEntryLineBreaks` folds `\r?\n` in `title` and unknown extras to a single space, and is applied at both choke points: `sanitizeMemoryFile` on the read side and `writeMemoryEntryAtomic` on the write side (the single writer for save / ingest / gc); serialize stays pure; healthy on-disk files stay byte-identical. Delivered squashed into the PR-③ memory commit (`cc509233`), not as its own commit — the round ships as one PR with one commit per ticket, and PR-0 has no independent landing surface (the guard and the reader it protects moved together).
  - PR-①: shared frontmatter module at `src/harness/frontmatter/` with two APIs — (a) fence strip: content-independent, never throws, byte-identical slice (the frontmatter fence strip contract in CONTEXT); (b) parse: real YAML parse + scalar coercion boundary returning `Record<string, string>` + warnings, block-level syntax failure → empty map + warn, never throws upward (the frontmatter coercion boundary in CONTEXT). `yaml@^2.9.1` enters root `dependencies`. No consumer wired yet — repo-wide behavior unchanged.
  - PR-②: skill migration — `scanner.ts` parse and `body.ts` strip switch to the shared module; closes #1128 (block sequence, block scalar, nested-mapping guard); absorbs row 4 from branch `fix/skill-frontmatter-flow-lists` (`5eb0f8e5`, comma-fold for flow sequences — its delimiter is the coerce boundary's array rule); degradation semantics become block-atomic; `tests/skill/scanner.test.ts:143-196` rewritten around the surviving invariants (never silent, identity fields never polluted).
  - PR-③: subagent `user-catalog.ts` and memory `parseMemoryEntry` migrate to the shared parse; memory `serializeMemoryEntry` emits its frontmatter map through `yaml.stringify` (operator decision, ADR-0123 Amendment — the unquoted hand writer produced bytes the new reader rejected), with `KNOWN_FRONT_KEYS` order, extras sorted after, comma-flat `supersedes` and body-after-the-fence placement pinned, and `lineWidth: -1` so no value is folded; the evidence report (byte-diff sample over real memory files) quantified the switch.
  - PR-④: `when_to_use` — optional scalar field on `SkillFrontmatter`/`SkillEntry`/`SkillSummary`; own rendered line in the frozen table and delta rows; own 1536 truncation with warn; stripped together with description by index demotion; `docs/guides/skill-authoring.md` updated.
- **Confirms with human:**
  - Outward comment on issue #1128 (route re-decision + ADR-0123 link + row-4 absorption) — before PR-② lands; not sent without explicit authorization.
  - serialize→`yaml.stringify` landing decision — decided 2026-09-23 by the operator after the PR-③ evidence report: landed.
- **Out of this spec:**
  - `allowed-tools` and any list/map-consuming field (operator-ruled out; the coerce boundary folds arrays to strings, nothing enforces them).
  - Sub-agent startup preloading of SKILL bodies (no observed pain; `specs/skill-index-increment.md` deferral stands).
  - A one-time bulk rewrite of memory files already on disk — the writer change applies to every new save; existing files migrate on their next write (blast radius measured in the evidence report).
  - MCP tool-catalog increments and the rest of `skill-index-increment.md` scope.
  - `when_to_use` on the parent→worker skill index snapshot (`subagent/envelope.ts` `SkillIndexSnapshotEntry`, wire shape = name + description only). A spawned worker's `<available_skills>` therefore renders no `when_to_use` line even where the parent's frozen table does. Extending it means changing a frozen cross-process envelope shape (`WORKER_SCHEMA`) for a second selection signal whose value inside a short-lived worker is unmeasured — out of scope here, and PR-④'s "opening frozen table + delta rows" wording deliberately names the parent surfaces only.

## Success Criteria

- **SC1 (PR-0)** A memory entry whose `title` or extras contain `\n` serializes to a fence block that re-parses to the same logical entry (folded to space); a pre-existing healthy file's `serializeMemoryEntry` output is byte-identical before/after; `npm test` memory paths exit 0.
- **SC2 (PR-①)** Shared-module unit tests exit 0 covering: strip on no-fence / broken-fence / CRLF / invalid-YAML inputs never throws and slices byte-identically on healthy fences; parse maps the three #1128 shapes to correct scalar strings (block scalar → folded text; block sequence → comma-folded; nested mapping keys → skipped + warn, never registered top-level); invalid YAML block → empty map + warning. `git diff` shows zero wiring into consumers.
- **SC3 (PR-②)** With the shared module wired: the three #1128 shapes load correctly through `scanSkillDirs`; a syntactically invalid frontmatter yields all fields dropped + warn once + name fallback to directory basename + entry still indexed; description 1536 truncation + warn-once unchanged; `createSkillBody` output byte-identical to pre-migration on the fixture corpus (envelope + KV-cache prefix contract); rewritten scanner tests keep the two invariants and exit 0; the skill-index trajectory-set gap follows registration path 2 in `docs/guides/prompt-development.md` with STATIC + SEAM byte coverage; `npm test` + TUI pty smoke (skill slash load) pass.
- **SC4 (PR-③)** user-catalog: a block-scalar `description` and a YAML-list `disallowedTools` produce the same entries as today's single-line/comma forms; invalid `bashMode` warn semantics unchanged. Equivalence is claimed over those authored shapes only — over the 15 real installed role files it is _not_ byte-equivalent: 2 carry an unquoted `description:` containing `": "` and lose their description to block-atomic degradation (recorded in ADR-0123 and evidence §3). memory: existing on-disk shapes (empty `title:` → `""`, comma `supersedes`, unknown extras) parse identically through the shared module, and a file the previous writer produced keeps its `computeSignature`; `serializeMemoryEntry` now emits `yaml.stringify` output with key order, the comma-flat list and body placement pinned and no line folding, so its round-trip byte assertions are re-pinned to the quoted form (a `": "`-bearing title round-trips with its `id` intact, which the unquoted writer failed); a block the reader cannot parse throws, so a write-back consumer quarantines the file instead of overwriting it with defaults. Evidence report file delivered. `npm test` exit 0.
- **SC5 (PR-④)** A skill with `when_to_use` shows it as a separate line in the opening frozen table and in delta rows, truncated at 1536 independently; index demotion strips it together with description; `SkillSummary` carries it; a skill without the field renders byte-identical to pre-feature; authoring guide updated; the skill-index trajectory-set gap is registered under path 2 in `docs/guides/prompt-development.md` with STATIC + SEAM byte coverage; `npm test` exits 0.
- **SC6** `architecture-change-reviewer` 5-verdict block all yes (carried in `plans/frontmatter-shared-parser.md`); `specs/README.md` lists this spec; lockfile diff limited to `yaml` + integrity hashes.

## Open Questions

(none — assumption gate cleared 2026-09-23; the two outward/deferred choices live in Confirms with human)

## Inherits / Changes

Inherits (summarized from `docs/CONTEXT.md`):

- **frontmatter coercion boundary**: The shared parser converts scalar values to strings, joins scalar arrays with commas, and skips mappings with a warning; nested keys never silently overwrite top-level keys. Consumers receive only scalar values. ADR-0123.
- **frontmatter fence strip contract**: Fence removal is content-independent, never throws, and returns a byte-identical body slice even when the YAML is invalid. Skill body assembly, envelope reverse parsing, and KV-cache prefix stability depend on this. ADR-0123.
- **skill model index**: Skills with a description and without `disable-model-invocation` may enter `<available_skills>` (opening table or delta) and have their bodies injected through `skill()`. ADR-0098.
- **index demotion**: Under ADR-0046, when MCP and skill indexes exceed 10% of the context window, excess entries keep their names and lose descriptions.
- **skill index delta**: Before a model call, a hidden user message is appended with `<available_skills>` lines for skills not yet recorded in the session's index-entry history. ADR-0098.

Changes:

- ADR-0123 (accepted): `yaml` prod dependency exempt from the zero-new-dependency gate (registration lives in the ADR's Gate check, per the `specs/251-lsp-tool.md:35` precedent style; spec 224 text is not in the main tree); four hand-rolled parsers → one shared module; skill frontmatter degradation per-line → block-atomic; memory serialize migrated from the hand writer to `yaml.stringify` (ADR-0123 Amendment, 2026-09-23).
- New root dependency `yaml@^2.9.1` (lockfile change authorized via ADR-0123 Gate check).
- Test surface: `npm test` (vitest) + hooks `test:changed`; golden-set discipline per `docs/guides/prompt-development.md` for model-visible assembly (PR-②/PR-④); TUI acceptance per `.qoder/rules/test.md`.
