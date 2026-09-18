# 0009. Memory-file layered injection — three layers, placement, timing, dual-channel recall, discipline

Date: 2026-08-05
Status: accepted

> **Amendment 2026-09-18**（ADR-0099）：Decision 1 的 auto memory 落点 **superseded** —— 项目记忆库 = `<dataDir 或 ~/.iknow>/projects/<slug>/memory/`（home 项目树，与会话叶子 / `tasks/` 同 slug）。用户层 `AGENTS.md` 仍 `~/.iknow/AGENTS.md`。
> **Decision 5 只**（auto-extraction 延期项）superseded by `0031-auto-memory-extract-and-mechanical-gc.md`。
> **Decision 3** 中「`system` 仅一句 existence pointer、nothing more」由 ADR-0034 放宽为：抽取开启且库非空时可追加 **memory_catalog** + 英文纪律句。
> **Decision 3** 中「跨 session 核实后可把 body 装进 system」由 ADR-0044 废止：任何 provenance 的记忆 body 都不得进 `system`；常驻说明书只在 `AGENTS.md`。
> D2 / D4 / D6 不受影响，仍为现行决策。D1 落点见 ADR-0099。

## Context

GH issue #121 (winter6205/iknow, `wayfinder:grilling`, child of map #114 ④ memory layer) — the design grilling for iknow's project memory-file layered injection. The destination: iknow harness gains persistent, layered context injection (user-level / project-level / auto memory) so knowledge survives across sessions without polluting the live conversation.

Current-state facts (verified in the grilling session): iknow's runtime has **no system-prompt assembly at all** — `buildMessageParams` (`anthropic-adapter.ts:558-585`) emits `{model, max_tokens, messages, tools?, ...}` with no `system` key; `messages` only ever carries `user`/`assistant`. `~/.iknow/` is already the session-pool root (`serve.ts:29-31`, `--data-dir` flag); `.iknow/permissions.toml` is already the project-local permission policy source (`project-settings.ts:226-287`). No `@import`, no instruction-file reading, no memory concept exists in runtime code. The session store (`SessionFileV1`, `schema.ts:16-29`) persists messages only, no system-prompt slot.

The ticket cites the training corpus ch05/ch06 (layered persistent context, injection timing, merge precedence CLI > enterprise > project > user > session, content discipline, auto memory, compression interaction) and `docs/harness-report/p06-memory.html` (upstream reference memory mapping) as references — consumed as prior art, not copied. A 2026 literature sweep (arXiv-only, operator-directed) contributed three theory-level constraints: (a) the lost-in-the-middle U-curve is an architectural property of causal transformers (arXiv 2603.10123), so placement alone cannot selectively hide content; (b) content-based trust labels and lineage are both malleable (arXiv 2606.24322) — labeling alone is not defense; (c) interference is mathematically unavoidable in any semantic memory system (arXiv 2603.27116) — the design goal is minimizing blast radius, not eliminating pollution. These redirect the design from placement-based to channel-based trust separation.

## Decision

Six decisions settled in the 2026-08-05 grilling session (Q1–Q6):

1. **Three-layer placement.** User-level = `~/.iknow/AGENTS.md`; project-level = `<cwd>/AGENTS.md`; auto memory = `~/.iknow/memory/<basename(cwd)>-<sha1(cwd)[:12]>/` (upstream-style namespace: user-level root, project-hash subdirectory). `AGENTS.md` is the cross-agent file convention (not iknow-proprietary); auto memory layout is `MEMORY.md` index + `<slug>.md` entries with YAML frontmatter (`id` / `type` / `importance` / `ttl_days` / `disabled` / `supersedes`).

2. **Injection timing = split-frequency.** Static layers (both `AGENTS.md` + their `rules/` dirs) load once at session start, cached in memory, refreshed on file mtime change. Auto memory is **never** loaded on a timer or per-turn by default — it is recalled on demand (Decision 3).

