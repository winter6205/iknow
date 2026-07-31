import type { CSSProperties } from "react";

/** 消息入场 stagger 内联样式：--i 驱动 animationDelay = calc(var(--i)*70ms)。 */
export function staggerStyle(index: number): CSSProperties {
  return {
    "--i": index,
    animationDelay: "calc(var(--i, 0) * 70ms)",
  } as CSSProperties;
}
