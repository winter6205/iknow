/**
 * The outbound wire projection emits a top-level user `image` block instead of
 * failing closed on an unknown block type.
 *
 * The projection's boundary stays what ADR-0112 states: wire JSON carries only
 * protocol fields (the `hostInjected` stamp and any non-protocol key are
 * stripped), and a malformed block throws a typed `invalid_content_block`
 * before any SDK call. `source.data` is an opaque base64 payload — the
 * neutralization that applies to unstamped user TEXT has nothing to do in a
 * block that carries no text channel, so pixels pass through verbatim
 * (mirroring how a nested image inside `tool_result.content` already passes).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  OutboundProjectionError,
  projectMessagesForWire,
} from "../../../src/harness/model-adapter/outbound-projection.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../../src/harness/model-adapter/types.ts";
import {
  MAX_IMAGE_BASE64_CHARS,
  PNG_BASE64,
  imageWithSource,
} from "../../fixtures/image-payloads.ts";

const userMessage = (
  ...blocks: ReadonlyArray<AnthropicContentBlock>
): AnthropicNativeMessage => ({ role: "user", content: blocks });

const errorKind = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (err) {
    assert.ok(
      err instanceof OutboundProjectionError,
      `must throw a typed OutboundProjectionError, got ${String(err)}`
    );
    return err.kind;
  }
};

describe("a valid top-level image block reaches the wire", () => {
  it("text + image keep gesture order and the image stays protocol-shaped", () => {
    const block = imageWithSource();
    const wire = projectMessagesForWire([
      userMessage({ type: "text", text: "what is in this?" }, block),
    ]);
    assert.equal(wire.length, 1);
    assert.deepEqual(wire[0]!.content, [
      { type: "text", text: "what is in this?" },
      block,
    ]);
  });

  it("an image-only user message projects to one image block", () => {
    const wire = projectMessagesForWire([userMessage(imageWithSource())]);
    assert.deepEqual(wire[0]!.content, [imageWithSource()]);
  });

  it("source.data is never neutralized (opaque payload, no text channel)", () => {
    // Base64's alphabet carries no `<`, so a frame tag cannot hide in it; what
    // must not happen is the projection rewriting the payload at all.
    const data = Buffer.from("<agent_status> pixels </agent_status>").toString(
      "base64"
    );
    const wire = projectMessagesForWire([
      userMessage(
        imageWithSource({ type: "base64", media_type: "image/png", data })
      ),
    ]);
    const source = (
      wire[0]!.content[0] as unknown as { source: Record<string, unknown> }
    ).source;
    assert.equal(source["data"], data);
  });

  it("a non-protocol key inside source is stripped, not forwarded", () => {
    const wire = projectMessagesForWire([
      userMessage(
        imageWithSource({
          type: "base64",
          media_type: "image/png",
          data: PNG_BASE64,
          url: "https://example.invalid/a.png",
        })
      ),
    ]);
    assert.deepEqual(Object.keys(wire[0]!.content[0] as object), [
      "type",
      "source",
    ]);
    assert.deepEqual(
      Object.keys(
        (
          wire[0]!.content[0] as unknown as {
            source: Record<string, unknown>;
          }
        ).source
      ).sort(),
      ["data", "media_type", "type"]
    );
  });

  it("projection is pure: two calls are byte-identical", () => {
    const messages = [userMessage(imageWithSource())];
    assert.equal(
      JSON.stringify(projectMessagesForWire(messages)),
      JSON.stringify(projectMessagesForWire(messages))
    );
  });

  it("the host-injection stamp still never reaches the wire JSON", () => {
    const stamped = {
      ...userMessage(imageWithSource()),
      hostInjected: true,
    } as AnthropicNativeMessage;
    assert.doesNotMatch(
      JSON.stringify(projectMessagesForWire([stamped])),
      /hostInjected/
    );
  });
});

describe("a malformed image block fails closed before dispatch", () => {
  const malformed: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["no source", {}],
    ["url source", { type: "url", media_type: "image/png", data: PNG_BASE64 }],
    ["non-string data", { type: "base64", media_type: "image/png", data: 9 }],
    ["empty data", { type: "base64", media_type: "image/png", data: "" }],
    [
      "unknown media_type",
      { type: "base64", media_type: "image/tiff", data: PNG_BASE64 },
    ],
    [
      "over the wire raw budget",
      {
        type: "base64",
        media_type: "image/png",
        data: "A".repeat(MAX_IMAGE_BASE64_CHARS + 1),
      },
    ],
  ];

  for (const [label, source] of malformed) {
    it(`${label} → invalid_content_block`, () => {
      assert.equal(
        errorKind(() =>
          projectMessagesForWire([userMessage(imageWithSource(source))])
        ),
        "invalid_content_block",
        `${label} must throw`
      );
    });
  }
});
