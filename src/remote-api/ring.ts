/**
 * Bounded seat event ring (spec specs/remote-sync.md §5.6, §5.7).
 *
 * The ring owns exactly two things: the per-instance `seq` counter and the
 * retention window (2,000 events / 4 MiB by default). It is instance-agnostic
 * on purpose — whether a client gets a catch-up replay or a snapshot is the
 * host's decision, made from `instanceId`, `oldestSeq` and `sinceSeq`.
 */
import type { SeatEvent } from "./protocol.js";

export const DEFAULT_SEAT_RING_MAX_EVENTS = 2000;
export const DEFAULT_SEAT_RING_MAX_BYTES = 4 * 1024 * 1024;

export interface SeatEventRingOptions {
  maxEvents?: number;
  maxBytes?: number;
}

export interface SeatEventRing {
  push(event: Omit<SeatEvent, "seq">): SeatEvent;
  readonly oldestSeq: number | undefined;
  readonly latestSeq: number;
  replaySince(sinceSeq: number): readonly SeatEvent[];
  readonly size: number;
}

interface RetainedEvent {
  readonly event: SeatEvent;
  readonly bytes: number;
}

export function createSeatEventRing(
  opts: SeatEventRingOptions = {}
): SeatEventRing {
  const maxEvents = opts.maxEvents ?? DEFAULT_SEAT_RING_MAX_EVENTS;
  const maxBytes = opts.maxBytes ?? DEFAULT_SEAT_RING_MAX_BYTES;
  const retained: RetainedEvent[] = [];
  let nextSeq = 1;
  let totalBytes = 0;

  return {
    push(event: Omit<SeatEvent, "seq">): SeatEvent {
      const stored: SeatEvent = { seq: nextSeq, ...event };
      nextSeq += 1;
      // UTF-8 JSON of the stored envelope: the same bytes a catch-up replay
      // would put on the wire, so the byte cap tracks real socket pressure.
      const bytes = Buffer.byteLength(JSON.stringify(stored), "utf8");
      retained.push({ event: stored, bytes });
      totalBytes += bytes;
      // Trim from the front until both caps hold. The newest event always
      // stays: a single event larger than the byte cap must still be
      // replayable, otherwise the client would see a gap it cannot detect.
      while (
        retained.length > 1 &&
        (retained.length > maxEvents || totalBytes > maxBytes)
      ) {
        const dropped = retained.shift();
        if (dropped) totalBytes -= dropped.bytes;
      }
      return stored;
    },

    get oldestSeq(): number | undefined {
      return retained.length === 0 ? undefined : retained[0]!.event.seq;
    },

    get latestSeq(): number {
      return nextSeq - 1;
    },

    replaySince(sinceSeq: number): readonly SeatEvent[] {
      const out: SeatEvent[] = [];
      for (const item of retained) {
        if (item.event.seq > sinceSeq) out.push(item.event);
      }
      return out;
    },

    get size(): number {
      return retained.length;
    },
  };
}
