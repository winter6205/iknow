import type { CSSProperties } from "react";

/** Message-entry stagger inline style: --i drives animationDelay = calc(var(--i)*70ms). */
export function staggerStyle(index: number): CSSProperties {
  return {
    "--i": index,
    animationDelay: "calc(var(--i, 0) * 70ms)",
  } as CSSProperties;
}
