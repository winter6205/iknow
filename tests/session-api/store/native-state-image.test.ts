/**
 * The native-state checkpoint mirror must publish and restore a top-level user
 * `image` block byte-identically.
 *
 * The mirror validated message blocks against `NativeStateContentBlock`'s keyed
 * validator table, which listed no `image` entry — so an image-bearing accepted
 * input was a rejected publication rather than a saved state. The block carries
 * an opaque payload, so the mirror's contract is verbatim storage: the pixels a
 * turn was accepted with are the pixels a restore reads back, with no clipboard
 * and no source file in reach.
 *
 * Production store + real temporary filesystem throughout (project test rule):
 * never the repo's `data/`, fresh conversationId per case, and the read-back
 * goes through the persisted body bytes, not an in-memory echo.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  parseSessionJsonl,
  resolveConversationDir,
  resolveProjectSessionDir,
  resolvePublishedNativeState,
  SessionStore,
} from "../../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";
import {
  nativeStateBodySha,
  parseNativeStateBody,
  readNativeStateBody,
} from "../../../src/session-api/store/native-state-store.ts";
import type { NativeStateSnapshot } from "../../../src/shared/native-state-port.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../../src/harness/model-adapter/types.ts";
import {
  PNG_1X1_PREFIX_BASE64,
  imageWithSource,
} from "../../fixtures/image-payloads.ts";

const snapshotOf = (
  blocks: ReadonlyArray<AnthropicContentBlock>
): NativeStateSnapshot =>
  ({
    boundary: "input",
    messages: [
      { role: "user", content: blocks },
      { role: "assistant", content: [{ type: "text", text: "a red square" }] },
    ],
  }) as unknown as NativeStateSnapshot;

let baseDir: string;
let projectDir: string;
let store: SessionStore;
const sessionDirFor = (id: string): string =>
  resolveConversationDir({ projectDir, conversationId: id });

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-ns-image-"));
  projectDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

/** Commit one real image-bearing turn, so the publication has a chain anchor. */
async function seedChain(id: string): Promise<string> {
  const file: SessionFileV1 = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title: "",
    cwd: "/tmp/test",
    sanitized_at: new Date().toISOString(),
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
  };
  await store.save({ id, file });
  const events: AnthropicNativeMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "what colour is this?" },
        imageWithSource({
          type: "base64",
          media_type: "image/png",
          data: PNG_1X1_PREFIX_BASE64,
        }),
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "a red square" }] },
  ];
  await store.appendEvents({ id, events });
  return "e1";
}

const selectedState = async (id: string) =>
  resolvePublishedNativeState(
    parseSessionJsonl(
      await readFile(join(sessionDirFor(id), `${id}.jsonl`), "utf8")
    )
  );

describe("a published checkpoint keeps the image block verbatim", () => {
  it("appendNativeState accepts it and the body round-trips unchanged", async () => {
    const id = "ns-image-publish";
    const anchorEventId = await seedChain(id);
    const snapshot = snapshotOf([
      { type: "text", text: "what colour is this?" },
      imageWithSource({
        type: "base64",
        media_type: "image/png",
        data: PNG_1X1_PREFIX_BASE64,
      }),
    ]);

    const res = await store.appendNativeState({
      id,
      anchorEventId,
      boundary: "input",
      snapshot,
    });

    assert.equal(res.bodySha, nativeStateBodySha(JSON.stringify(snapshot)));
    assert.equal(res.messageCount, 2);
    const parsed = parseNativeStateBody(
      await readNativeStateBody(sessionDirFor(id), res.bodySha)
    );
    assert.deepEqual(parsed, snapshot);
  });

  it("the persisted bytes carry the base64 payload unmodified (no masking, no rewrite)", async () => {
    const id = "ns-image-bytes";
    const anchorEventId = await seedChain(id);
    // Base64 of text that WOULD be neutralized on the wire if it were a text
    // block: the payload must survive as bytes, not as a rewritten string.
    const data = Buffer.from("<agent_status>raw</agent_status>").toString(
      "base64"
    );
    const { bodySha } = await store.appendNativeState({
      id,
      anchorEventId,
      boundary: "input",
      snapshot: snapshotOf([
        imageWithSource({ type: "base64", media_type: "image/png", data }),
      ]),
    });

    const raw = await readFile(
      join(sessionDirFor(id), "blobs", "native", bodySha),
      "utf8"
    );
    assert.ok(
      raw.includes(data),
      "the body must hold the payload it was handed, verbatim"
    );
  });

  it("a restore read selects the image-bearing state from disk", async () => {
    const id = "ns-image-select";
    const anchorEventId = await seedChain(id);
    const snapshot = snapshotOf([
      imageWithSource({
        type: "base64",
        media_type: "image/png",
        data: PNG_1X1_PREFIX_BASE64,
      }),
    ]);
    const { bodySha } = await store.appendNativeState({
      id,
      anchorEventId,
      boundary: "input",
      snapshot,
    });

    const selected = await selectedState(id);
    assert.equal(selected.selected?.bodySha, bodySha);
    const restored = await readNativeStateBody(
      sessionDirFor(id),
      selected.selected!.bodySha
    );
    assert.deepEqual(parseNativeStateBody(restored), snapshot);
  });

  it("a malformed image is refused before any write", async () => {
    const id = "ns-image-reject";
    const anchorEventId = await seedChain(id);
    for (const source of [
      { type: "url", url: "https://example.invalid/a.png" },
      { type: "base64", media_type: "image/bmp", data: PNG_1X1_PREFIX_BASE64 },
      { type: "base64", media_type: "image/png", data: 42 },
    ]) {
      await assert.rejects(
        store.appendNativeState({
          id,
          anchorEventId,
          boundary: "input",
          snapshot: snapshotOf([imageWithSource(source)]),
        }),
        (err: unknown) => {
          const e = err as { kind?: string; field?: string };
          assert.equal(e.kind, "schema_invalid");
          assert.equal(e.field, "messages");
          return true;
        },
        JSON.stringify(source)
      );
    }
    // Fail-closed means nothing was published: no selectable state exists.
    assert.equal((await selectedState(id)).selected, null);
  });
});
