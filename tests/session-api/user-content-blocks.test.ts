/**
 * Ordered user content (text + Anthropic image blocks) through SessionHub:
 * acceptance of an image-only message, secret masking scoped to text blocks,
 * the text-length cap caliber, the memory-prefetch overlay position, and the
 * serialize queue's handling of an input accepted while a turn is running.
 *
 * Every case drives the production hub + production SessionStore over a fresh
 * temporary directory, and reads the persisted log back through a second store
 * instance. The model-visible payload is observed from the engine's own
 * `adapter.step` input, so nothing here depends on a mock of the write path.
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionHub } from "../../src/session-api/hub.ts";
import {
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import { ValidationError } from "../../src/shared/errors.ts";
import { MEMORY_ADVISORY_PREFIX } from "../../src/harness/memory/index.ts";
import { encodeUserContent } from "../../src/harness/model-adapter/anthropic-adapter.ts";
import { createSecretRegistry } from "../../src/harness/secret-roundtrip/index.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  LoopState,
} from "../../src/harness/model-adapter/types.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import {
  LARGE_PNG_BASE64,
  PNG_1X1_BASE64,
  imageBlock,
  secretShapedBase64,
  textBlock,
} from "../fixtures/image-payloads.ts";

function imageData(block: AnthropicContentBlock | undefined): string {
  if (block === undefined || block.type !== "image") {
    throw new Error("expected an image block");
  }
  return block.source.data;
}

function textOf(message: AnthropicNativeMessage): string {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

interface Harness {
  readonly hub: SessionHub;
  readonly conversationId: string;
  /** Reload the persisted log with a store instance that never wrote it. */
  readonly reload: (conversationId: string) => Promise<SessionFileV1>;
  /** The message list each engine step actually received, in call order. */
  readonly engineInputs: AnthropicNativeMessage[][];
}

/** Hub on injected stub deps; `options.overlay` stands in for the memory
 *  prefetch producer, `options.secrets` arms the recognition layer, and
 *  `options.blockEncoder` off removes the adapter's block encoder — the shape
 *  of a host that never learned about image payloads. */
async function makeHarness(
  options: {
    readonly responses?: number;
    readonly overlay?: string;
    readonly secrets?: boolean;
    readonly blockEncoder?: boolean;
  } = {}
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "iknow-user-content-"));
  dirs.push(dir);
  const store = new SessionStore(dir, process.cwd());
  const inner = makeDeps(
    Array.from({ length: options.responses ?? 1 }, (_unused, i) =>
      assistantResult({ texts: [`reply-${i + 1}`] })
    )
  );
  const engineInputs: AnthropicNativeMessage[][] = [];
  const adapter = {
    ...inner.adapter,
    step: async (state: LoopState, request: unknown, signal?: AbortSignal) => {
      engineInputs.push([...state.messages]);
      return inner.adapter.step(
        state,
        request as Parameters<typeof inner.adapter.step>[1],
        signal
      );
    },
    // The stub model predates block payloads. Wired to the production encoder,
    // which is the same function the real Anthropic adapter returns.
    ...(options.blockEncoder === false
      ? {}
      : {
          encodeUserContent: (blocks: ReadonlyArray<AnthropicContentBlock>) =>
            encodeUserContent(blocks),
        }),
  };
  const deps: LoopEngineDeps = {
    ...inner,
    adapter,
    ...(options.secrets === true
      ? {
          secretRegistry: createSecretRegistry(),
          secretsMode: "roundtrip" as const,
        }
      : {}),
  };
  const hub = new SessionHub({
    store,
    deps,
    workspaceRoot: process.cwd(),
    ...(options.overlay === undefined
      ? {}
      : // OverlayPrefetchFn returns a string; an absent overlay never reaches
        // the producer anyway (this arm is wired only when one is set).
        { overlayMemoryPrefetch: async () => options.overlay ?? "" }),
  });
  const { session } = await hub.createSession();
  return {
    hub,
    conversationId: session.conversation_id,
    reload: (conversationId) =>
      new SessionStore(dir, process.cwd()).load(conversationId),
    engineInputs,
  };
}

function firstUserMessage(file: SessionFileV1): AnthropicNativeMessage {
  const message = file.messages.find((m) => m.role === "user");
  if (!message) throw new Error("no user message persisted");
  return message;
}

