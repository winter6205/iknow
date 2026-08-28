import type { ScrollAcceleration } from "@opentui/core";

/**
 * OpenTUI 默认 LinearScrollAccel.tick = 1，终端滚轮 delta 也是 1 →
 * 每格 1 行。长 transcript 太慢；3 行/格略快、不飞。
 */
export const CHAT_WHEEL_SCROLL_MULTIPLIER = 3;

export const chatWheelScrollAccel: ScrollAcceleration = {
  tick(): number {
    return CHAT_WHEEL_SCROLL_MULTIPLIER;
  },
  reset(): void {},
};
