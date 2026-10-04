/**
 * The trace reader's reference-access contract (Plan C task 3, SC22).
 *
 * The immutable body pool is session-local and physically shared: raw native
 * recovery state and masked trace bodies can answer under the same session
 * folder. "A file is there" is therefore not authority to read it — the spec
 * forbids a trace reader from exposing native recovery bodies or enumerating
 * the pool merely because it is shared. What the reader may follow is a
 * reference that both *addresses* a body (its `sha` is a lowercase 64-hex
 * digest, so no `sha` can walk out of `blobs/`) and *claims* the trace
 * representation.
 *
 * Three boundaries are held here:
 *   1. Address gate — every ref shape's `sha` passes the same body-address
 *      gate before any read happens, so a traversing or non-hex sha is
 *      refused, not followed. The whole-message path used to judge only `/` and
 *      `\`; it is on the same rule now, with the before/after pinned in
 *      `body-address-gate.test.ts`.
 *   2. Representation authority — a ref that declares a `representation` must
 *      name a trace-permitted one, while the untagged historical shape (what
 *      the current writer emits, what every legacy fixture holds) keeps
 *      working: dual acceptance, not a migration.
 *   3. Honest incompleteness — a refused or unreadable body still fails closed
 *      to `parts: []`, and now also reports the evidence gap, so "the bodies
 *      are not here" stops being indistinguishable from "this record has no
 *      content".
 *
 * Real temp directories, real files, real file copies, production reader
 * throughout; nothing here mocks the unit under test.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import { writeTraceBody } from "../../src/harness/trace/trace-body.ts";
import {
  createGetRecordCore,
  type GetRecordCoreHandler,
} from "../../src/traceserver/get-record-core.ts";
import { dereferenceTraceMessages } from "../../src/traceserver/project-tool-results.ts";

/** All sessions sit at `<traceDir>/projects/<slug>/<convId>/trace.jsonl`. */
const TEST_PROJECT_SLUG = "test-project-body-access";
/** Stands in for raw native recovery state; must never surface through a trace. */
const RAW_SECRET = "RAW-NATIVE-CHECKPOINT-SECRET";
/** The representation a foreign body would carry; not a trace-permitted one. */
const FOREIGN_REPRESENTATION = "raw-native-state";
const HEX = "0123456789abcdef".repeat(4);

const traceDirs: string[] = [];

afterEach(() => {
  for (const traceDir of traceDirs.splice(0)) {
    rmSync(traceDir, { recursive: true, force: true });
  }
});

function makeTraceDir(): string {
  const traceDir = mkdtempSync(join(tmpdir(), "iknow-body-access-"));
  traceDirs.push(traceDir);
  return traceDir;
}

function sessionDir(traceDir: string, conversationId: string): string {
  return join(traceDir, "projects", TEST_PROJECT_SLUG, conversationId);
}

