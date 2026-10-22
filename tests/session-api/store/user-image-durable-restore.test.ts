/**
 * Durable-persistence evidence for the user-pasted image block: the payload
 * rides inside the accepted user message record and must survive a real
 * close/reopen — authoritative history, the next wire request, the checkpoint
 * mirror, and the secret masker all see one verbatim payload, with no
 * clipboard and no source file anywhere in reach.
 *
 * Production writer + production readers over a fresh mkdtemp dir per case
 * (project test rule): durability claims are checked against the persisted
 * JSONL and through a newly constructed store, never an in-memory echo.
 */
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  parseSessionJsonl,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
} from "../../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";
import { nativeStateBlobsDir } from "../../../src/session-api/store/native-state-store.ts";
import { projectMessagesForWire } from "../../../src/harness/model-adapter/outbound-projection.ts";
import { estimateMessagesTokens } from "../../../src/harness/compress/estimate.ts";
import { recognize } from "../../../src/harness/secret-roundtrip/index.ts";
import {
  MAX_IMAGE_BASE64_CHARS,
  PNG_BASE64,
  imageWithSource,
} from "../../fixtures/image-payloads.ts";
import type { NativeStateSnapshot } from "../../../src/shared/native-state-port.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../../src/harness/model-adapter/types.ts";

// -- fixtures ----------------------------------------------------------------

const text = (t: string): AnthropicContentBlock => ({ type: "text", text: t });

const userMessage = (
  ...blocks: ReadonlyArray<AnthropicContentBlock>
): AnthropicNativeMessage => ({ role: "user", content: blocks });

const assistantMessage = (t: string): AnthropicNativeMessage =>
  ({ role: "assistant", content: [{ type: "text", text: t }] }) as unknown as AnthropicNativeMessage;

const emptyFile = (id: string): SessionFileV1 => ({
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
});

const imageSourceOf = (block: AnthropicContentBlock): Record<string, unknown> =>
  (block as unknown as { source: Record<string, unknown> }).source;

let baseDir: string;
let projectDir: string;
let store: SessionStore;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-durable-image-"));
  projectDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const sessionDirFor = (id: string): string =>
  resolveConversationDir({ projectDir, conversationId: id });
const jsonlPathFor = (id: string): string =>
  join(sessionDirFor(id), `${id}.jsonl`);

/** Commit one real image-bearing turn through the production writer:
 *  save migrates the session, appendEvents is the hub's commit hook. */
async function commitImageTurn(
  id: string,
  blocks: ReadonlyArray<AnthropicContentBlock>
): Promise<void> {
  await store.save({ id, file: emptyFile(id) });
  await store.appendEvents({
    id,
    events: [userMessage(...blocks), assistantMessage("a red square")],
  });
}

// -- 1 + 2: persisted JSONL and reopen identity -------------------------------

describe("durable persistence: write, reopen, identity", () => {
  it("the persisted JSONL itself carries the image inside the user message record", async () => {
    const id = "durable-jsonl-shape";
    const imageBlock = imageWithSource();
    await commitImageTurn(id, [text("what is in this?"), imageBlock]);

    const raw = await readFile(jsonlPathFor(id), "utf8");
    // The production codec parses the file intact — no new record type was added.
    parseSessionJsonl(raw);
    const userRecord = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find(
        (r) =>
          r["type"] === "message" &&
          (r["message"] as { role: string }).role === "user"
      );
    assert.ok(userRecord, "the user message record must live in the JSONL");
    assert.deepEqual(
      (userRecord["message"] as { content: unknown[] }).content,
      [{ type: "text", text: "what is in this?" }, imageBlock],
      "the payload lives inside the accepted user record, not a side file"
    );
    assert.ok(raw.includes(PNG_BASE64));
  });

  it("a newly built store over the same directory returns the image block byte-for-byte", async () => {
    const id = "durable-reopen-identity";
    const imageBlock = imageWithSource();
    await commitImageTurn(id, [text("what is in this?"), imageBlock]);

    const reopened = new SessionStore(baseDir, process.cwd());
    const loaded = await reopened.load(id);
    const restored = loaded.messages[0]!.content[1]!;
    assert.deepEqual(restored, imageBlock);
    // The exact claim: byte-for-byte identity of the serialized block across reopen.
    assert.equal(JSON.stringify(restored), JSON.stringify(imageBlock));
    assert.equal(imageSourceOf(restored)["data"], PNG_BASE64);
    assert.equal(imageSourceOf(restored)["media_type"], "image/png");
  });
});

