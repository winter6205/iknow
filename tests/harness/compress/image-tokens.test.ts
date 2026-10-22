/**
 * Pixel-based image token estimation (Plan A / Task 1).
 *
 * The provider prices an image by its decoded dimensions (`width * height`
 * scaled by 750), not by the base64 character count. These cases pin the
 * header-only decoder: PNG IHDR, JPEG SOF0/1/2, GIF logical screen descriptor,
 * WebP VP8X/VP8L, the 1568-px long-edge rescale, the ceiling clamp, and the
 * fail-closed rule for malformed / unknown / truncated payloads.
 *
 * Numbers are raw (pre-padding): `estimateMessagesTokens` applies 4/3 to the
 * message total, so the message-level cases below assert the padded value.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { estimateImageTokensFromBase64 } from "../../../src/harness/compress/image-tokens.ts";
import { estimateMessagesTokens } from "../../../src/harness/compress/estimate.ts";
import {
  TOKEN_ESTIMATION_PADDING,
  VISION_IMAGE_TOKEN_CEILING,
} from "../../../src/harness/compress/constant.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/model-adapter/types.ts";

function base64(bytes: readonly number[]): string {
  return Buffer.from(bytes).toString("base64");
}

/** PNG signature + IHDR chunk with the given dimensions. 24 bytes total: the
 *  decoder never needs the rest of the file, so no IDAT/CRC is emitted. */
function pngBase64(width: number, height: number, tailBytes = 0): string {
  const ihdr = [
    0,
    0,
    0,
    13, // chunk length
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
    8, // bit depth
    6, // color type
    0,
    0,
    0, // compression / filter / interlace
  ];
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr];
  for (let i = 0; i < tailBytes; i++) bytes.push(0x41);
  return base64(bytes);
}

/** JPEG SOI + an APP0 segment to skip + SOF0 carrying the dimensions. */
function jpegBase64(width: number, height: number): string {
  return base64([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x10, // APP0, length 16 (14 payload bytes)
    ...Array<number>(14).fill(0),
    0xff,
    0xc0,
    0x00,
    0x11, // SOF0, length 17
    0x08, // precision
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    3, // components
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
}

function gifBase64(width: number, height: number): string {
  return base64([
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61, // "GIF89a"
    width & 0xff,
    (width >>> 8) & 0xff,
    height & 0xff,
    (height >>> 8) & 0xff,
  ]);
}

function webpVp8xBase64(width: number, height: number): string {
  const w = width - 1;
  const h = height - 1;
  return base64([
    0x52,
    0x49,
    0x46,
    0x46, // "RIFF"
    0,
    0,
    0,
    0,
    0x57,
    0x45,
    0x42,
    0x50, // "WEBP"
    0x56,
    0x50,
    0x38,
    0x58, // "VP8X"
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0, // flags + reserved
    w & 0xff,
    (w >>> 8) & 0xff,
    (w >>> 16) & 0xff,
    h & 0xff,
    (h >>> 8) & 0xff,
    (h >>> 16) & 0xff,
  ]);
}

function webpVp8lBase64(width: number, height: number): string {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return base64([
    0x52,
    0x49,
    0x46,
    0x46, // "RIFF"
    0,
    0,
    0,
    0,
    0x57,
    0x45,
    0x42,
    0x50, // "WEBP"
    0x56,
    0x50,
    0x38,
    0x4c, // "VP8L"
    5,
    0,
    0,
    0,
    0x2f, // signature byte
    bits & 0xff,
    (bits >>> 8) & 0xff,
    (bits >>> 16) & 0xff,
    (bits >>> 24) & 0xff,
  ]);
}

const padded = (raw: number): number =>
  Math.ceil(raw * TOKEN_ESTIMATION_PADDING);

const imageMsg = (data: string): AnthropicNativeMessage => ({
  role: "user",
  content: [
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data },
    },
  ],
});

