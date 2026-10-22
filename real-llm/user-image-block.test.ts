// REAL_LLM: user-pasted top-level image block — real-model half of the composer
// image set (roster row: docs/guides/prompt-development.md).
//
// What it locks: a `type: "image"` block on a USER message — not nested inside
// a tool_result — reaches a real provider through the production outbound
// projection (`createAdapterFromEnv` → `projectMessagesForWire` → SDK), and the
// model answers about the PIXELS. The prompt names no colour anywhere, so a
// reply that says red is evidence the image was read, not text the model was
// handed. A label or a description would pass a weaker assertion; this one is
// decided by a value the request never contains.
//
// The PNG is generated in code (solid 4x4, colour type 2, a few hundred bytes)
// and travels as the block's `source.data` — the same base64 shape the TUI
// paste path hands the store. No user data, no file on disk, no clipboard.
//
// No key → Not run (explicit, never a hidden pass). A provider that refuses the
// image is a real failure of THIS surface, so it reports the provider's own
// error rather than folding into Not run. Tracked in TRACKED_INCLUDE of
// vitest.real-llm.config.ts; run via `npm run test:real-llm`.
import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { createAdapterFromEnv } from "../src/harness/build-engine.ts";
import type { LoopState } from "../src/harness/model-adapter/types.ts";
import { type IknowEnv } from "../src/config/env.ts";
import { loadRealLlmEnv } from "./real-llm-env.ts";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

// A throwing load must surface at collection, not masquerade as a skip.
const realEnv = loadRealLlmEnv(REPO_ROOT);
const HAS_KEY = realEnv !== undefined;
if (!HAS_KEY) console.log("[SKIP] LLM key not set; Not run");

// -- a tiny solid-colour PNG, generated ---------------------------------------

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

/** One solid RGB colour as a legal PNG (8-bit colour type 2), base64-encoded. */
function solidPngBase64(size: number, rgb: readonly [number, number, number]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const scanlines = Buffer.alloc(size * (1 + size * 3));
  for (let row = 0; row < size; row++) {
    const start = row * (1 + size * 3);
    scanlines[start] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      scanlines.set(rgb, start + 1 + x * 3);
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

// -- the run ------------------------------------------------------------------

(HAS_KEY ? describe : describe.skip)(
  "user-pasted image block — real model",
  () => {
    it("the model names the colour it can only have seen", async () => {
      const data = solidPngBase64(4, [255, 0, 0]);
      expect(
        Buffer.from(data, "base64").subarray(0, 8).toString("hex")
      ).toEqual("89504e470d0a1a0a");

      const { adapter } = createAdapterFromEnv(realEnv as IknowEnv);
      const state: LoopState = {
        turnCount: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Reply with exactly one word: the colour of this image.",
              },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data },
              },
            ],
          },
        ],
      };

      const turn = await adapter.step(state, {});
      const answer = turn.projection.texts.join(" ").toLowerCase();
      expect(
        answer,
        `model answered ${JSON.stringify(answer)} for a red 4x4 PNG`
      ).toMatch(/red/);
    }, 360_000);
  }
);
