# Subagent output handoff

This guide describes the current path from a worker's final answer to the parent model, the supported way to retrieve that answer, and the two optimization areas the implementation now covers. The follow-up plan is [Subagent output handoff optimization](../../plans/subagent-output-handoff.md): the retrieval-wording and long-text areas it tracks have landed in the current build, and its real-model evaluation has now run without demonstrating a measured gain over the retired wording — so nothing here claims an improvement.

## Current report lifecycle

1. The worker turns `RunResult.finalText` into both `summary` and `result` in its terminal envelope ([`toOkEnvelope`](../../src/harness/subagent/worker.ts)).
2. Before sending the envelope over stdout to the host, the worker calls `truncateEnvelopeResult`. When `result.length > 20000`, it folds the report to a parent-visible summary, paths, stop reason, and marker ([`TRUNCATION_LIMIT`](../../src/harness/subagent/envelope.ts), [`truncateEnvelopeResult`](../../src/harness/subagent/envelope.ts)). JavaScript `string.length` counts UTF-16 code units here.
3. When the result is non-empty and a pad is available, the host writes the report to the worker pad as `final.md`; `output_path` is the pad-relative name. This is best-effort bookkeeping, so a pad write failure does not fail the task ([`writeFinalTextToPad`](../../src/harness/subagent/manager.ts), [`locateEnvelope`](../../src/harness/subagent/manager.ts)). When the worker folded its report, it first sends the pre-fold body on a dedicated `final_text` frame line beside the envelope ([`FINAL_TEXT_FRAME_SCHEMA`](../../src/harness/subagent/envelope.ts)), and the host persists that body — so a folded report remains recoverable from the pad even though the IPC envelope itself stays folded. A report at or below the threshold needs no frame: its envelope `result` is already complete. A worker that sends no frame (older build) can only be persisted as received. All of this is subject to pad read limits.
4. `spawn_subagent(wait: true)` and `subagent_result` return a parent-visible short handoff. A `truncated` marker describes condensation of the report; it does not mean the worker task failed. Check `status` separately ([`spawn_subagent` description](../../src/harness/subagent/spawn-subagent-tool.ts), [`subagent_result`](../../src/harness/subagent/subagent-result-tool.ts), [`projectParentVisibleEnvelope`](../../src/harness/subagent/envelope.ts)).

The reviewed trace's four reports were about 2.1 KB each, well below the 20,000-code-unit worker fold threshold. That threshold therefore does not explain the trace's failed report reads.

## Read the saved report

When the short handoff is not enough, use the `task_id` returned by `spawn_subagent` and read the host-written report through `subagent_result`:

```json
{
  "task_id": "<task_id returned by spawn_subagent>",
  "tmp_path": "final.md"
}
```

This is supported after either `wait: false` or a `wait: true` completion. With only `task_id`, `subagent_result` lists pad names; adding the pad-relative `tmp_path` reads one file ([tool description and schema](../../src/harness/subagent/subagent-result-tool.ts), [`inspectWorkerPad`](../../src/harness/subagent/pad-inspect.ts)). The pad reader rejects absolute paths, `..`, symlink escapes, non-files, binary data, and files over 1 MiB. A read without `offset` returns the decorated first window — at most 200 lines with line-number prefixes — and reports `truncated: true` when the file is longer. A read with an integer `offset` returns the next bounded raw page ([`pageFromOffset`](../../src/harness/subagent/pad-inspect.ts)): the page ends at whichever bound trips first, the 200 complete lines or `PAD_PAGE_CODE_UNIT_BUDGET` (9,000 UTF-16 code units, sized so that the worst-case JSON escaping of the page body keeps the serialized result under the ADR-0006 executor cap), the cut is snapped back off a split surrogate pair, and the response carries `eof` plus `next_offset` to continue. Pages carry no line-number decoration, so passing each `next_offset` back as `offset` until `eof: true` reproduces the saved file exactly, including Unicode and line endings. An `offset` past the end of the file, or a negative or fractional one, is a typed reject rather than a silent clamp.

Do not copy a host `tmp_root` or absolute `output_path` into a workspace-fenced file tool. A rejection for a path outside the active workspace is expected containment behavior. `read_image` is for supported image bytes inside that fence, not Markdown reports ([`read_image` description](../../src/harness/aci/tools/read-image.ts)). The per-identity pad and parent retrieval channel are existing subagent behavior; ADR-0074's superseded notice changes the `/tmp` bind surface only, while ADR-0092 keeps the host-path session tmp model ([ADR-0074](../adr/0074-fence-tmp-backing.md), [ADR-0092](../adr/0092-fs-isolation-modes.md)).