// -- 3 + 4: the next request and its occupancy --------------------------------

describe("the reloaded history still feeds the model", () => {
  it("the wire projected from the reloaded history keeps the image block intact", async () => {
    const id = "durable-wire-after-reopen";
    const imageBlock = imageWithSource();
    await commitImageTurn(id, [text("what is in this?"), imageBlock]);

    const reopened = new SessionStore(baseDir, process.cwd());
    const loaded = await reopened.load(id);
    const wire = projectMessagesForWire(loaded.messages);
    assert.deepEqual(wire[0]!.content, [
      { type: "text", text: "what is in this?" },
      imageBlock,
    ]);
  });

  it("the reloaded image-bearing message estimates non-zero tokens — the image itself contributes", async () => {
    const id = "durable-estimate-nonzero";
    await commitImageTurn(id, [text("look"), imageWithSource()]);

    const reopened = new SessionStore(baseDir, process.cwd());
    const loaded = await reopened.load(id);
    const withImage = estimateMessagesTokens(loaded.messages);
    const withoutImage = estimateMessagesTokens(
      loaded.messages.map((m) => ({
        ...m,
        content: m.content.filter((b) => b.type !== "image"),
      }))
    );
    assert.ok(withImage > withoutImage, "an unrecognized block reads as FREE; this one must not");
  });
});

// -- 5: checkpoint mirror across the same close/reopen ------------------------

describe("native checkpoint save/restore survives close/reopen", () => {
  it("a second store selects and restores the image-bearing published state", async () => {
    const id = "durable-native-reopen";
    await commitImageTurn(id, [text("what is in this?"), imageWithSource()]);
    const snapshot = {
      boundary: "input",
      messages: [
        userMessage(text("what is in this?"), imageWithSource()),
        assistantMessage("a red square"),
      ],
    } as unknown as NativeStateSnapshot;

    const { bodySha } = await store.appendNativeState({
      id,
      anchorEventId: "e1",
      boundary: "input",
      snapshot,
    });

    const reopened = new SessionStore(baseDir, process.cwd());
    const selection = await reopened.loadPublishedNativeState({ id });
    assert.equal(selection.selected?.bodySha, bodySha);
    const restored = await reopened.readPublishedNativeStateBody({
      id,
      bodySha: selection.selected!.bodySha,
    });
    assert.deepEqual(restored, snapshot);
  });
});

// -- 6: the block path is never a text transform ------------------------------

describe("secret masking never touches source.data", () => {
  // A payload carrying the sk- secret shape: legal `data` (the gate checks
  // string/size, not base64 alphabet), and `recognize()` would rewrite it.
  const SECRET_RUN = "sk-AbCdEf0123456789ghijkl";
  const payload = `iVBORw0${SECRET_RUN}XY==`;

  it("the persisted, reloaded, and projected payload survives with no placeholder substitution", async () => {
    const id = "durable-mask-image-payload";
    await commitImageTurn(id, [
      text(`note ${SECRET_RUN}`),
      imageWithSource({
        type: "base64",
        media_type: "image/png",
        data: payload,
      }),
    ]);

    const raw = await readFile(jsonlPathFor(id), "utf8");
    assert.ok(raw.includes(payload), "on-disk bytes are verbatim");
    const reopened = new SessionStore(baseDir, process.cwd());
    const loaded = await reopened.load(id);
    assert.equal(imageSourceOf(loaded.messages[0]!.content[1]!)["data"], payload);
    const wire = projectMessagesForWire(loaded.messages);
    assert.equal(
      imageSourceOf(wire[0]!.content[1] as AnthropicContentBlock)["data"],
      payload
    );
  });

  it("the same payload inline as TEXT would be masked — proof the block path dodged the transform", () => {
    assert.match(recognize(`note ${SECRET_RUN}`).replaced, /<<<SECRET_\d+>>>/);
    assert.notEqual(recognize(payload).replaced, payload);
  });
});

// -- 7: corrupt / missing image -> typed recovery failure ---------------------

