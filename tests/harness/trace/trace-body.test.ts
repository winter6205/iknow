/**
 * writeTraceBody — the trace-permitted retained body primitive.
 *
 * The pool is physically shared with raw native recovery state, so this file
 * pins the properties that keep the two apart: the representation tag, the
 * masked-bytes content address, dedup on identical masked bytes, and a throw on
 * a real storage fault instead of a degraded reference.
 *
 * Contracts:
 * 1. normal: sha/bytes address the retained body; the file is the serialized value
 * 2. reuse: identical masked bytes → one file, an equal ref (write-if-missing)
 * 3. changed bytes → a different sha, so the old body is never overwritten
 * 4. redaction: the address is computed on MASKED bytes, and the stored bytes
 *    equal the masker output exactly — the raw value is never recoverable
 * 5. failure: an unwritable body path throws (no ref, no inline substitute)
 * 6. boundary: empty string / empty array / undefined value
 * 7. authority: a reader accepts only the exact tag and a lowercase 64-hex sha
 */

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  TRACE_BODY_REPRESENTATION,
  isTraceBodyRepresentation,
  isTraceBodySha,
  writeTraceBody,
} from "../../../src/harness/trace/trace-body.ts";
import { createOutputMask } from "../../../src/harness/sandbox/output-mask.ts";

const SECRET = "sk-live-abc123def";
const identity = (text: string): string => text;
const secretMask = createOutputMask([SECRET]).mask;
const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");
const blobPath = (pool: string, sha: string): string =>
  join(pool, "blobs", sha);
const blobNames = (pool: string): string[] => readdirSync(join(pool, "blobs"));
const readBody = (pool: string, sha: string): string =>
  readFileSync(blobPath(pool, sha), "utf8");

let pool: string;

beforeEach(() => {
  pool = mkdtempSync(join(tmpdir(), "iknow-trace-body-"));
});

afterEach(() => {
  rmSync(pool, { recursive: true, force: true });
});

describe("writeTraceBody — normal", () => {
  it("addresses and retains the serialized value", () => {
    const value = { role: "user", content: "hi" };
    const ref = writeTraceBody(pool, value, identity);

    const serialized = JSON.stringify(value);
    assert.equal(ref.sha, sha256Hex(serialized));
    assert.equal(ref.bytes, Buffer.byteLength(serialized, "utf8"));
    assert.equal(ref.representation, TRACE_BODY_REPRESENTATION);
    assert.deepEqual(blobNames(pool), [ref.sha]);
    assert.equal(readBody(pool, ref.sha), serialized);
  });
});

describe("writeTraceBody — reuse", () => {
  it("collapses identical masked bytes into one file and an equal ref", () => {
    const value = { role: "user", content: "same" };

    const first = writeTraceBody(pool, value, identity);
    const second = writeTraceBody(pool, value, identity);

    assert.deepEqual(second, first);
    assert.deepEqual(blobNames(pool), [first.sha]);
  });

  it("gives changed bytes a different sha and leaves the old body intact", () => {
    const first = writeTraceBody(pool, { content: "before" }, identity);
    const second = writeTraceBody(pool, { content: "after" }, identity);

    assert.notEqual(second.sha, first.sha);
    assert.deepEqual(blobNames(pool).sort(), [first.sha, second.sha].sort());
    assert.equal(
      readBody(pool, first.sha),
      JSON.stringify({ content: "before" })
    );
    assert.equal(
      readBody(pool, second.sha),
      JSON.stringify({ content: "after" })
    );
  });
});