describe("pixel estimate from a bounded header prefix", () => {
  it("PNG 270x270 → 97 tokens raw (ceil/round of 270*270/750)", () => {
    assert.equal(estimateImageTokensFromBase64(pngBase64(270, 270)), 97);
  });

  it("PNG 1024x410 → 560 tokens raw", () => {
    assert.equal(estimateImageTokensFromBase64(pngBase64(1024, 410)), 560);
  });

  it("base64 length does not dominate: a 286,876-char 16x16 payload → 1 token", () => {
    const header = pngBase64(16, 16);
    const data = (header + "A".repeat(286_876)).slice(0, 286_876);
    assert.equal(data.length, 286_876);
    assert.equal(estimateImageTokensFromBase64(data), 1);
  });

  it("JPEG SOF0 dimensions are read", () => {
    assert.equal(estimateImageTokensFromBase64(jpegBase64(640, 480)), 410);
  });

  it("GIF logical screen descriptor dimensions are read", () => {
    assert.equal(estimateImageTokensFromBase64(gifBase64(200, 100)), 27);
  });

  it("WebP VP8X canvas dimensions are read", () => {
    assert.equal(estimateImageTokensFromBase64(webpVp8xBase64(800, 600)), 640);
  });

  it("WebP VP8L packed dimensions are read", () => {
    assert.equal(estimateImageTokensFromBase64(webpVp8lBase64(400, 300)), 160);
  });

  it("a long edge over 1568 px is scaled down before pricing", () => {
    // 3136x100 -> 1568x50 -> round(1568*50/750) = 105.
    assert.equal(estimateImageTokensFromBase64(pngBase64(3136, 100)), 105);
  });

  it("an image larger than the ceiling clamp is bounded at 3072", () => {
    assert.equal(
      estimateImageTokensFromBase64(pngBase64(4000, 4000)),
      VISION_IMAGE_TOKEN_CEILING
    );
  });
});

describe("malformed / unknown / truncated payloads fail closed", () => {
  for (const [label, data] of [
    ["not an image", "not-an-image-payload"],
    ["empty", ""],
    [
      "truncated JPEG prefix (no SOF)",
      base64([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0, 0]),
    ],
    [
      // A `FF C0` inside entropy-coded scan data is a stuffed byte, not a
      // frame header: once SOS is reached without an SOF, fail closed.
      "JPEG reaching SOS with no SOF (stuffed FF C0 in the scan data)",
      base64([
        0xff,
        0xd8, // SOI
        0xff,
        0xda,
        0x00,
        0x02, // SOS, length 2 → scan data starts at offset 6
        0xff,
        0xc0,
        0x00,
        0x11,
        0x08,
        0x01,
        0xe0,
        0x02,
        0x80, // stuffed "SOF0"
      ]),
    ],
    [
      "PNG without a full IHDR",
      base64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ],
    [
      "WebP with a non-extended VP8 chunk",
      base64([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
        0x38, 0x20, 4, 0, 0, 0, 0x9d, 0x01, 0x2a, 0,
      ]),
    ],
  ] as ReadonlyArray<[string, string]>) {
    it(`${label} → ceiling`, () => {
      assert.equal(
        estimateImageTokensFromBase64(data),
        VISION_IMAGE_TOKEN_CEILING
      );
    });
  }
});

describe("message-level integration", () => {
  it("a nested tool_result image is priced by pixels, not as 1 token", () => {
    const messages: AnthropicNativeMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: pngBase64(270, 270),
                },
              },
            ],
          },
        ],
      },
    ];
    assert.equal(estimateMessagesTokens(messages), padded(97));
    assert.ok(estimateMessagesTokens(messages) > 1);
  });

  it("a top-level image is priced the same way", () => {
    assert.equal(
      estimateMessagesTokens([imageMsg(pngBase64(1024, 410))]),
      padded(560)
    );
  });
});

describe("countThinking option", () => {
  const thinkingMsg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "x".repeat(400),
        signature: "sig",
      },
    ],
  };

  it("default keeps thinking at 0 (summary-tail / history behavior unchanged)", () => {
    assert.equal(estimateMessagesTokens([thinkingMsg]), 0);
    assert.equal(
      estimateMessagesTokens([thinkingMsg], { countThinking: false }),
      0
    );
  });

  it("opt-in counts thinking and redacted_thinking blocks", () => {
    const raw = Math.floor((400 + 3) / 4) + Math.floor((900 + 3) / 4); // 100 + 225
    const messages: AnthropicNativeMessage[] = [
      thinkingMsg,
      {
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "y".repeat(900) }],
      },
    ];
    assert.equal(
      estimateMessagesTokens(messages, { countThinking: true }),
      padded(raw)
    );
  });
});
