/**
 * Evidence completeness: tally port, explicit failure states, and the hash index.
 *
 * Why this matters (issue 1219 requirement 4, required regressions 7, 8, 10):
 *  - `tally.py` verified every `{sha,bytes}` reference against disk (its best property,
 *    kept here) but reported numbers with no notion of FAILURE: a parse failure, a missing
 *    blob or a broken reference all rolled into counts that a reader could mistake for
 *    completeness. Every one of them is an explicit evidence failure here.
 *  - Task/grader outcome must stay SEPARATE from `evidence_status`: reward=1 with zero
 *    retained evidence is a real failure, not a success.
 *  - "Zero broken references proves integrity of retained references, not absence of lost
 *    whole records" — so the assessment reports coverage, not just integrity.
 *  - The hash index must exclude itself and temp index files from its payload list,
 *    finalize payloads before publication, and be written atomically.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

import {
  assessEvidence,
  buildHashIndex,
  TALLY_SCHEMA_VERSION,
  tallyAttempt,
  verifyHashIndex,
  writeHashIndex,
} from "../../../../scripts/eval/terminal-bench-2.1/evidence.ts";
import {
  cleanupTempRoots,
  makeAttemptDir,
  PASSING_GRADER_LOG,
  tempRoot,
  writeBlob,
  writeRawTrace,
  writeTrace,
} from "./fixtures.ts";

afterAll(cleanupTempRoots);

const HASH_INDEX_NAME = "hash-index.json";

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

describe("tally of retained trace artifacts", () => {
  it("counts all four token counters, cache reads included", () => {
    const root = tempRoot("evidence-tokens");
    const dir = makeAttemptDir(root);
    writeTrace(dir, "session.jsonl", [
      {
        recordType: "llm_call",
        inputTokens: 15645,
        outputTokens: 2100,
        cacheCreationInputTokens: 300,
        cacheReadInputTokens: 179410,
        llmCallId: "llm-1",
        status: "ok",
      },
    ]);

    const tally = tallyAttempt(dir);

    assert.equal(
      tally.tokens.input_tokens,
      15645,
      "input tokens must be tallied"
    );
    assert.equal(
      tally.tokens.cache_read_input_tokens,
      179410,
      "cache reads must be surfaced"
    );
    assert.equal(
      tally.schema_version,
      TALLY_SCHEMA_VERSION,
      "the tally must declare its schema"
    );
  });

  it("counts llm calls, dispatch evidence and turn references separately", () => {
    const root = tempRoot("evidence-llm");
    const dir = makeAttemptDir(root);
    writeTrace(dir, "session.jsonl", [
      { recordType: "llm_call", llmCallId: "llm-1", status: "ok" },
      { recordType: "llm_call", llmCallId: "llm-2", status: "error" },
      { recordType: "llm_call", llmCallId: "llm-3", status: "ok" },
      { recordType: "turn", llmCallId: "llm-1" },
    ]);

    const tally = tallyAttempt(dir);

    assert.equal(
      tally.llm_calls.total,
      3,
      "every llm_call record must be counted"
    );
    assert.equal(
      tally.llm_calls.status_ok,
      2,
      "status histogram must separate ok from error"
    );
    assert.equal(
      tally.llm_calls.referenced_by_a_turn,
      1,
      "only llm-1 is referenced by a turn"
    );
    assert.equal(
      tally.llm_calls.without_dispatch_evidence,
      3,
      "llm calls without dispatch evidence must be reported, not hidden"
    );
  });

  it("counts tool calls and their result capture", () => {
    const root = tempRoot("evidence-tools");
    const dir = makeAttemptDir(root);
    writeTrace(dir, "session.jsonl", [
      {
        recordType: "tool_call",
        toolCallId: "tool-1",
        status: "ok",
        resultCaptured: true,
      },
      {
        recordType: "tool_call",
        toolCallId: "tool-2",
        status: "error",
        resultCaptured: false,
      },
    ]);

    const tally = tallyAttempt(dir);

    assert.equal(tally.tool_calls.total, 2, "both tool calls must be counted");
    assert.equal(
      tally.tool_calls.result_captured_true,
      1,
      "result capture must be counted"
    );
    assert.deepEqual(
      tally.tool_calls.status_histogram,
      { ok: 1, error: 1 },
      "the status histogram must be derived from the traces"
    );
  });

  it("resolves every blob reference by BOTH sha256 and byte length", () => {
    const root = tempRoot("evidence-refs");
    const dir = makeAttemptDir(root);
    const body = "assistant message body";
    writeBlob(dir, body, sha256(body));
    writeTrace(dir, "session.jsonl", [
      {
        recordType: "session",
        refs: [{ sha: sha256(body), bytes: body.length }],
      },
    ]);

    const tally = tallyAttempt(dir);

    assert.equal(
      tally.evidence.resolved_sha_and_bytes,
      1,
      "the matching blob must resolve"
    );
    assert.equal(tally.evidence.broken, 0, "nothing is broken in this fixture");
    assert.equal(
      tally.evidence.missing_on_disk,
      0,
      "nothing is missing in this fixture"
    );
  });

  it("reports a reference whose byte length disagrees as broken, not as resolved", () => {
    const root = tempRoot("evidence-broken-len");
    const dir = makeAttemptDir(root);
    const body = "0123456789";
    writeBlob(dir, body, sha256(body));
    writeTrace(dir, "session.jsonl", [
      {
        recordType: "session",
        refs: [{ sha: sha256(body), bytes: body.length + 7 }],
      },
    ]);

    const tally = tallyAttempt(dir);

    assert.equal(
      tally.evidence.broken,
      1,
      "a length mismatch is a broken reference"
    );
    assert.equal(
      tally.evidence.resolved_sha_and_bytes,
      0,
      "it must not also count as resolved"
    );
  });

  it("reports a present blob whose content does not hash to its name as broken", () => {
    const root = tempRoot("evidence-broken-sha");
    const dir = makeAttemptDir(root);
    const claimed = sha256("original");
    writeBlob(dir, "tampered", claimed);
    writeTrace(dir, "session.jsonl", [
      { recordType: "session", refs: [{ sha: claimed, bytes: 8 }] },
    ]);

    const tally = tallyAttempt(dir);

    assert.equal(
      tally.evidence.broken,
      1,
      "content that does not match its sha is broken"
    );
    assert.equal(
      tally.evidence.missing_on_disk,
      0,
      "a present-but-tampered blob is not missing"
    );
  });

  it("separates a missing reference from a broken one", () => {
    const root = tempRoot("evidence-missing");
    const dir = makeAttemptDir(root);
    writeTrace(dir, "session.jsonl", [
      { recordType: "session", refs: [{ sha: "0".repeat(64), bytes: 10 }] },
    ]);

    const tally = tallyAttempt(dir);

    assert.equal(
      tally.evidence.missing_on_disk,
      1,
      "an absent blob must be reported as missing"
    );
    assert.equal(
      tally.evidence.broken,
      0,
      "a missing blob is not a broken one"
    );
    assert.equal(
      tally.evidence.missing_sample.length,
      1,
      "a missing sample must be retained"
    );
  });

  it("counts orphan blobs on disk that no record references", () => {
    const root = tempRoot("evidence-orphans");
    const dir = makeAttemptDir(root);
    writeBlob(dir, "unreferenced", sha256("unreferenced"));
    writeTrace(dir, "session.jsonl", [{ recordType: "session", refs: [] }]);

    const tally = tallyAttempt(dir);

    assert.equal(tally.evidence.blobs_on_disk, 1, "the blob exists on disk");
    assert.equal(
      tally.evidence.orphan_blobs,
      1,
      "an unreferenced blob is an orphan"
    );
  });

  it("reports parse failures instead of silently dropping unparseable lines (required test 8)", () => {
    const root = tempRoot("evidence-parse");
    const dir = makeAttemptDir(root);
    writeRawTrace(
      dir,
      "session.jsonl",
      '{"record_type":"session"}\n{"record_type":\n'
    );

    const tally = tallyAttempt(dir);

    assert.equal(
      tally.parse_failures,
      1,
      "the torn line must be counted, not dropped silently"
    );
    assert.equal(
      tally.trace_files,
      1,
      "the partially written trace file still exists"
    );
    assert.deepEqual(
      tally.record_census,
      { session: 1 },
      "only the parseable record contributes to the census"
    );
  });

  it("reports zero trace files for an attempt that retained none", () => {
    const root = tempRoot("evidence-empty");
    const dir = makeAttemptDir(root);

    const tally = tallyAttempt(dir);

    assert.equal(
      tally.trace_files,
      0,
      "an attempt with no trace files must say zero"
    );
    assert.deepEqual(
      tally.record_census,
      {},
      "an empty trace set has an empty census"
    );
  });
});

describe("evidence assessment (required test 7)", () => {
  it("reports a tally subprocess failure as an explicit evidence failure", () => {
    const assessment = assessEvidence(
      { kind: "tally-failed", message: "exit 1" },
      {
        reward: "1",
        graderExit: 0,
        expectedTraces: 1,
      }
    );

    assert.equal(
      assessment.status,
      "failed",
      "a tally failure is never a clean completeness claim"
    );
    assert.ok(
      assessment.failures.some((failure) => failure.code === "tally-failed"),
      `expected a tally-failed failure; got: ${JSON.stringify(assessment.failures)}`
    );
  });

  it("reports zero expected traces as an explicit failure even when the tally succeeded", () => {
    const root = tempRoot("evidence-zero-traces");
    const dir = makeAttemptDir(root);

    const assessment = assessEvidence(
      { kind: "tally", tally: tallyAttempt(dir) },
      {
        reward: "1",
        graderExit: 0,
        expectedTraces: 3,
      }
    );

    assert.equal(
      assessment.status,
      "failed",
      "fewer traces than expected is a failure"
    );
    assert.ok(
      assessment.failures.some((failure) => failure.code === "zero-traces"),
      `expected a zero-traces failure; got: ${JSON.stringify(assessment.failures)}`
    );
  });

  it("reports a parse failure as an explicit evidence failure", () => {
    const root = tempRoot("evidence-parse-fail");
    const dir = makeAttemptDir(root);
    writeRawTrace(dir, "session.jsonl", "{ broken\n");

    const assessment = assessEvidence(
      { kind: "tally", tally: tallyAttempt(dir) },
      {
        reward: "1",
        graderExit: 0,
        expectedTraces: 1,
      }
    );

    assert.ok(
      assessment.failures.some((failure) => failure.code === "parse-failure"),
      `expected a parse-failure failure; got: ${JSON.stringify(assessment.failures)}`
    );
  });

  it("reports a missing blob as an explicit evidence failure", () => {
    const root = tempRoot("evidence-missing-blob");
    const dir = makeAttemptDir(root);
    writeTrace(dir, "session.jsonl", [
      { recordType: "session", refs: [{ sha: "1".repeat(64), bytes: 4 }] },
    ]);

    const assessment = assessEvidence(
      { kind: "tally", tally: tallyAttempt(dir) },
      {
        reward: "1",
        graderExit: 0,
        expectedTraces: 1,
      }
    );

    assert.ok(
      assessment.failures.some((failure) => failure.code === "missing-blob"),
      `expected a missing-blob failure; got: ${JSON.stringify(assessment.failures)}`
    );
  });

  it("reports a broken reference as an explicit evidence failure", () => {
    const root = tempRoot("evidence-broken-ref");
    const dir = makeAttemptDir(root);
    const body = "abc";
    writeBlob(dir, body, sha256(body));
    writeTrace(dir, "session.jsonl", [
      { recordType: "session", refs: [{ sha: sha256(body), bytes: 999 }] },
    ]);

    const assessment = assessEvidence(
      { kind: "tally", tally: tallyAttempt(dir) },
      {
        reward: "1",
        graderExit: 0,
        expectedTraces: 1,
      }
    );

    assert.ok(
      assessment.failures.some(
        (failure) => failure.code === "broken-reference"
      ),
      `expected a broken-reference failure; got: ${JSON.stringify(assessment.failures)}`
    );
  });

  it("keeps the task outcome separate from the evidence status", () => {
    const root = tempRoot("evidence-outcome-split");
    const dir = makeAttemptDir(root, {
      reward: "1",
      ctrfBytes: 2878,
      graderLog: PASSING_GRADER_LOG,
    });
    writeTrace(dir, "session.jsonl", [
      { recordType: "session", refs: [{ sha: "2".repeat(64), bytes: 4 }] },
    ]);

    const assessment = assessEvidence(
      { kind: "tally", tally: tallyAttempt(dir) },
      {
        reward: "1",
        graderExit: 0,
        expectedTraces: 1,
      }
    );

    assert.equal(
      assessment.status,
      "failed",
      "missing evidence makes the evidence status fail"
    );
    assert.equal(
      assessment.outcome.reward,
      "1",
      "the task outcome is retained independently of the evidence failure"
    );
    assert.equal(
      assessment.outcome.graderExit,
      0,
      "the grader exit status is also retained"
    );
  });

  it("states that zero broken references proves integrity, not completeness", () => {
    const root = tempRoot("evidence-integrity");
    const dir = makeAttemptDir(root);
    writeTrace(dir, "session.jsonl", [{ recordType: "session", refs: [] }]);

    const assessment = assessEvidence(
      { kind: "tally", tally: tallyAttempt(dir) },
      {
        reward: "1",
        graderExit: 0,
        expectedTraces: 1,
      }
    );

    assert.equal(
      assessment.integrityOnlyNote.includes("whole records"),
      true,
      `the integrity-vs-completeness caveat must be stated; got: ${JSON.stringify(assessment.integrityOnlyNote)}`
    );
  });

  it("passes only when every expected trace, every reference and every parse succeeded", () => {
    const root = tempRoot("evidence-clean");
    const dir = makeAttemptDir(root);
    const body = "ok";
    writeBlob(dir, body, sha256(body));
    writeTrace(dir, "session.jsonl", [
      {
        recordType: "session",
        refs: [{ sha: sha256(body), bytes: body.length }],
      },
    ]);

    const assessment = assessEvidence(
      { kind: "tally", tally: tallyAttempt(dir) },
      {
        reward: "1",
        graderExit: 0,
        expectedTraces: 1,
      }
    );

    assert.equal(
      assessment.status,
      "complete",
      `expected complete; failures: ${JSON.stringify(assessment.failures)}`
    );
    assert.deepEqual(
      assessment.failures,
      [],
      "a clean assessment carries no failures"
    );
  });

  it("refuses an unknown expected-trace count rather than assuming zero", () => {
    const root = tempRoot("evidence-unknown-expected");
    const dir = makeAttemptDir(root);
    writeTrace(dir, "session.jsonl", [{ recordType: "session" }]);

    const assessment = assessEvidence(
      { kind: "tally", tally: tallyAttempt(dir) },
      {
        reward: "1",
        graderExit: 0,
        expectedTraces: null,
      }
    );

    assert.equal(
      assessment.status,
      "failed",
      "an unknown expectation cannot read as complete"
    );
    assert.ok(
      assessment.failures.some(
        (failure) => failure.code === "unknown-expectation"
      ),
      `expected an unknown-expectation failure; got: ${JSON.stringify(assessment.failures)}`
    );
  });
});

describe("hash index (required test 10)", () => {
  it("excludes the index itself from its payload list", () => {
    const root = tempRoot("hash-index-self");
    writeFileSync(join(root, "reward.txt"), "1");
    writeFileSync(join(root, HASH_INDEX_NAME), '{"stale":true}');

    const index = buildHashIndex(root);

    assert.deepEqual(
      index.payloads.map((payload) => payload.path),
      ["reward.txt"],
      `the index must exclude itself; got: ${JSON.stringify(index.payloads.map((p) => p.path))}`
    );
  });

  it("excludes temporary index files from its payload list", () => {
    const root = tempRoot("hash-index-temp");
    writeFileSync(join(root, "reward.txt"), "1");
    writeFileSync(join(root, `${HASH_INDEX_NAME}.tmp`), "partial");

    const index = buildHashIndex(root);

    assert.deepEqual(
      index.payloads.map((payload) => payload.path),
      ["reward.txt"],
      `temp index files must be excluded; got: ${JSON.stringify(index.payloads.map((p) => p.path))}`
    );
  });

  it("records the sha256 and byte length of every payload", () => {
    const root = tempRoot("hash-index-payloads");
    const body = "reward body";
    writeFileSync(join(root, "reward.txt"), body);

    const index = buildHashIndex(root);

    assert.equal(
      index.payloads[0]?.sha256,
      sha256(body),
      "the digest must be recomputed, not asserted"
    );
    assert.equal(
      index.payloads[0]?.bytes,
      body.length,
      "the byte length must be recorded"
    );
  });

  it("writes the index atomically, leaving no temp file behind", () => {
    const root = tempRoot("hash-index-atomic");
    writeFileSync(join(root, "reward.txt"), "1");

    const indexPath = writeHashIndex(root);

    assert.deepEqual(
      readdirSync(root).filter((name) => name.includes(".tmp")),
      [],
      "no temp index file may survive publication"
    );
    assert.equal(
      JSON.parse(readFileSync(indexPath, "utf8")).indexVersion,
      1,
      "the published index must be readable and complete"
    );
  });

  it("verifies digest and size on readback", () => {
    const root = tempRoot("hash-index-verify");
    writeFileSync(join(root, "reward.txt"), "1");
    const indexPath = writeHashIndex(root);

    const verification = verifyHashIndex(indexPath);

    assert.equal(
      verification.ok,
      true,
      `expected a clean readback; got: ${JSON.stringify(verification.mismatches)}`
    );
    assert.equal(
      verification.checked,
      1,
      "the single payload must have been verified"
    );
    assert.deepEqual(
      verification.mismatches,
      [],
      "a clean readback has no mismatches"
    );
  });

  it("detects a payload mutated after the index was written", () => {
    const root = tempRoot("hash-index-mutated");
    writeFileSync(join(root, "reward.txt"), "1");
    const indexPath = writeHashIndex(root);
    writeFileSync(join(root, "reward.txt"), "2");

    const verification = verifyHashIndex(indexPath);

    assert.equal(
      verification.ok,
      false,
      "a mutated payload must fail readback"
    );
    assert.deepEqual(
      verification.mismatches.map((mismatch) => mismatch.path),
      ["reward.txt"],
      `the mutated payload must be named; got: ${JSON.stringify(verification.mismatches)}`
    );
  });

  it("detects a payload deleted after the index was written", () => {
    const root = tempRoot("hash-index-deleted");
    writeFileSync(join(root, "reward.txt"), "1");
    const indexPath = writeHashIndex(root);
    writeFileSync(join(root, "reward.txt"), "");

    const verification = verifyHashIndex(indexPath);

    assert.equal(verification.ok, false, "a size change must fail readback");
    assert.equal(
      verification.mismatches[0]?.problem,
      "size",
      "the size mismatch must be named"
    );
  });
});
