/**
 * One address rule for the session body pool (Plan C task 3, SC22).
 *
 * Three ref shapes reach the same physical `blobs/` pool: the whole-message
 * ref, the content-level ref, and a dispatch-evidence body. The address gate is
 * the only thing keeping a ref inside that pool, so it has to be *one* gate.
 * The whole-message path used to roll its own weaker one — it rejected `/` and
 * `\` and nothing else — so a bare `..` or `.` resolved outside `blobs/`
 * (`join` normalizes, and the session folder answers the result) and any
 * non-hex name was accepted as an address.
 *
 * Every case drives the production reader with the read side's own `readBlob`
 * port used as a *recorder*, never as a content source: an address that is
 * refused must never reach that port, which is what makes these gates pre-read
 * rather than "the read happened to fail anyway". The real-filesystem version
 * of the traversal case lives in `body-access.test.ts`; this file pins the rule
 * itself, on both ref shapes, symmetrically.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { TRACE_BODY_REPRESENTATION } from "../../src/shared/trace-body-contract.ts";
import {
  dereferenceDispatchEvidenceWithStatus,
  dereferenceTraceMessages,
} from "../../src/traceserver/project-tool-results.ts";

/** A body address the pool can hold: the writer's own filename shape. */
const VALID_SHA = "0123456789abcdef".repeat(4);
/** A raw native body's name, sitting in a sibling directory of the pool. */
const FOREIGN_SHA = "0123456789abcdef".repeat(3) + "abcd";
/** The representation a raw (non-trace-permitted) body would declare. */
const FOREIGN_REPRESENTATION = "raw-native-state";
const BYTES = 10;

/**
 * Addresses no `blobs/` directory can hold, each with why. The first two are
 * the hole the weak whole-message gate left: no separator needed to leave the
 * pool, and on a real session folder they resolve to something that answers.
 */
const UNREFUSABLE_ADDRESSES: ReadonlyArray<
  readonly [sha: string, why: string]
> = [
  ["..", "normalizes out of blobs/ to the session folder itself"],
  [".", "normalizes to the pool directory"],
  [
    `../code-snapshots/${FOREIGN_SHA}`,
    "a path to the raw native pool's sibling",
  ],
  [VALID_SHA.toUpperCase(), "uppercase is not the stored filename"],
  [VALID_SHA.slice(0, 32), "half the digest length"],
  [`${VALID_SHA}0`, "one character over the digest length"],
  ["not-a-body-address", "a free-form name the pool can never hold"],
];

/** A ref addressed at `sha`, in the shape named — the two coexisting shapes. */
type RefShape = "whole-message" | "content-level";

function messageRef(
  shape: RefShape,
  sha: string,
  representation?: unknown
): Record<string, unknown> {
  const ref: Record<string, unknown> = { sha, bytes: BYTES };
  if (representation !== undefined) ref["representation"] = representation;
  return shape === "whole-message" ? ref : { role: "user", content: ref };
}

const SHAPES: ReadonlyArray<RefShape> = ["whole-message", "content-level"];

/** The read side's own port, recording every address it is asked for. */
function recordingReader(requested: string[]): {
  readonly readBlob: (sha: string) => string;
} {
  return {
    readBlob: (sha: string): string => {
      requested.push(sha);
      return JSON.stringify({ kind: "str", v: "body bytes" });
    },
  };
}

function optionsFor(requested: string[]): {
  readonly traceFilePath: string;
  readonly readBlob: (sha: string) => string;
} {
  return {
    traceFilePath: "/nonexistent/session/trace.jsonl",
    ...recordingReader(requested),
  };
}

async function derefOne(
  shape: RefShape,
  sha: string,
  representation?: unknown
): Promise<{ requested: string[]; out: ReadonlyArray<unknown> }> {
  const requested: string[] = [];
  const out = await dereferenceTraceMessages(
    [messageRef(shape, sha, representation)],
    optionsFor(requested)
  );
  return { requested, out };
}

describe("body address gate — one rule for every ref shape", () => {
  for (const shape of SHAPES) {
    it(`refuses a ${shape} ref whose address the pool cannot hold, before any read`, async () => {
      for (const [sha, why] of UNREFUSABLE_ADDRESSES) {
        const { requested, out } = await derefOne(shape, sha);
        assert.deepEqual(
          out,
          [],
          `${shape} ref sha ${JSON.stringify(sha)} must not dereference: ${why}`
        );
        assert.deepEqual(
          requested,
          [],
          `${shape} ref sha ${JSON.stringify(sha)} reached the body read instead of being refused: ${why}`
        );
      }
    });
  }

  for (const shape of SHAPES) {
    it(`reads a valid untagged address on a ${shape} ref (back-compat)`, async () => {
      // The untagged shape is what the current writer emits for message
      // content and what every legacy fixture holds, so a legal address must
      // keep resolving without a representation tag.
      const { requested, out } = await derefOne(shape, VALID_SHA);
      assert.deepEqual(requested, [VALID_SHA]);
      assert.equal(out.length, 1);
      assert.ok(
        JSON.stringify(out[0]).includes("body bytes"),
        "the body behind a legal untagged address must come back"
      );
    });

    it(`reads a ${shape} ref that declares the trace-permitted representation`, async () => {
      const { requested, out } = await derefOne(
        shape,
        VALID_SHA,
        TRACE_BODY_REPRESENTATION
      );
      assert.deepEqual(requested, [VALID_SHA]);
      assert.ok(JSON.stringify(out[0]).includes("body bytes"));
    });

    it(`refuses a ${shape} ref declaring a foreign representation before any read`, async () => {
      // The address is legal, so the declared representation is the only thing
      // that can be refusing this body.
      const { requested, out } = await derefOne(
        shape,
        VALID_SHA,
        FOREIGN_REPRESENTATION
      );
      assert.deepEqual(out, []);
      assert.deepEqual(requested, []);
    });
  }

  it("applies the same gate to the dispatch-evidence body shape", async () => {
    // The third ref shape into the same pool. Its address rule is the shared
    // one, so a traversing address cannot arrive through the evidence arm.
    const requested: string[] = [];
    const evidence = UNREFUSABLE_ADDRESSES.map(([sha]) => ({
      invocationId: `inv-${sha}`,
      stream: false,
      messages: {
        sha,
        bytes: BYTES,
        representation: TRACE_BODY_REPRESENTATION,
      },
    }));
    const resolved = await dereferenceDispatchEvidenceWithStatus(
      evidence,
      optionsFor(requested)
    );
    assert.deepEqual(resolved.entries, []);
    assert.equal(resolved.evidenceGap, true);
    assert.deepEqual(requested, []);
  });
});
