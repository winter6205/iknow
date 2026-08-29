# 0033. Auto-memory complete upgrade — CJK n-gram tokenize, dream merge path, default OFF

Date: 2026-08-28
Status: accepted

## Context

ADR-0031 shipped extract + four-state ingest + mechanical GC and deferred LLM offline merge so the first unattended write path could gather evidence. STATUS §2.5 then showed the four-state table is vacuous for CJK (ASCII-only tokenize → empty tokens → always ADD) and that serve's auto-memory hook is process-global (first root wins). This ADR discharges the merge deferral and locks the tokenize + wiring seams. It does not change ADR-0009 dual-channel trust, ADR-0010 ask opt-out, or ADR-0031's default-OFF extract flag.

## Decision

1. **Shared tokenize = existing ASCII tokens + CJK overlapping bigrams (no new dependency).** `scoreMemoryEntries` and ingest neighbor tokens use one rule. Latin/digit/`_` tokens stay `[^a-z0-9_]+` with length ≥ 2. Each maximal Han/Hiragana/Katakana/Hangul run emits overlapping bigrams; a run of length 1 emits that character. Empty token sets never count as a neighbor (no containment=1 UPDATE/NOOP). Rejected: jieba (native/dict lock-in); `Intl.Segmenter` as the v0 path (runtime coverage uneven).

2. **dream = second LLM write path, never inside GC.** `settings.memory.dream` is boolean-only, default OFF (absent / non-`true` = off). Dream trigger is **not** the extract N≥2 gate: both **24h since last success-or-skip** and **5 distinct sessions** (chat/TUI: one in-process conversation; serve: `conversation_id` first completed turn in the window) must hold. Gate state lives in `dream.json` under that `memoryDir` (no `dream-cursor.json` read or migrate). Never per-turn. Extract still requires a non-empty transcript; dream does not. Live entries &lt; 2: skip merge LLM and still advance the time gate. When extract runs in the same notify as a met dream gate: ingest → dream → mechanical GC. Persist: LLM may emit `replaces: [slug]`; that drives `SUPERSEDE` (not CONTRADICTION_FLOOR). Entries carry `source: dream`; tool_result channel only; no auto-promote. Failures are typed and swallowed at the host with `// EXIT: log-and-continue` (LLM failure does not advance the time gate; skip does).

3. **Hook presence = `autoExtract || dream`; `autoExtract === true` implies dream when the dual gate holds.** The hook is absent only when both flags are off. There is no product escape hatch “extract without dream”. Dream-only (`dream === true` and `autoExtract !== true`) remains allowed. SessionHub holds the hook per `workspaceRoot`. Chat and serve share one notify helper.

## Consequences

- (+) CJK facts can hit neighbors so UPDATE/SUPERSEDE/NOOP work; dream merge is greppable via `source: dream` and stays off the system channel.
- (+) GC remains model-free and reversible; the second LLM path is a separate flag with the same swallow-on-failure host contract as extract.
- (−) One extra LLM call when the dream dual gate trips. Accepted: 24h ∧ 5 sessions, off the user critical path, default OFF.
- (−) Bigrams are a heuristic, not a morphological analyzer. Accepted for v0; no jieba lock-in.

## Why not

- **Merge inside `memory_gc`:** GC is the reversible, model-free subtractor; stacking an unaccountable LLM there recreates the risk ADR-0031 deferred.
- **Default ON:** same accountability argument as ADR-0031 D5.
- **Reuse `source: auto` for dream writes:** would erase the bulk-revert handle that distinguishes extract vs merge; round-trip already allows unknown frontmatter keys.

## Evidence pointers

- `specs/auto-memory-complete-upgrade.md`
- `docs/adr/0031-auto-memory-extract-and-mechanical-gc.md` (merge deferral)
- `docs/STATUS.md` §2.5 (CJK tokenize; first-root hook; dual notify)
