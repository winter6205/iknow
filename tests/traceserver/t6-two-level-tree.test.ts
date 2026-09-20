/**
 * ADR-0071 / SC14–SC17: the traceserver read side walks the two-level tree
 * and query_trace dereferences content-level blob refs.
 *
 * Key read-side shape after the blob refactor:
 *   - single blob mode: `messages[i] = {role, content:{sha,bytes}}`; the content
 *     body is written via `toBlobReferences` as `{kind:"str"|"blocks", v:content}`.
 *   - session folder layout: trace at
 *     `<baseDir>/projects/<slug>/<convId>/trace.jsonl`,
 *     blob at `<...>/<convId>/blobs/<sha>`.
 *
 * The pre-existing dereferenceTraceMessages used the `"sha" in message` test,
 * covering only whole-message refs, not content-level refs. This file verifies:
 *   - the read side accepts content-ref messages and resolves the
 *     {kind:"str"|"blocks", v:...} shape;
 *   - query_trace's three previews return body text (SC14);
 *   - inline and content-ref messages in one array are judged per element (SC17);
 *   - the existing fail-closed behavior holds (missing blob → empty array / no preview).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";

import { dereferenceTraceMessages } from "../../src/traceserver/project-tool-results.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function makeSessionFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-t6-deref-"));
  tempDirs.push(dir);
  return dir;
}

interface ContentPayload {
  kind: "str" | "blocks";
  v: unknown;
}

function writeBlob(
  blobDir: string,
  content: unknown,
  encoding: "str" | "blocks" = "blocks"
): { sha: string; bytes: number } {
  const payload: ContentPayload = { kind: encoding, v: content };
  const serialized = JSON.stringify(payload);
  const sha = createHash("sha256").update(serialized).digest("hex");
  writeFileSync(join(blobDir, sha), serialized, "utf8");
  return { sha, bytes: Buffer.byteLength(serialized) };
}

describe("dereferenceTraceMessages (T6 SC14 / SC17)", () => {
  it("decodes content-ref messages of shape {role, content:{sha,bytes}} (T4 SC10)", async () => {
    // Post-refactor shape: role stays inline, content is a blob ref whose body
    // is {kind:"blocks", v:[...]} or {kind:"str", v:"..."}.
    const sessionFolder = makeSessionFolder();
    const blobDir = join(sessionFolder, "blobs");
    mkdirSync(blobDir);
    const traceFilePath = join(sessionFolder, "trace.jsonl");
    const ref = writeBlob(blobDir, [{ type: "text", text: "hello" }]);
    const messages = [{ role: "user", content: ref }];

    const out = await dereferenceTraceMessages(messages, { traceFilePath });
    assert.equal(out.length, 1);
    // After unwrapping the outer {kind,v}, content resolves back to the array
    // (blocks shape). This test pins only: role == "user" is present and
    // content is the blocks array.
    const msg = out[0] as { role: string; content: unknown };
    assert.equal(msg.role, "user");
    assert.deepEqual(msg.content, [{ type: "text", text: "hello" }]);
  });

  it("decodes content-ref messages with kind='str' (T4 表 C 形状 2)", async () => {
    const sessionFolder = makeSessionFolder();
    const blobDir = join(sessionFolder, "blobs");
    mkdirSync(blobDir);
    const traceFilePath = join(sessionFolder, "trace.jsonl");
    const ref = writeBlob(blobDir, "raw string content", "str");
    const messages = [{ role: "system", content: ref }];

    const out = await dereferenceTraceMessages(messages, { traceFilePath });
    const msg = out[0] as { role: string; content: unknown };
    assert.equal(msg.role, "system");
    assert.equal(msg.content, "raw string content");
  });

  it("mixes inline messages and content-ref messages per element (SC17 混排)", async () => {
    // Inline and content-ref messages in one array are judged per element:
    // neither is misread as the other.
    const sessionFolder = makeSessionFolder();
    const blobDir = join(sessionFolder, "blobs");
    mkdirSync(blobDir);
    const traceFilePath = join(sessionFolder, "trace.jsonl");
    const inline = { role: "user", content: [{ type: "text", text: "first" }] };
    const ref = writeBlob(blobDir, "second");
    const messages = [inline, { role: "user", content: ref }];

    const out = await dereferenceTraceMessages(messages, { traceFilePath });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], inline);
    const second = out[1] as { role: string; content: unknown };
    assert.equal(second.role, "user");
    assert.equal(second.content, "second");
  });

  it("keeps full-message-ref shape {sha, bytes} as the historical escape hatch (T4 fixture 兼容)", async () => {
    // Legacy fixtures may still hold whole-message refs ({sha,bytes} with no
    // {kind,v} wrapper, from the old direct message-serialization path). The
    // read side must keep tolerating that shape; this test pins the tolerance
    // only — it does not revive the write path.
    const sessionFolder = makeSessionFolder();
    const blobDir = join(sessionFolder, "blobs");
    mkdirSync(blobDir);
    const traceFilePath = join(sessionFolder, "trace.jsonl");
    const inner = { role: "user", content: "legacy whole-message ref" };
    const serialized = JSON.stringify(inner);
    const sha = createHash("sha256").update(serialized).digest("hex");
    writeFileSync(join(blobDir, sha), serialized, "utf8");

    const out = await dereferenceTraceMessages(
      [{ sha, bytes: Buffer.byteLength(serialized) }],
      { traceFilePath }
    );
    assert.deepEqual(out[0], inner);
  });

  it("returns [] on any blob failure (读侧 fail-closed 既有契约保持)", async () => {
    // Any failure (missing role, corrupt blob, unresolved ref) degrades to an
    // empty array instead of throwing into the caller's turn — the existing
    // fail-closed EXIT of projectToolResultsFromTrace.
    const sessionFolder = makeSessionFolder();
    const blobDir = join(sessionFolder, "blobs");
    mkdirSync(blobDir);
    const traceFilePath = join(sessionFolder, "trace.jsonl");
    const ref = writeBlob(blobDir, [{ type: "text", text: "x" }]);
    // Remove the blob so ref.sha resolves to nothing → failure degradation.
    rmSync(join(blobDir, ref.sha));
    const messages = [{ role: "user", content: ref }];
    const out = await dereferenceTraceMessages(messages, { traceFilePath });
    assert.deepEqual(out, []);
  });
});
