# 0123. Use yaml and one shared frontmatter module for four readers

Date: 2026-09-23
Status: accepted

The repository has four hand-written frontmatter parsers (`skill/scanner.ts`, `skill/body.ts`, `subagent/user-catalog.ts`, and `memory/frontmatter.ts`). Each splits a YAML document into flat `key: value` lines. Issue #1128 demonstrated three valid YAML shapes that these parsers misread: a block sequence loses fields and raises a spurious warning; a block scalar loses its body; and a nested mapping **silently overwrites top-level `name` and `description`**. The last case corrupts data without a warning. A survey of 2,918 SKILL.md files found eight block-shaped documents. Narrow rules cover only the shapes found so far. Quoted strings with colons, `#` comments, and `|` or `>` chomping indicators would each create another format-chasing bug. That subset would be defined by past incidents rather than the YAML specification.

Decision: add `yaml` (zero dependencies, ISC; already present transitively through development dependencies, now promoted to its first production use). Create **one shared frontmatter module** with two APIs: a fence strip that never throws (the frontmatter fence strip contract in `docs/CONTEXT.md`) and a YAML parser with a scalar coercion boundary (the frontmatter coercion boundary in `docs/CONTEXT.md`). Migrate consumers in stages: (1) record the decision and add the shared module; (2) migrate skill scanner/body and close #1128; (3) migrate the subagent user catalog and the memory reader. The initial decision was to **keep memory serialization hand-written** because round-trip assertions and `computeSignature` pin the on-disk byte shape (unquoted values, fixed key order, and comma-flat lists), while `yaml.stringify` changes those bytes.

Why not the alternatives:

- Extend the flat subset (#1128 option 1, roughly 40 lines and three narrow rules): this avoids a dependency and limits the diff, but leaves format-chasing as a permanent maintenance cost. Rejected.
- Document the subset without changing code: this leaves the silent identity-field overwrite in place. Rejected.

Consequences:

- **Benefits:** YAML parsing handles the format shapes directly; four duplicate fence expressions become one; long scalar fields such as `when_to_use` can use the block-scalar form that authors commonly write.
- **Costs:** Skill frontmatter degradation changes from tolerant per-line parsing to **atomic block rejection** (invalid syntax drops the entire block, emits a warning, and falls back to the directory name). The assertions in `tests/skill/scanner.test.ts:143-196` change accordingly. The production lockfile gains one dependency. The build has no bundler (`tsc` writes `dist`, and Node resolves `node_modules` at runtime), so the web/Vite output is unaffected.

Gate check: ADR-0002 A8 permits the zero-new-dependency gate exemption through spec 224, registered in the style of `specs/251-lsp-tool.md:35`. The operator authorized the lockfile change in the 2026-09-22/23 sessions.

## Amendment (2026-09-23): serialize memory with `yaml.stringify`

The operator reversed the initial decision to keep memory serialization hand-written. This is a reader/writer consistency fix: after PR-③ moved the reader to real YAML, the product's own writer could emit bytes that its reader rejected. An unquoted plain scalar cannot contain `": "`, but `memory_save` passes model text directly into `title`. A normal title such as `Rule: …` therefore caused the entire frontmatter block to be dropped, returning both `title` and `id` as empty strings. The old per-line reader accepted the same bytes. Keeping the unquoted writer alongside the strict reader would create a routine corruption path, contrary to this ADR's purpose.

The landed writer was measured against 19 real files in `docs/evidence/frontmatter-serialize-migration.md` §9: 17 stay byte-identical, and two grow by 2 bytes at their next save (both first differ at byte offset 8, the two blank `id` values in §2). No fields are lost, and `computeSignature` is stable for all 19 files. The pinned shape remains: `KNOWN_FRONT_KEYS` first, sorted extras afterward, `body` outside frontmatter, comma-flat lists for the reader's coercion rule, and `lineWidth: -1` to prevent folding. The earlier §5 estimate of 14 unchanged and five rewritten files used the default line width of 80; disabling folding removes those three additional rewrites. The remaining divergence classes are blank `key: ` becoming `key: ""` and ambiguous scalars gaining quotes. Quoting makes the writer's output readable by its own reader. Round-trip assertions were updated to pin this form. The original reasoning above is preserved as the decision record at that time.

### Measured costs and accepted residuals

- **Cost:** Atomic block rejection affects more than skills. Of 15 real agent-role files loaded by the subagent user catalog, **two** have an unquoted `description:` containing `": "`. The shared parser rejects each block as a nested mapping, replaces its description with `User-defined subagent role '<id>'.`, and emits one warning. The old per-line parser kept those descriptions. This is an accepted authoring compatibility cost of preventing silent identity-field overwrites; see evidence §3.
- **Accepted residual:** The pure `serializeMemoryEntry` writer silently drops a non-scalar unknown extra field through its `isScalar` filter. This behavior existed at the base and remains here. Reporting it would require a warning channel on a function whose PR-0 contract keeps serialization pure. In the 19-file real corpus, every unknown extra is scalar (`source` in evidence §2).
- **Accepted residual:** The `rejected` signal from `parseFrontmatter` makes the memory reader throw a typed error for an unreadable block. The store places the file in `skipped`, while GC rewrites only `entries`, preserving the original bytes. The store has no warning outlet for this case, as with recall/promote's catch-and-skip path; discovering such a file currently requires inspecting it on disk.
