// REAL_LLM: image token cost calibration (Plan A, context occupancy).
//
// What it locks: through the production real route, an image block costs
// pixel-scale tokens, not base64-length tokens. The plan's evidence shows a
// gateway `countTokens` charging base64/4 (~70k for one screenshot); the
// client-side estimator must not reproduce that. Two live calls — the same
// prompt with and without one synthetic PNG — and the occupancy delta
// (`inputTokens + cacheRead + cacheCreation`, the production formula) must
// stay small and within 4x the pixel estimate.
//
// The PNG is generated deterministically in code (seeded pseudo-random RGB,
// 800x600, incompressible) and travels as base64. No file on disk, no user
// image, no user data. The base64 length is asserted large so the "charge
// len/4" failure mode would blow past the delta bound.
//
// No key -> Not run (explicit, never a hidden pass). Tracked in
// TRACKED_INCLUDE of vitest.real-llm.config.ts; run via `npm run test:real-llm`.
import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { createAdapterFromEnv } from "../src/harness/build-engine.ts";
import { occupancyFromUsage } from "../src/harness/compress/occupancy.ts";
import type { IknowEnv } from "../src/config/env.ts";
import type {
  AnthropicContentBlock,
  AssistantTurnResult,
  LoopState,
  TokenUsage,
} from "../src/harness/model-adapter/types.ts";
import { loadRealLlmEnv } from "./real-llm-env.ts";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

// A throwing load must surface at collection, not masquerade as a skip.
const realEnv = loadRealLlmEnv(REPO_ROOT);
const HAS_KEY = realEnv !== undefined;
if (!HAS_KEY) console.log("[SKIP] LLM key not set; Not run");

const WIDTH = 800;
const HEIGHT = 600;
// Long edge <= 1568, so the pixel estimate is the raw w*h/750 form.
const PIXEL_ESTIMATE = Math.ceil((WIDTH * HEIGHT) / 750);
// Cost bound: two calls, one word of output, no thinking.
const MAX_OUTPUT_TOKENS = 16;
const PROMPT = "Reply with exactly one word: ok.";

// -- a deterministic noise PNG, generated -------------------------------------

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([head, name, data, tail]);
}

/** Deterministic pseudo-random bytes (LCG), so the PNG content is fixed. */
function seededBytes(seed: number, count: number): Buffer {
  const out = Buffer.alloc(count);
  let s = seed >>> 0;
  for (let i = 0; i < count; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

/** A seeded-noise truecolour PNG (8-bit, colour type 2), base64-encoded. */
function noisePngBase64(width: number, height: number, seed: number): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const rgb = seededBytes(seed, width * height * 3);
  const stride = 1 + width * 3;
  const scanlines = Buffer.alloc(height * stride);
  for (let row = 0; row < height; row++) {
    // scanlines[row * stride] stays 0: filter "none".
    rgb.copy(
      scanlines,
      row * stride + 1,
      row * width * 3,
      (row + 1) * width * 3
    );
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

// -- adapter helpers ----------------------------------------------------------

function usageOf(turn: AssistantTurnResult): TokenUsage {
  if (turn.usage === undefined) {
    // EXIT: provider returned no usage -> the measurement cannot exist
    throw new Error(
      "provider returned no usage; image delta cannot be measured"
    );
  }
  return turn.usage;
}

async function callOnce(
  adapter: ReturnType<typeof createAdapterFromEnv>["adapter"],
  content: ReadonlyArray<AnthropicContentBlock>
): Promise<TokenUsage> {
  const state: LoopState = {
    turnCount: 0,
    messages: [{ role: "user", content }],
  };
  const turn = await adapter.step(state, {});
  return usageOf(turn);
}

// -- the run ------------------------------------------------------------------

(HAS_KEY ? describe : describe.skip)("image token cost — real model", () => {
  it("charges the image at pixel scale, not base64/4", async () => {
    const data = noisePngBase64(WIDTH, HEIGHT, 0x5eed1234);
    const textChargeWouldBe = Math.ceil(data.length / 4);
    // The failure mode this file exists to catch needs a big payload.
    expect(data.length).toBeGreaterThan(1_000_000);
    expect(textChargeWouldBe).toBeGreaterThan(10_000);

    const env = realEnv as IknowEnv;
    const { adapter } = createAdapterFromEnv(
      { llm: { ...env.llm, routeMaxTokens: MAX_OUTPUT_TOKENS } },
      { thinking: { mode: "off" } }
    );

    const textUsage = await callOnce(adapter, [{ type: "text", text: PROMPT }]);
    const imageUsage = await callOnce(adapter, [
      { type: "text", text: PROMPT },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data },
      },
    ]);

    const textOccupancy = occupancyFromUsage(textUsage);
    const imageOccupancy = occupancyFromUsage(imageUsage);
    const delta = imageOccupancy - textOccupancy;
    console.log(
      `[image-token-cost] base64=${data.length} chars ` +
        `(text charge would be ~${textChargeWouldBe} tokens); ` +
        `text occupancy=${textOccupancy}; image occupancy=${imageOccupancy}; ` +
        `delta=${delta}; pixel estimate=${PIXEL_ESTIMATE}`
    );

    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(10_000);
    expect(delta).toBeLessThanOrEqual(4 * PIXEL_ESTIMATE);
  }, 360_000);
});
