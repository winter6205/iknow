import type { ScrollAcceleration } from "@opentui/core";

/**
 * OpenTUI's default LinearScrollAccel ticks 1 line per wheel notch, which is
 * too slow for long transcripts; 4 lines per notch is brisk without flying.
 */
export const CHAT_WHEEL_SCROLL_MULTIPLIER = 4;

export const chatWheelScrollAccel: ScrollAcceleration = {
  tick(): number {
    return CHAT_WHEEL_SCROLL_MULTIPLIER;
  },
  reset(): void {},
};