describe("a corrupt or missing image fails typed, never silently", () => {
  const corruptSources: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["url", { type: "url", media_type: "image/png", data: PNG_BASE64 }],
    ["unknown-media", { type: "base64", media_type: "image/tiff", data: PNG_BASE64 }],
    [
      "oversized",
      {
        type: "base64",
        media_type: "image/png",
        data: "A".repeat(MAX_IMAGE_BASE64_CHARS + 1),
      },
    ],
  ];

  for (const [label, source] of corruptSources) {
    it(`a hand-written record with a corrupt image (${label}) blocks load with typed schema_invalid`, async () => {
      const id = `durable-corrupt-${label}`;
      await commitImageTurn(id, [text("fine"), imageWithSource()]);
      // Hand-append an illegal event (external transcript pollution — the
      // production writer's commit hook is not the subject of this case).
      await appendFile(
        jsonlPathFor(id),
        `${JSON.stringify({
          type: "message",
          id: "e2",
          parent: "e1",
          message: userMessage(imageWithSource(source)),
        })}\n${JSON.stringify({ type: "head", id: "e2" })}\n`,
        "utf8"
      );

      const reopened = new SessionStore(baseDir, process.cwd());
      await assert.rejects(reopened.load(id), (err: unknown) => {
        const e = err as { kind?: string; field?: string; conversation_id?: string };
        assert.equal(e.kind, "schema_invalid");
        assert.equal(e.field, "messages");
        assert.equal(e.conversation_id, id);
        return true;
      });
      // Blocked use, not erased history: the record stays on disk unrewritten.
      assert.ok(
        (await readFile(jsonlPathFor(id), "utf8")).includes(JSON.stringify(source))
      );
    });
  }

  it("a published state whose body blob is missing fails as typed not_found, never as 'nothing published'", async () => {
    const id = "durable-body-missing";
    await commitImageTurn(id, [text("what is in this?"), imageWithSource()]);
    const { bodySha } = await store.appendNativeState({
      id,
      anchorEventId: "e1",
      boundary: "input",
      snapshot: {
        boundary: "input",
        messages: [userMessage(imageWithSource())],
      } as unknown as NativeStateSnapshot,
    });
    await rm(join(nativeStateBlobsDir(sessionDirFor(id)), bodySha));

    const reopened = new SessionStore(baseDir, process.cwd());
    const selection = await reopened.loadPublishedNativeState({ id });
    assert.equal(selection.selected?.bodySha, bodySha);
    await assert.rejects(
      reopened.readPublishedNativeStateBody({ id, bodySha }),
      (err: unknown) => {
        const e = err as { kind?: string; conversation_id?: string };
        assert.equal(e.kind, "not_found");
        assert.equal(e.conversation_id, id);
        return true;
      }
    );
  });

  it("a tampered image body fails as typed schema_invalid, an unparseable body as parse_failed", async () => {
    const id = "durable-body-tampered";
    await commitImageTurn(id, [text("what is in this?"), imageWithSource()]);
    const { bodySha } = await store.appendNativeState({
      id,
      anchorEventId: "e1",
      boundary: "input",
      snapshot: {
        boundary: "input",
        messages: [userMessage(imageWithSource())],
      } as unknown as NativeStateSnapshot,
    });
    const bodyPath = join(nativeStateBlobsDir(sessionDirFor(id)), bodySha);
    const reopened = new SessionStore(baseDir, process.cwd());

    // Corrupt-but-parsable: an image the gate refuses.
    await writeFile(
      bodyPath,
      JSON.stringify({
        boundary: "input",
        messages: [userMessage(imageWithSource({ type: "url", url: "https://example.invalid/a.png" }))],
      }),
      "utf8"
    );
    await assert.rejects(
      reopened.readPublishedNativeStateBody({ id, bodySha }),
      (err: unknown) => {
        const e = err as { kind?: string; field?: string };
        assert.equal(e.kind, "schema_invalid");
        assert.equal(e.field, "messages");
        return true;
      }
    );

    // Damaged bytes: not even JSON.
    await writeFile(bodyPath, "{not json", "utf8");
    await assert.rejects(reopened.readPublishedNativeStateBody({ id, bodySha }), (err: unknown) => {
      const e = err as { kind?: string };
      assert.equal(e.kind, "parse_failed");
      return true;
    });
  });
});
