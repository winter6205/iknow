/** @jsxImportSource @opentui/react */
/**
 * src/tui/components.tsx
 *
 * Minimal shared primitive set (no premature abstraction):
 *  - Separator: full-width horizontal rule;
 *  - StatusLine: single status / hint line (dim secondary colour by default);
 *  - Spinner: 80ms/frame braille-dot rotation driven by `useTick`.
 *    PromptInput lives elsewhere (no input-box logic in this file).
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { tuiPalette } from "./theme.js";

/** Full-width separator: a 1-row box painted with the border colour. */
export function Separator(): ReactNode {
  return <box height={1} width="100%" backgroundColor={tuiPalette.border} />;
}

export interface StatusLineProps {
  readonly text: string;
  /** Semantic colour override (default dim; error hints pass tuiPalette.error etc.). */
  readonly fg?: string;
}

/** Single status line: shared by the status bar / error hints / slash feedback. */
export function StatusLine(props: StatusLineProps): ReactNode {
  return <text fg={props.fg ?? tuiPalette.dim}>{props.text}</text>;
}

/** Braille-dot rotation frames (80ms/frame; foreground dynamic indicator, no emoji).
 *  Frame order is the single source from archive/tui-ink/src/components.tsx SPINNER_FRAMES. */
export const SPINNER_FRAMES: ReadonlyArray<string> = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/** 100ms heartbeat: returns an auto-incrementing frame number, driving spinner / animation
 *  re-renders. periodMs <= 0 = disabled tier (no timer armed, avoiding 0ms busy polling;
 *  hooks order unchanged). Simplified form (drops the redundant archive useRef path), 80ms period. */
export function useTick(periodMs = 100): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (periodMs <= 0) return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return tick;
}

/** Spinner — simplified form (running state with no label passed defaults to "运行中…"). */
export function Spinner(props: { readonly label?: string }): ReactNode {
  const tick = useTick(80);
  const idx = tick % SPINNER_FRAMES.length;
  const frame = SPINNER_FRAMES[idx] ?? "⠋";
  return (
    <text fg={tuiPalette.running} wrapMode="none">
      {`${frame} ${props.label ?? "运行中…"}`}
    </text>
  );
}
