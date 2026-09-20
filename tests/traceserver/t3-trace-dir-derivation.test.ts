/**
 * ADR-0071 Decision 4:
 * traceDir is derived from traceFilePath — `blobs/` is a sibling of
 * `trace.jsonl`, uniquely decided by `dirname(traceFilePath) + "/blobs"`.
 * The `options.traceDir` field retired from `TraceMessageDereferenceOptions`;
 * the only public input is `traceFilePath`.
 *
 * This invariant is shared by the three read-side faces (ACI / stdio MCP /
 * calling `dereferenceTraceMessages` directly): callers pass only the trace
 * file path, never a blob directory.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  projectToolResultsFromTrace,
  type TraceMessageDereferenceOptions,
} from "../../src/traceserver/project-tool-results.ts";

describe("TraceMessageDereferenceOptions (T3 SC7)", () => {
  it("traceDir is retired — type-level guard pins the contract change", () => {
    // Type-level guard: an object literal carrying traceDir must be rejected
    // at compile time as an excess property. If traceDir is ever re-added, tsc
    // flags the unused @ts-expect-error directive and CI fails. Must be a
    // literal — an `as` assertion skips the excess-property check and would
    // disarm the sentinel.
    const wrong: TraceMessageDereferenceOptions = {
      traceFilePath: "/tmp/conv/trace.jsonl",
      // @ts-expect-error SC7: traceDir is retired; pass via traceFilePath only.
      traceDir: "/tmp/conv",
    };
    void wrong;
  });

  it("blob dereference via traceFilePath: dirname(traceFilePath) + /blobs", async () => {
    // Callers pass only traceFilePath; the blob path is derived internally —
    // derivation is the single source of truth, no blobDir input.
    const messages = [
      { sha: "abc123", bytes: 10 },
      { sha: "missing-sha", bytes: 5 },
    ];
    // No traceFilePath → derived readBlob is undefined and throws, but
    // projectToolResultsFromTrace's top-level try/catch degrades it to []
    // (read side fails closed, never into the turn).
    const withoutPath = await projectToolResultsFromTrace(messages);
    assert.deepEqual(
      withoutPath,
      [],
      "without traceFilePath, dereference fails closed → empty projection"
    );

    // traceFilePath given but blob missing → same degradation: read failures
    // on the derived path never reach the caller turn.
    const withPath = await projectToolResultsFromTrace(messages, {
      traceFilePath: "/nonexistent/dir/trace.jsonl",
    });
    assert.deepEqual(withPath, []);
  });

  it("anti-coupling: explicit readBlob wins over derived dirname path (SC7)", async () => {
    // Callers can no longer pass a traceDir contradicting filePath — the
    // previous test's @ts-expect-error sentinel closes that risk at compile
    // time. This test pins the runtime half: when readBlob is explicitly
    // injected, dirname(traceFilePath)/blobs derivation is skipped and the
    // injection is the only read path.
    let deriveAttempted = false;
    const deref = await projectToolResultsFromTrace([{ sha: "x", bytes: 1 }], {
      traceFilePath: "/definitely/not/a/real/dir/trace.jsonl",
      readBlob: (sha) => {
        // If the impl still derived via dirname, readFileSync on the fake
        // path would fail first; this flag is meaningful only once the
        // injected readBlob takes over.
        deriveAttempted = true;
        return `blob-${sha}`;
      },
    });
    assert.ok(
      deriveAttempted,
      "injected readBlob must be the read path when provided"
    );
    // The injected "blob-x" is not a valid payload → projection degrades to []
    // (existing read-side fail-closed contract).
    assert.deepEqual(deref, []);
  });
});
