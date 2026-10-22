/**
 * NDJSON frame decoder (spec specs/remote-sync.md §5.1).
 *
 * Socket chunks split anywhere — including inside a UTF-8 multibyte sequence
 * — so the decoder buffers raw bytes and only decodes complete LF-delimited
 * line bodies. `\n` is 0x0A, which never appears inside a UTF-8 continuation
 * byte, so byte-wise splitting cannot corrupt a character.
 *
 * The frame cap is enforced before the terminating newline arrives as well:
 * an unterminated buffer over the cap is already an oversized frame, and
 * waiting for the newline would let a client make the server buffer without
 * bound. Once overflowed the decoder is terminal; the server sends
 * `frame_too_large` and closes that connection.
 */

export interface NdjsonDecoderOptions {
  maxLineBytes: number;
}

export interface NdjsonPushResult {
  lines: readonly string[];
  overflow?: true;
}

export interface NdjsonDecoder {
  push(chunk: Buffer | string): NdjsonPushResult;
}

const LF = 0x0a;
const EMPTY = Buffer.alloc(0);

function toBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
}

export function createNdjsonDecoder(opts: NdjsonDecoderOptions): NdjsonDecoder {
  const maxLineBytes = opts.maxLineBytes;
  let buffer: Buffer = EMPTY;
  let overflowed = false;

  return {
    push(chunk: Buffer | string): NdjsonPushResult {
      if (overflowed) return { lines: [], overflow: true };
      const incoming = toBuffer(chunk);
      if (incoming.length > 0) {
        buffer =
          buffer.length === 0
            ? incoming
            : Buffer.concat(
                [buffer, incoming],
                buffer.length + incoming.length
              );
      }
      const lines: string[] = [];
      let start = 0;
      for (;;) {
        if (start > buffer.length) break;
        const newline = buffer.indexOf(LF, start);
        if (newline === -1) break;
        if (newline - start > maxLineBytes) {
          overflowed = true;
          buffer = EMPTY;
          return { lines, overflow: true };
        }
        lines.push(buffer.subarray(start, newline).toString("utf8"));
        start = newline + 1;
      }
      if (start > 0) {
        buffer =
          start >= buffer.length ? EMPTY : Buffer.from(buffer.subarray(start));
      }
      if (buffer.length > maxLineBytes) {
        overflowed = true;
        buffer = EMPTY;
        return { lines, overflow: true };
      }
      return { lines };
    },
  };
}