## Evidence-backed optimization targets

### Make the retrieval instruction consistent

The `spawn_subagent` description now carries an actionable retrieval instruction in both its body and its `wait` field: when the short handoff is not enough, use `subagent_result` with the receipt's `task_id` and the pad-relative `tmp_path` taken from the receipt's `output_path` (`final.md` is the current pad name) to read the full worker report. The older wording — use `subagent_result` “only for an explicit status query” — conflicted with the `subagent_result` description, which allows re-checking after `wait: true` and reading one pad file with `tmp_path`; it has been retired from the spawn contract ([`spawn_subagent` description](../../src/harness/subagent/spawn-subagent-tool.ts), its `wait` field description, [`subagent_result` description](../../src/harness/subagent/subagent-result-tool.ts)). `tmp_root` stays in the frozen envelope for compatibility, labeled diagnostic metadata rather than a file-read target. The two descriptions now give the parent one consistent next action at the point it needs the full report.

### Preserve long final text before reducing the parent handoff

For output over 20,000 UTF-16 code units, the worker folds `result` before the host receives it. That fold no longer loses the report: the worker sends the pre-fold body on a `final_text` frame, and the host persists that body to the pad. The parent-visible handoff stays bounded, and its `truncated`/`totalLength` still describe the original text. Bounded paging is shipped on top of that: `subagent_result` takes an `offset` cursor and answers with `eof` and `next_offset`, so the parent can walk a saved report past the 200-line window until the pages reproduce the pad bytes ([`offset` schema field](../../src/harness/subagent/subagent-result-tool.ts), [`pageFromOffset`](../../src/harness/subagent/pad-inspect.ts)). The page budget keeps each serialized page under the executor's 20,000-unit cap, so this stays inside the existing dedicated worker report pad and `subagent_result` lifecycle: no generic executor-result offload and no change to the executor cap, which is what ADR-0006 requires ([`docs/CONTEXT.md`](../CONTEXT.md)). What the round has not settled is whether the aligned wording actually steers the model — that is the live A/B half below, not a code gap.

## Evaluation status

The prompt-development guide's subagent-persona row now names a built trajectory set ([roster entry](prompt-development.md#roster-which-surfaces-have-sets-which-are-registered-gaps)). The evaluated behavior: after receiving a short handoff, the parent should select `subagent_result` with `tmp_path: "final.md"` to read a text report, rather than use an image reader or an absolute-path file read. Both halves exist: the offline invariant half `tests/subagent/subagent-output-handoff.test.ts` locks the fixed inputs (`tests/subagent/subagent-output-handoff.fixtures.ts`) and the encoded retrieval contract against the committed production behavior, and the real-model A/B half `real-llm/subagent-output-handoff.test.ts` is registered in `TRACKED_INCLUDE` of `vitest.real-llm.config.ts`.

Static description/schema checks and deterministic pad/host tests verify the instruction and long-text preservation contract. They do not prove the model chooses the retrieval tool. Whether the aligned wording actually gains over the retired wording is decided by the paired live run — arm-A (old wording, derived from the live tool text through a test-time presentation seam, no production flag) against arm-B (committed wording), hard gates on tool results and pad bytes, counts fixed before examining any result — recorded with its per-trial captures in [the run digest](../evidence/subagent-output-handoff/digest.md); status as of the 2026-10-09 run: the three control cases passed on both arms (no tool-choice regression from the wording change), while `incident-4` and `paged-report` never produced their report premise and are RESIDUAL — retrieval not judged, **no demonstrated gain**, and separately **not a product defect**: the `output_path`-stamps-end-to-end contract is proven by the offline production-entry test `tests/subagent/worker-entry-output-path-stamping.test.ts`. Missing credentials are reported as Not run, never a pass, and an offline-only green does not count as the trajectory half.

## Related references

- [Subagent roles](../subagent-roles.md) explains role routing; this guide covers the parent-side result handoff.
- [ADR-0040](../adr/0040-subagent-identity-and-dispatch-gate.md) defines the parent/worker identity split used by `task_id`.
- [ADR-0074](../adr/0074-fence-tmp-backing.md) and [ADR-0092](../adr/0092-fs-isolation-modes.md) define the per-identity session tmp and its host-path behavior.
- [ADR-0006](../adr/0006-tool-output-capping-hard-truncate-20000.md) defines the generic executor tool-result cap.