3. **Merge strategy = explicit precedence + dual-channel routing.** For hand-written content: project-level beats user-level, stated explicitly in the assembled prompt (ch05's `project > user` mapped to the memory-file domain; CLI/enterprise/session tiers out of scope). Auto memory takes a **separate, lower-trust channel**: it does NOT enter the `system` field by default. The model accesses it through the `memory_recall(query)` tool; results return as `tool_result` content — a low-trust data channel per instruction hierarchy (arXiv 2404.13208), so recalled memories carry no instruction authority. Only after crossing an explicit promote threshold (repeated recall across ≥2 sessions, explicit promotion) may an entry be assembled into a dedicated, capped `system` memory section. The `system` field carries a one-line existence pointer to the memory store. ADR-0034 additionally allows a capped live-entry catalog plus a fixed English disclaimer when extract is on — still not un-promoted bodies. Promoted bodies in `system` (`formatPromote`) also require `autoExtract === true` (`specs/auto-memory-layering.md`). **ADR-0044 withdraws that promote-in-system clause:** memory bodies never enter `system`; the ≥2-session gate remains for GC only.

4. **Content discipline.** No `@import` parsing — splitting is by directory convention: `<cwd>/.iknow/rules/*.md` (project) and `~/.iknow/rules/*.md` (user), globbed in filename order and appended after the main `AGENTS.md`. **Affirmative phrasing rule**: hard prohibitions belong in `.iknow/permissions.toml` (mechanical tool-layer enforcement, never entering model context); memory content is written affirmatively ("use bar() instead of foo() — foo() is not thread-safe"); negative-form memory is refused at write time (either upgraded to a permission-gate proposal or rewritten affirmatively). Rationale: negative rules in model context cause capability suppression and self-repeating refusal across turns (arXiv 2607.17619 shows stored preferences silently constraining future decisions), and are a persistent poisoning channel. Auto memory writes only broadly-applicable facts / gotchas / hard constraints — never per-task state (that belongs to session messages).

5. **Auto memory scope = explicit-write v0; auto-extraction deferred.** — _superseded by ADR-0031_（延期项已落地：host 侧 completed 闸后异步抽取 + 四态写入 + 机械 GC，默认 OFF；本条其余内容保留为历史记录）。The v0 surface is: the memory store (Decision 1 layout), `memory_recall` + `memory_save` tools, quarantine/promote grading. Writes are explicit only — the model calling `memory_save` or the user hand-editing files. Background LLM auto-extraction (per-turn memory proposal) is deferred to a later standalone module; vector-based recall may join in that same module (v0 recall = keyword BM25-lite heuristic scoring, no embeddings — consistent with the 023 vector-arm removal). Rationale: auto-extraction is the primary entry point for wrong memories (arXiv 2606.25161: consolidation errors become persistent system-state errors); deferring it keeps every v0 entry accountable.

6. **Budget interaction = static caps, no dedicated token accounting.** Static size caps: ≤12000 chars per `AGENTS.md`/rules file (aligned with the upstream reference's cap); ≤4000 chars total for the promoted-memory `system` section; recall tool results go through the existing executor output cap (contract X, `OUTPUT_HARD_CAP=20000`). Compression acts on `messages` history only, never on the `system` field (KV-cache prefix stability, map #114 standing preference). No independent memory token accounting — consistent with ADR-0008's ruling that compression's token path remains blocked by failure evidence.

## Consequences

- (+) `buildMessageParams` must gain a `system` field and an assembly point that reads the three layers — this is the one new runtime seam this decision creates (all additive).
- (+) Wrong-memory blast radius is bounded by channel separation: un-promoted memories can only enter as reviewable `tool_result` data, never as instruction-authority prompt content.
- (+) Hard prohibitions enforced mechanically (`permissions.toml`) cannot be talked away, re-litigated per turn, or poisoned through memory injection.
- (+) Cross-agent portability: `AGENTS.md` follows the ecosystem convention; another agent reading the same repo finds the same project instructions.
- (−) No auto-accumulation in v0 — the memory store only grows through deliberate saves. Accepted: the auto-extraction module is deferred, not dropped, and will carry the vector seam with it.
- (−) Keyword-only recall (no semantic search) in v0; semantically-similar-but-differently-worded queries miss. Accepted for v0; the vector upgrade seam is reserved at the recall interface.
- (−) Caps are static heuristics, not budget-aware. Accepted per ADR-0008 — budget-aware behavior waits for failure evidence.
- Reversibility: placement/channel decisions are cheap to adjust while no code depends on them; once `buildMessageParams` carries the assembled `system` field and sessions persist around it, the layer layout hardens. 回退 = drop the assembly point and the memory tools; the store files on disk remain inert.

**Why not alternatives:**

- _Placement-based trust (low-trust memory placed in mid-context to be ignored)_: the U-curve is non-selective — middle placement weakens everything, including legitimate instructions; position is not a filter (arXiv 2603.10123). Rejected.
- _Auto memory always in the `system` tail with soft labels_: labels alone are malleable (arXiv 2606.24322), and per-turn presence guarantees re-repetition of constraints. Rejected.
- _`@import` syntax_: Claude-Code-specific, parser + path-traversal surface, covered by the `rules/` directory convention. Rejected.
- _Subdirectory-recursive AGENTS.md splitting (the AGENTS.md standard's own mechanism)_: viable for monorepos, but iknow's single-repo needs flat splitting now; `rules/` matches the tool-directory majority pattern. Revisit if monorepo layout arrives.
- _Auto-extraction in v0_: unaccountable write path into persistent state; deferred with a dedicated module (Q5). Rejected for v0.
- _Independent memory token budget_: no runtime token accounting exists yet (ADR-0008); building budget-awareness with no anchor is dead machinery. Rejected.

## Evidence pointers

- GH issue #121 (winter6205/iknow) — the 6-question grilling; this ADR is its design-truth landing. Resolution comment carries the per-question record.
- GH issue #114 — parent map ④ memory layer; Decisions-so-far index updated there.
- GH issue #160 / `docs/adr/0008-token-accounting-usage-placement.md` — the token-accounting deferral that shapes Decision 6.
- `docs/harness-report/p06-memory.html` — upstream reference memory-layer mapping (prior art consumed, not copied; namespace style, BM25-lite recall, 12000-char cap all trace here).
- 2026 literature sweep (operator-directed, arXiv-only): arXiv 2603.10123 (position bias architectural), arXiv 2606.24322 (malleable trust signals), arXiv 2603.27116 (unavoidable interference), arXiv 2606.25161 (consolidation errors persist), arXiv 2607.17619 (stored preferences silently constrain), arXiv 2606.06054 / 2607.24117 / 2608.02113 (retrieval-as-trust-boundary, quarantine routing, decision-time arbitration).
- `src/harness/aci-executor.ts` / contract X (`OUTPUT_HARD_CAP=20000`) — the recall-output cap reuse.
- `.iknow/permissions.toml` + `src/harness/project-settings.ts:226-287` — the mechanical-enforcement home for hard prohibitions.
