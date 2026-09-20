/**
 * SessionSidebar internal icon set.
 *
 * 16×16 / 12×12 stroked SVGs following the project's stroke=currentColor /
 * strokeWidth convention: the parent's text-* class sets the color. Stateless
 * and dependency-free; importable anywhere in SessionSidebar / grouped-view / hooks.
 *
 * `ChevronRightIcon` + `ChevronDownIcon` differed only in
 * polyline rotation direction, merged into `ChevronIcon({ direction })`;
 * direction switches via distinct `<polyline>` points (keeps the original
 * polyline shape without CSS rotate, avoiding strokeWidth / size distortion
 * across directions). `ChevronLeftIcon` stays separate — shape does not coincide.
 */
import type { JSX } from "react";

export function PlusIcon(): JSX.Element {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function RefreshIcon(): JSX.Element {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1 2.12-9.36L23 10" />
    </svg>
  );
}

export function ChevronLeftIcon(): JSX.Element {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

/**
 * Generic chevron (merged Right/Down). `direction` picks the three-point
 * polyline path:
 *  - "right" → 9,6 → 15,12 → 9,18 (top-left → mid-right → bottom-left, " > " shape)
 *  - "down"  → 6,9 → 12,15 → 18,9 (top-left → bottom-mid → top-right, " v " shape)
 *
 * Defaults 12×12 / strokeWidth=2, matching the original `ChevronDownIcon`;
 * "right" reuses the same size, and callers decide whether to add
 * `transition-transform` on the parent for rotation animation (grouped-view
 * switches via `-rotate-90` / `rotate-0`).
 */
export function ChevronIcon({
  direction,
}: {
  direction: "right" | "down";
}): JSX.Element {
  const points = direction === "down" ? "6 9 12 15 18 9" : "9 6 15 12 9 18";
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points={points} />
    </svg>
  );
}