describe("SessionHub: ordered user content", () => {
  it("accepts and persists an image-only message (empty text)", async () => {
    const h = await makeHarness();
    const { conversationId } = h;
    const res = await h.hub.postMessage({
      conversationId,
      text: "",
      content: [imageBlock()],
    });
    assert.equal(res.turn.answer.finalText, "reply-1");
    const file = await h.reload(conversationId);
    const user = firstUserMessage(file);
    assert.deepEqual(user.content, [imageBlock()]);
    assert.equal(imageData(user.content[0]), PNG_1X1_BASE64);
    // The engine must see the same payload, not a text-only stand-in.
    assert.equal(h.engineInputs.length >= 1, true);
    const lastSeen = h.engineInputs[0]!.filter((m) => m.role === "user").pop();
    assert.deepEqual(lastSeen?.content, [imageBlock()]);
  });

  it("keeps rejecting a message that is empty in both text and blocks", async () => {
    const h = await makeHarness();
    const { conversationId } = h;
    await assert.rejects(
      () => h.hub.postMessage({ conversationId, text: "   " }),
      (err: unknown) => err instanceof ValidationError
    );
    await assert.rejects(
      () => h.hub.postMessage({ conversationId, text: "", content: [] }),
      (err: unknown) => err instanceof ValidationError
    );
    const file = await h.reload(conversationId);
    assert.deepEqual(file.messages, []);
  });

  it("masks a secret in a text block and leaves the image payload verbatim", async () => {
    const h = await makeHarness({ secrets: true });
    const { conversationId } = h;
    const rawSecret = `sk-${"C".repeat(30)}`;
    await h.hub.postMessage({
      conversationId,
      text: rawSecret,
      content: [textBlock(rawSecret), imageBlock(secretShapedBase64("B"))],
    });
    const user = firstUserMessage(await h.reload(conversationId));
    const text = textOf(user);
    // The text block WAS masked: a `<<<SECRET_N>>>` placeholder appears in the
    // persisted text. Strength: `textOf` reads ONLY text blocks, and the next
    // assertions show the raw secret is gone while the image block — which is
    // NOT part of `text` — kept its secret-shaped base64 verbatim.
    assert.match(text, /<<<SECRET_\d+>>>/);
    assert.ok(!text.includes(rawSecret), "text secret must be placeholdered");
    assert.equal(imageData(user.content[1]), secretShapedBase64("B"));
  });

  it("applies the 8000 cap to text only, never to an image payload", async () => {
    const h = await makeHarness({ responses: 2 });
    const { conversationId } = h;
    const tooLong = "x".repeat(8001);
    await assert.rejects(
      () =>
        h.hub.postMessage({
          conversationId,
          text: tooLong,
          content: [textBlock(tooLong), imageBlock()],
        }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /message text exceeds max length 8000/);
        // Pin the whole details bag, not just the message: the cap rejection
        // is built by the shared `inputTooLongError` factory, and `length` is
        // the TRIMMED code units (8001 here, no surrounding whitespace).
        assert.equal(err.details?.["field"], "text");
        assert.equal(err.details?.["max"], 8000);
        assert.equal(err.details?.["length"], tooLong.length);
        return true;
      }
    );
    assert.ok(LARGE_PNG_BASE64.length > 8000);
    const res = await h.hub.postMessage({
      conversationId,
      text: "",
      content: [imageBlock(LARGE_PNG_BASE64)],
    });
    // The cap-rejected first post throws at validateUserInput, before the
    // serialize slot runs the engine, so it consumes no stub response: this
    // successful image-only post is the FIRST step the stub model serves.
    assert.equal(res.turn.answer.finalText, "reply-1");
    const file = await h.reload(conversationId);
    assert.equal(imageData(file.messages[0]!.content[0]), LARGE_PNG_BASE64);
  });

  it("keeps the prefetch overlay the first text block and off the image data", async () => {
    const overlay = `${MEMORY_ADVISORY_PREFIX}\n\n### note\nid: n1`;
    const h = await makeHarness({ responses: 2, overlay });
    const { conversationId } = h;
    await h.hub.postMessage({
      conversationId,
      text: "look at this",
      content: [textBlock("look at this"), imageBlock()],
    });
    await h.hub.postMessage({
      conversationId,
      text: "",
      content: [imageBlock()],
    });
    const file = await h.reload(conversationId);
    const mixed = file.messages[0]!;
    assert.deepEqual(
      mixed.content.map((b) => b.type),
      ["text", "image"]
    );
    assert.ok(textOf(mixed).startsWith(MEMORY_ADVISORY_PREFIX));
    assert.ok(textOf(mixed).includes("look at this"));
    assert.equal(imageData(mixed.content[1]), PNG_1X1_BASE64);
    const imageOnly = file.messages[2]!;
    assert.deepEqual(
      imageOnly.content.map((b) => b.type),
      ["text", "image"]
    );
    assert.ok(textOf(imageOnly).startsWith(MEMORY_ADVISORY_PREFIX));
    assert.equal(imageData(imageOnly.content[1]), PNG_1X1_BASE64);
  });

  it("an input accepted while a turn runs drains with its blocks unchanged", async () => {
    const h = await makeHarness({ responses: 2 });
    const { conversationId } = h;
    const first = h.hub.postMessage({
      conversationId,
      text: "one",
      content: [textBlock("one"), imageBlock(PNG_1X1_BASE64)],
    });
    const second = h.hub.postMessage({
      conversationId,
      text: "two",
      content: [imageBlock(secretShapedBase64("B")), textBlock("two")],
    });
    await Promise.all([first, second]);
    const file = await h.reload(conversationId);
    const users = file.messages.filter((m) => m.role === "user");
    assert.equal(users.length, 2);
    assert.deepEqual(users[0]!.content, [textBlock("one"), imageBlock()]);
    assert.deepEqual(users[1]!.content, [
      imageBlock(secretShapedBase64("B")),
      textBlock("two"),
    ]);
    assert.deepEqual(
      file.messages.map((m) => m.role),
      ["user", "assistant", "user", "assistant"]
    );
  });

  it("a string-only caller keeps today's single-text-block record", async () => {
    const h = await makeHarness();
    const { conversationId } = h;
    await h.hub.postMessage({ conversationId, text: "plain question" });
    const file = await h.reload(conversationId);
    assert.deepEqual(firstUserMessage(file).content, [
      { type: "text", text: "plain question" },
    ]);
  });

  it("rejects a content payload submitted alongside a ## GOAL: directive", async () => {
    const h = await makeHarness();
    const { conversationId } = h;
    // A `## GOAL:` turn commits the PARSED body while a block payload commits
    // verbatim; a payload on such a turn would persist the raw `## GOAL: `
    // prefix, so the combination is a typed rejection, not a silent choice.
    await assert.rejects(
      () =>
        h.hub.postMessage({
          conversationId,
          text: "## GOAL: review the diff",
          content: [textBlock("## GOAL: review the diff"), imageBlock()],
        }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /## GOAL/);
        return true;
      }
    );
    const file = await h.reload(conversationId);
    assert.deepEqual(file.messages, [], "a rejected payload persists nothing");
  });

  it("accepts a plain text+image payload when no goal directive is present", async () => {
    const h = await makeHarness();
    const { conversationId } = h;
    await h.hub.postMessage({
      conversationId,
      text: "look at this",
      content: [textBlock("look at this"), imageBlock()],
    });
    const user = firstUserMessage(await h.reload(conversationId));
    assert.deepEqual(
      user.content.map((b) => b.type),
      ["text", "image"]
    );
    assert.ok(textOf(user).includes("look at this"));
    assert.equal(imageData(user.content[1]), PNG_1X1_BASE64);
  });

  it("refuses a block payload before persisting or dispatching when the adapter has no block encoder", async () => {
    // The admission arm for a host that never learned about image payloads:
    // falling back to `encodeUserText` would persist the text and drop the
    // attachment, so this has to be a typed rejection with no history and no
    // model request behind it.
    const h = await makeHarness({ blockEncoder: false });
    const { conversationId } = h;
    await assert.rejects(
      () =>
        h.hub.postMessage({
          conversationId,
          text: "look at this",
          content: [textBlock("look at this"), imageBlock()],
        }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.details?.["field"], "content");
        return true;
      }
    );
    assert.deepEqual(
      h.engineInputs,
      [],
      "a refused payload never reaches the model"
    );
    const file = await h.reload(conversationId);
    assert.deepEqual(file.messages, [], "a refused payload persists nothing");
  });
});