function writeSession(
  traceDir: string,
  conversationId: string,
  messages: ReadonlyArray<unknown>
): void {
  const dir = sessionDir(traceDir, conversationId);
  mkdirSync(dir, { recursive: true });
  const row = {
    record_type: "llm_call",
    conversation_id: conversationId,
    llm_call_id: "llm-1",
    turn_id: "turn-1",
    started_at: "2026-01-01T00:00:01.000Z",
    messages,
  };
  writeFileSync(join(dir, "trace.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
}

/** The writer's layout: bodies sit at `blobs/<sha>` next to `trace.jsonl`. */
function bodyPath(
  traceDir: string,
  conversationId: string,
  sha: string
): string {
  const blobs = join(sessionDir(traceDir, conversationId), "blobs");
  mkdirSync(blobs, { recursive: true });
  return join(blobs, sha);
}

/** The writer's `toBlobReferences` shape: sha256 over the serialized body, stored at `blobs/<sha>`. */
function writeBody(
  traceDir: string,
  conversationId: string,
  stored: unknown
): { sha: string; bytes: number } {
  const serialized = JSON.stringify(stored);
  const sha = createHash("sha256").update(serialized, "utf8").digest("hex");
  writeFileSync(bodyPath(traceDir, conversationId, sha), serialized, "utf8");
  return { sha, bytes: Buffer.byteLength(serialized, "utf8") };
}

/** A raw native body written where a traversing ref resolves to it. */
function writeRawBodyOutsideBlobs(
  traceDir: string,
  conversationId: string
): { sha: string; bytes: number } {
  const serialized = JSON.stringify({ kind: "str", v: RAW_SECRET });
  const dir = join(sessionDir(traceDir, conversationId), "code-snapshots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, HEX), serialized, "utf8");
  return {
    sha: `../code-snapshots/${HEX}`,
    bytes: Buffer.byteLength(serialized),
  };
}

function coreFor(
  traceDir: string,
  conversationId: string,
  messages: ReadonlyArray<unknown>
): GetRecordCoreHandler {
  writeSession(traceDir, conversationId, messages);
  return createGetRecordCore({ traceDir });
}

function inventory(
  core: GetRecordCoreHandler,
  conversationId: string
): Promise<Record<string, unknown>> {
  return core({
    conversation_id: conversationId,
    record_id: "llm-1",
    detail: "messages",
  }).then((raw) => JSON.parse(raw) as Record<string, unknown>);
}

/** The window arm on the record's first part; a window must fit inside its part. */
function readPart(
  core: GetRecordCoreHandler,
  conversationId: string,
  count: number
): Promise<Record<string, unknown>> {
  return core({
    conversation_id: conversationId,
    record_id: "llm-1",
    detail: "messages",
    message_index: 0,
    part_index: 0,
    count,
  }).then((raw) => JSON.parse(raw) as Record<string, unknown>);
}

function textBlock(text: string): Record<string, unknown> {
  return { type: "text", text };
}

/** A ref the read side must accept, built by the harness's own body writer. */
function writeTraceBodyRef(
  traceDir: string,
  conversationId: string,
  value: unknown
): { sha: string; bytes: number; representation: string } {
  // Identity mask: this case is about which reference the reader may follow,
  // not about redaction (the writer's own suite covers masking). The boundary
  // crossing is legal in a test and forbidden in `src/traceserver/`, so the
  // reader's own copy of the tag and address rule is pinned here instead.
  const ref = writeTraceBody(
    sessionDir(traceDir, conversationId),
    value,
    (t) => t
  );
  return { ...ref, representation: String(ref.representation) };
}

describe("trace reference access — address gate", () => {
  it("refuses a content ref whose sha walks out of blobs/ instead of reading it", async () => {
    // The escape this closes: `readBlobPayload` resolves
    // `join(dirname(traceFilePath), "blobs", sha)`, and `join` normalizes, so
    // `../code-snapshots/<hex>` resolves to a real sibling file. The raw body
    // below is written at exactly that resolved location, so a reader that
    // followed the ref would return native recovery state as trace evidence.
    const traceDir = makeTraceDir();
    const traversing = writeRawBodyOutsideBlobs(traceDir, "c1");
    const core = coreFor(traceDir, "c1", [
      { role: "user", content: traversing },
    ]);

    const manifest = await inventory(core, "c1");
    assert.deepEqual(manifest["parts"], []);
    assert.equal(
      manifest["evidence_gap"],
      "unreadable_referenced_body",
      "a refused reference is an evidence gap, not an empty record"
    );
    assert.ok(
      !JSON.stringify(manifest).includes(RAW_SECRET),
      "native recovery state must not surface through a trace reference"
    );
  });

  it("refuses a content ref whose sha is not a body address before any read", async () => {
    // The injected reader records which shas it was asked for, so this proves
    // the gate is pre-read rather than "the read happened to fail anyway".
    const requested: string[] = [];
    const options = {
      traceFilePath: "/nonexistent/trace.jsonl",
      readBlob: (sha: string): string => {
        requested.push(sha);
        return JSON.stringify({ kind: "str", v: "read anyway" });
      },
    };

    for (const sha of [
      `../code-snapshots/${HEX}`,
      `..%2f..%2f${HEX}`,
      HEX.toUpperCase(),
      HEX.slice(0, 32),
      `${HEX}0`,
    ]) {
      requested.length = 0;
      const out = await dereferenceTraceMessages(
        [{ role: "user", content: { sha, bytes: 10 } }],
        options
      );
      assert.deepEqual(out, [], `sha ${sha} must not dereference`);
      assert.deepEqual(
        requested,
        [],
        `sha ${sha} reached the body read instead of being refused`
      );
    }
  });

  it("refuses a traversing whole-message ref the same way and reports the gap", async () => {
    // Both ref shapes are judged by the same address rule: this sha names a
    // file in `code-snapshots/`, which the blob pool cannot hold, so the ref is
    // refused. What is checked here is the *reporting* of that refusal — a
    // refused whole-message ref reads as an evidence gap, not as a record that
    // has no content.
    const traceDir = makeTraceDir();
    const traversing = writeRawBodyOutsideBlobs(traceDir, "c1");
    const core = coreFor(traceDir, "c1", [
      { sha: traversing.sha, bytes: traversing.bytes },
    ]);

    const manifest = await inventory(core, "c1");
    assert.deepEqual(manifest["parts"], []);
    assert.equal(manifest["evidence_gap"], "unreadable_referenced_body");
    assert.ok(!JSON.stringify(manifest).includes(RAW_SECRET));
  });
});

describe("trace reference access — representation authority", () => {
  it("reads a ref that declares the trace-permitted representation", async () => {
    // The ref comes from the harness's real body writer, so this also locks the
    // read side's own copy of the tag and body-address rule against the single
    // source in `src/harness/trace/trace-body.ts`.
    const traceDir = makeTraceDir();
    const block = textBlock("masked evidence body");
    const ref = writeTraceBodyRef(traceDir, "c1", {
      kind: "blocks",
      v: [block],
    });
    const core = coreFor(traceDir, "c1", [{ role: "user", content: ref }]);

    const manifest = await inventory(core, "c1");
    assert.deepEqual(manifest["parts"], [
      {
        message_index: 0,
        part_index: 0,
        chars: JSON.stringify(block).length,
        role: "user",
      },
    ]);
    assert.equal(manifest["evidence_gap"], undefined);
    const window = await readPart(core, "c1", JSON.stringify(block).length);
    assert.equal(window["text"], JSON.stringify(block));
  });

  it("refuses a foreign representation even when the file answers at that address", async () => {
    // The body sits at a perfectly valid body address, so the declared
    // representation is the only thing that can be refusing it.
    const traceDir = makeTraceDir();
    const ref = writeBody(traceDir, "c1", { kind: "str", v: RAW_SECRET });
    const core = coreFor(traceDir, "c1", [
      {
        role: "user",
        content: { ...ref, representation: FOREIGN_REPRESENTATION },
      },
    ]);

    const manifest = await inventory(core, "c1");
    assert.deepEqual(manifest["parts"], []);
    assert.equal(manifest["evidence_gap"], "unreadable_referenced_body");
    assert.ok(!JSON.stringify(manifest).includes(RAW_SECRET));
  });

  it("still dereferences a legacy ref that declares no representation", async () => {
    // Dual acceptance, deliberately: the untagged shape is what the current
    // writer emits and what every legacy fixture holds, so the gate must not
    // turn existing traces unreadable.
    const traceDir = makeTraceDir();
    const block = textBlock("legacy untagged body");
    const ref = writeBody(traceDir, "c1", { kind: "blocks", v: [block] });
    const core = coreFor(traceDir, "c1", [{ role: "user", content: ref }]);

    const manifest = await inventory(core, "c1");
    assert.deepEqual(manifest["parts"], [
      {
        message_index: 0,
        part_index: 0,
        chars: JSON.stringify(block).length,
        role: "user",
      },
    ]);
    assert.equal(manifest["evidence_gap"], undefined);
  });

  it("reads a shared pool without exposing the bodies it does not reference", async () => {
    // Enumeration is not a capability this reader has: it follows the selected
    // trace's own references, and other bodies in the same folder — raw native
    // state at a perfectly valid body address included — stay out.
    const traceDir = makeTraceDir();
    writeBody(traceDir, "c1", { kind: "str", v: RAW_SECRET });
    const block = textBlock("referenced masked body");
    const maskedRef = writeBody(traceDir, "c1", { kind: "blocks", v: [block] });
    writeBody(traceDir, "c1", { kind: "str", v: "another body's content" });
    const core = coreFor(traceDir, "c1", [
      { role: "user", content: maskedRef },
    ]);

    const manifest = await inventory(core, "c1");
    assert.deepEqual(manifest["parts"], [
      {
        message_index: 0,
        part_index: 0,
        chars: JSON.stringify(block).length,
        role: "user",
      },
    ]);
    const serialized = JSON.stringify(
      await readPart(core, "c1", JSON.stringify(block).length)
    );
    assert.ok(serialized.includes("referenced masked body"));
    assert.ok(!serialized.includes(RAW_SECRET));
    assert.ok(!serialized.includes("another body's content"));
  });
});

describe("trace reference access — incomplete evidence", () => {
  it("reports the evidence gap for a missing body while still answering no parts", async () => {
    // The fail-closed `parts: []` stays (a missing body must not turn a read
    // into a crash); what changes is that an empty inventory is no longer
    // indistinguishable from a record that legitimately has no messages.
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, "c1", [
      { role: "user", content: { sha: "b".repeat(64), bytes: 10 } },
    ]);

    const manifest = await inventory(core, "c1");
    assert.deepEqual(manifest["parts"], []);
    assert.equal(manifest["evidence_gap"], "unreadable_referenced_body");
  });

  it("keeps the record projection intact when it reports the gap", async () => {
    // Additive means additive: the record's own scalars are still projected
    // from the stored row, and the gap is one extra key beside `parts`.
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, "c1", [
      { role: "user", content: [{ type: "text", text: "inline" }] },
      { role: "user", content: { sha: "d".repeat(64), bytes: 10 } },
    ]);

    const manifest = await inventory(core, "c1");
    assert.deepEqual(Object.keys(manifest), [
      "record",
      "matched_on",
      "detail",
      "parts",
      "evidence_gap",
    ]);
    const record = manifest["record"] as Record<string, unknown>;
    assert.equal(record["llm_call_id"], "llm-1");
    assert.deepEqual(manifest["parts"], []);
  });

  it("adds no evidence gap when every referenced body was read", async () => {
    // The gate is a no-op on inline messages, so a fully readable record keeps
    // exactly the keys it had before.
    const traceDir = makeTraceDir();
    const core = coreFor(traceDir, "c1", [
      { role: "user", content: [textBlock("inline")] },
    ]);

    const manifest = await inventory(core, "c1");
    assert.deepEqual(Object.keys(manifest), [
      "record",
      "matched_on",
      "detail",
      "parts",
    ]);
  });
});

describe("trace reference access — portable copies", () => {
  /**
   * One session whose trace references exactly one body, sitting in the same
   * pool as a raw native body and a body no trace references.
   */
  function writePortableSource(traceDir: string): string {
    writeBody(traceDir, "portable", { kind: "str", v: RAW_SECRET });
    const maskedRef = writeBody(traceDir, "portable", {
      kind: "blocks",
      v: [textBlock("portable masked evidence")],
    });
    writeBody(traceDir, "portable", { kind: "str", v: "unreferenced body" });
    coreFor(traceDir, "portable", [{ role: "user", content: maskedRef }]);
    return maskedRef.sha;
  }

  /** `cp`-equivalent: the trace JSONL alone lands in a fresh session folder. */
  function copyTraceJsonl(source: string, copy: string): void {
    const target = sessionDir(copy, "portable");
    mkdirSync(target, { recursive: true });
    copyFileSync(
      join(sessionDir(source, "portable"), "trace.jsonl"),
      join(target, "trace.jsonl")
    );
  }

  it("reports a trace copied without its bodies as visibly incomplete", async () => {
    const source = makeTraceDir();
    writePortableSource(source);
    const copy = makeTraceDir();
    copyTraceJsonl(source, copy);

    const manifest = await inventory(
      createGetRecordCore({ traceDir: copy }),
      "portable"
    );
    assert.deepEqual(manifest["parts"], []);
    assert.equal(manifest["evidence_gap"], "unreadable_referenced_body");
    assert.ok(!JSON.stringify(manifest).includes("portable masked evidence"));
  });

  it("reproduces the same view when only the referenced bodies travel along", async () => {
    const source = makeTraceDir();
    const sha = writePortableSource(source);
    const copy = makeTraceDir();
    copyTraceJsonl(source, copy);
    mkdirSync(join(sessionDir(copy, "portable"), "blobs"), { recursive: true });
    copyFileSync(
      bodyPath(source, "portable", sha),
      bodyPath(copy, "portable", sha)
    );

    const core = createGetRecordCore({ traceDir: copy });
    const manifest = await inventory(core, "portable");
    assert.deepEqual(
      manifest["parts"],
      (await inventory(createGetRecordCore({ traceDir: source }), "portable"))[
        "parts"
      ]
    );
    assert.equal(manifest["evidence_gap"], undefined);

    const block = textBlock("portable masked evidence");
    const window = await readPart(
      core,
      "portable",
      JSON.stringify(block).length
    );
    assert.equal(window["text"], JSON.stringify(block));
    // The bodies that did not travel with the trace stay unreadable here.
    const serialized = JSON.stringify(manifest);
    assert.ok(!serialized.includes(RAW_SECRET));
    assert.ok(!serialized.includes("unreferenced body"));
    assert.equal(Object.keys(window).at(-1), "text");
  });
});