describe("writeTraceBody — redaction", () => {
  it("hashes and stores the masker output, never the raw value", () => {
    const value = { token: SECRET, prompt: "call the api" };
    const raw = JSON.stringify(value);
    const masked = secretMask(raw);
    assert.notEqual(masked, raw);

    const ref = writeTraceBody(pool, value, secretMask);

    assert.equal(ref.sha, sha256Hex(masked));
    assert.notEqual(ref.sha, sha256Hex(raw));
    assert.equal(ref.bytes, Buffer.byteLength(masked, "utf8"));
    const stored = readBody(pool, ref.sha);
    assert.equal(stored, masked);
    assert.equal(stored.includes(SECRET), false);
    assert.equal(stored.includes("***"), true);
  });

  it("gives the same secret-bearing value a different ref once masked", () => {
    const value = { token: SECRET };

    const unmasked = writeTraceBody(pool, value, identity);
    const masked = writeTraceBody(pool, value, secretMask);

    assert.notEqual(masked.sha, unmasked.sha);
    assert.deepEqual(blobNames(pool).sort(), [masked.sha, unmasked.sha].sort());
  });

  it("counts utf8 bytes of the masked body, not the string length", () => {
    const value = { text: "密钥" };
    const masked = secretMask(JSON.stringify(value));

    const ref = writeTraceBody(pool, value, secretMask);

    assert.equal(ref.bytes, Buffer.byteLength(masked, "utf8"));
    // The two CJK chars are 2 code units but 6 utf8 bytes, so `bytes` must
    // outrun the string length — the size the reader restores must match what
    // was actually written.
    assert.equal(ref.bytes - masked.length, 4);
    assert.equal(Buffer.byteLength(readBody(pool, ref.sha), "utf8"), ref.bytes);
  });
});

describe("writeTraceBody — failure", () => {
  it("throws when the body path is occupied by a regular file", () => {
    writeFileSync(join(pool, "blobs"), "not a directory");

    assert.throws(
      () => writeTraceBody(pool, { content: "hi" }, identity),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST"
    );
    assert.throws(() => writeTraceBody(pool, { content: "hi" }, identity));
  });

  it("throws when the pool directory itself cannot hold a body", () => {
    const filePool = join(pool, "pool-is-a-file");
    writeFileSync(filePool, "not a directory");

    assert.throws(
      () => writeTraceBody(filePool, { content: "hi" }, identity),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR"
    );
  });
});

describe("writeTraceBody — boundary", () => {
  it("addresses an empty string, an empty array and undefined", () => {
    const emptyString = writeTraceBody(pool, "", identity);
    const emptyArray = writeTraceBody(pool, [], identity);
    const undefinedValue = writeTraceBody(pool, undefined, identity);

    assert.equal(readBody(pool, emptyString.sha), '""');
    assert.equal(emptyString.bytes, 2);
    assert.equal(readBody(pool, emptyArray.sha), "[]");
    assert.equal(emptyArray.bytes, 2);
    assert.equal(readBody(pool, undefinedValue.sha), "null");
    assert.equal(undefinedValue.bytes, 4);
    assert.equal(blobNames(pool).length, 3);
  });
});

describe("isTraceBodySha — authority", () => {
  it("accepts a body address this module produced", () => {
    const ref = writeTraceBody(pool, { content: "hi" }, identity);

    assert.equal(isTraceBodySha(ref.sha), true);
  });

  it("rejects traversal, uppercase, wrong length and non-hex names", () => {
    const lower = writeTraceBody(pool, { content: "hi" }, identity).sha;

    assert.equal(isTraceBodySha(`../${lower}`), false);
    assert.equal(isTraceBodySha(lower.toUpperCase()), false);
    assert.equal(isTraceBodySha(lower.slice(0, 63)), false);
    assert.equal(isTraceBodySha(`${lower}0`), false);
    assert.equal(isTraceBodySha(lower.replace(/^./, "z")), false);
    assert.equal(isTraceBodySha(""), false);
    assert.equal(isTraceBodySha("blobs"), false);
    assert.equal(isTraceBodySha(undefined), false);
    assert.equal(isTraceBodySha(null), false);
    assert.equal(isTraceBodySha(42), false);
    assert.equal(isTraceBodySha({ sha: lower }), false);
  });
});

describe("isTraceBodyRepresentation — authority", () => {
  it("accepts only the recognized trace representation tag", () => {
    const ref = writeTraceBody(pool, { content: "hi" }, identity);

    assert.equal(isTraceBodyRepresentation(TRACE_BODY_REPRESENTATION), true);
    assert.equal(isTraceBodyRepresentation(ref.representation), true);
    assert.equal(isTraceBodyRepresentation("raw-native-state-v1"), false);
    assert.equal(isTraceBodyRepresentation("masked-trace-v2"), false);
    assert.equal(isTraceBodyRepresentation("MASKED-TRACE-V1"), false);
    assert.equal(isTraceBodyRepresentation(""), false);
    assert.equal(isTraceBodyRepresentation(undefined), false);
    assert.equal(isTraceBodyRepresentation(null), false);
    assert.equal(isTraceBodyRepresentation({ sha: ref.sha }), false);
  });
});
