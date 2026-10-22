/**
 * The dangerous gate: the token estimator must price an image by pixels, not
 * by its base64 length.
 *
 * `estimateMessagesTokens` switches over the block union with no default arm,
 * so an unrecognized block type contributed 0 without throwing. A user-pasted
 * image would therefore have looked free to autocompact, under-reporting real
 * context occupancy for the whole session.
 *
 * The provider prices an image by decoded dimensions, and the estimator sees
 * only base64 text. These cases pin the pixel formula's observable properties
 * (same dimensions → same estimate, larger dimensions → larger estimate) plus
 * the fail-closed ceiling and the nested `tool_result` arm.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { estimateMessagesTokens } from "../../../src/harness/compress/estimate.ts";
import {
  TOKEN_ESTIMATION_PADDING,
  VISION_IMAGE_TOKEN_CEILING,
} from "../../../src/harness/compress/constant.ts";
import { estimateImageTokensFromBase64 } from "../../../src/harness/compress/image-tokens.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/model-adapter/types.ts";

function pngBase64(width: number, height: number, tailBytes = 0): string {
  const ihdr = [
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52, // "IHDR"
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
    8,
    6,
    0,
    0,
    0,
  ];
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr];
  for (let i = 0; i < tailBytes; i++) bytes.push(0x41);
  return Buffer.from(bytes).toString("base64");
}

const imageMsg = (data: unknown): AnthropicNativeMessage =>
  ({
    role: "user",
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data },
      },
    ],
  }) as unknown as AnthropicNativeMessage;

const expected = (imageTokens: number): number =>
  Math.ceil(imageTokens * TOKEN_ESTIMATION_PADDING);

describe("an image is priced by pixel dimensions", () => {
  it("same dimensions → same estimate even when the payload length differs", () => {
    const bare = pngBase64(270, 270);
    const padded = pngBase64(270, 270, 40_000);

    assert.notEqual(bare.length, padded.length);
    assert.equal(estimateImageTokensFromBase64(bare), 97);
    assert.equal(estimateImageTokensFromBase64(padded), 97);
    assert.equal(
      estimateMessagesTokens([imageMsg(bare)]),
      estimateMessagesTokens([imageMsg(padded)])
    );
  });

  it("larger dimensions → larger estimate", () => {
    const small = estimateMessagesTokens([imageMsg(pngBase64(270, 270))]);
    const large = estimateMessagesTokens([imageMsg(pngBase64(1024, 410))]);
    assert.ok(
      large > small,
      `expected ${large} > ${small}: occupancy must grow with pixels`
    );
  });

  it("base64 length is not the cost driver", () => {
    const header = pngBase64(16, 16);
    const huge = (header + "A".repeat(286_876)).slice(0, 286_876);
    assert.equal(estimateMessagesTokens([imageMsg(huge)]), expected(1));
    assert.equal(estimateMessagesTokens([imageMsg(header)]), expected(1));
  });

  it("an image beside text adds inside one padding step", () => {
    const data = pngBase64(270, 270);
    const withText = estimateMessagesTokens([
      {
        role: "user",
        content: [
          { type: "text", text: "hello world" },
          imageMsg(data).content[0]!,
        ],
      } as unknown as AnthropicNativeMessage,
    ]);
    // text = floor((11 + 3) / 4) = 3; image = 97; padded once at the end.
    assert.equal(withText, expected(97 + 3));
  });
});

describe("malformed image payloads fail closed at the ceiling", () => {
  // An externally polluted transcript must not regain the silent-zero property,
  // and an unreadable header must not read as a small text block: the ceiling
  // is the bounded non-zero value.
  for (const [label, data] of [
    ["data missing", undefined],
    ["data is a number", 12345],
    ["data is null", null],
    ["not an image", "not-an-image-payload"],
    ["empty", ""],
  ] as ReadonlyArray<[string, unknown]>) {
    it(`${label} → ceiling`, () => {
      assert.equal(
        estimateMessagesTokens([imageMsg(data)]),
        expected(VISION_IMAGE_TOKEN_CEILING)
      );
    });
  }

  it("a message whose image block carries no source object is not free", () => {
    const msg = {
      role: "user",
      content: [{ type: "image" }],
    } as unknown as AnthropicNativeMessage;
    assert.equal(
      estimateMessagesTokens([msg]),
      expected(VISION_IMAGE_TOKEN_CEILING)
    );
  });
});

describe("a nested tool_result image is counted", () => {
  it("charges the same pixel estimate as a top-level block", () => {
    const data = pngBase64(1024, 410);
    const nested: AnthropicNativeMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-image-1",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data },
              },
            ],
          },
        ],
      },
    ];
    assert.equal(estimateMessagesTokens(nested), expected(560));
    assert.ok(
      estimateMessagesTokens(nested) > 1,
      "nested images must not fall back to the 1-token default"
    );
  });
});
