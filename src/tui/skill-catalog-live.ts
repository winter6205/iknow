/**
 * Hot-reload of the TUI slash candidate surface, per the skill-index-increment
 * spec: new skills become loadable while the session is running.
 *
 * Why this hook exists: `TuiExtensions.skillCatalog` is a one-shot scan taken
 * at assembly time (`run.tsx` injects it through `buildTuiDeps`' onExtensions
 * and props pass it statically down to `TuiApp`). After a SKILL.md lands
 * mid-session (written by the user, by a tool outside `/`, or by a plugin
 * directory), the candidate surface has **no refresh path** — new entries stay
 * invisible for the whole session. The requirement: at install/reload time the
 * slash candidates already include the new loadable entry, without waiting for
 * the next turn.
 *
 * This hook treats "the slash palette opened" as the observable now: on the
 * rising edge it runs `rescan()` and swaps in the current loadable face. The
 * model-side delta is a separate path (`skillIndexDelta`) — human and model
 * read paths are independent, and this hook touches only the human side.
 *
 * Failure trade-off (Input-contract exception list): `rescan()` raises the
 * typed `SkillRescanError` on IO faults (`rescan.ts`). The human candidate
 * face is lenient: **on failure keep the cached catalog** — never clear
 * candidates, never propagate, never block input, because "one root is
 * momentarily unreadable" must not even break `/help`. Failures surface via
 * `onRescanError` (host turns them into a notice) so the operator sees the
 * degradation. The model side deliberately does the opposite:
 * `computeSkillIndexDelta` must rethrow the same typed error, since a partial
 * scan pasted into messages reads to the model as "skills were deleted". The
 * dividing line between the two disciplines is who consumes the data.
 *
 * Relation to props: a refresh is valid only for **the base catalog it was
 * scanned against**. When the engine rebuilds/rebinds and the `catalog` prop
 * changes object, the stale result is dropped immediately (the new prop is
 * returned) so a previous engine's root list can never masquerade as current.
 */
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../harness/errors.js";
import type { SkillCatalog } from "../harness/skill/catalog.js";
import type { SkillRescanner } from "../harness/skill/rescan.js";

export interface LiveSkillCatalogOptions {
  /** Assembly-time cached catalog (passed via props; a new object after an engine rebuild). */
  readonly catalog: SkillCatalog;
  /**
   * The rescan seam. When absent (tests / fixtures / ask mode) this hook
   * degrades to **identity passthrough** of the props catalog — no scanning,
   * no behavior change.
   */
  readonly rescanner: SkillRescanner | undefined;
  /**
   * Whether the slash palette is open (trimmed input starting with `/`).
   * The **rising edge** triggers one rescan — every "palette opened" is a
   * new "now".
   */
  readonly paletteOpen: boolean;
  /**
   * Rescan failure reporting (the typed `SkillRescanError`, or anything else
   * rescan throws). Absent → failures silently keep the cache (optional for
   * callers that do not care).
   */
  readonly onRescanError: ((err: unknown) => void) | undefined;
}

/**
 * Human-readable notice text for a rescan failure.
 *
 * `SkillRescanError` is a typed error (discriminant `kind: "rescan_failed"`
 * plus a `faults` list), and per the typed-error catch contract in
 * `.claude/rules/code-quality.md` we **check `kind` before branching**, never
 * `String(err)` — that would hide every path and errno in `faults` and show
 * the operator only `[object Object]`.
 *
 * Anything not in that shape (programming errors / non-Error throws) degrades
 * to `Error#message` without pretending to be a rescan fault.
 */
export function formatSkillRescanFailure(err: unknown): string {
  const shaped = err as {
    readonly kind?: unknown;
    readonly faults?: readonly {
      readonly kind?: unknown;
      readonly path?: unknown;
      readonly code?: unknown;
    }[];
  };
  if (
    typeof err === "object" &&
    err !== null &&
    shaped.kind === "rescan_failed" &&
    Array.isArray(shaped.faults)
  ) {
    const detail = shaped.faults
      .map((fault) => {
        const code = fault.code === undefined ? "" : ` (${String(fault.code)})`;
        return `${String(fault.kind)} ${String(fault.path)}${code}`;
      })
      .join("; ");
    return `技能重扫失败（候选保留上次结果）：${detail}`;
  }
  // Non-rescan shapes → the sanctioned renderer (Error.message first, plain
  // objects fall back to JSON.stringify so kind/faults are not lost).
  return errorMessage(err);
}

export function useLiveSkillCatalog(
  options: LiveSkillCatalogOptions
): SkillCatalog {
  const { catalog, rescanner, paletteOpen } = options;
  // Store the refreshed result together with the base it was scanned
  // against: a base mismatch means staleness, dropped at render time directly
  // (not via effect cleanup, which would first paint one frame of the old
  // engine's catalog).
  const [refreshed, setRefreshed] = useState<
    { readonly base: SkillCatalog; readonly catalog: SkillCatalog } | undefined
  >(undefined);
  // Which base this "open" has already scanned — reset on the rising edge so
  // each open rescans once (a catalog object swap mid-open also retriggers:
  // that is an engine change and deserves a rescan).
  const scannedBase = useRef<SkillCatalog | undefined>(undefined);
  // Generation: results landing after a base swap are voided. An effect
  // rerun caused by dep identity changes does **not** advance the generation
  // (the early-return branch is above), so in-flight rescans are not lost.
  const generation = useRef(0);
  // The callback is read through a ref: callers usually pass an inline arrow
  // (new identity every render), which in deps would rerun the effect every
  // frame (harmless but wasteful); in a ref the deps keep only the real
  // "when to rescan" signals.
  const onRescanError = useRef(options.onRescanError);
  onRescanError.current = options.onRescanError;

  useEffect(() => {
    // alive-ref (same discipline as useSubagentsPolling / useAsksPolling): a
    // rescan callback landing after unmount must not write state or trigger
    // host callbacks — otherwise "setState on unmounted" and post-unmount
    // errors reaching a pre-unmount host both happen. The generation guard
    // decides "should this result land"; alive decides "is the component still here".
    let alive = true;
    // Palette closed → reset: the next open is a fresh "now".
    if (!paletteOpen) {
      scannedBase.current = undefined;
      return () => {
        alive = false;
      };
    }
    if (rescanner === undefined || scannedBase.current === catalog) {
      return () => {
        alive = false;
      };
    }
    scannedBase.current = catalog;
    const mine = (generation.current += 1);
    void rescanner.rescan().then(
      (faces) => {
        if (alive && generation.current === mine)
          setRefreshed({ base: catalog, catalog: faces });
      },
      (err: unknown) => {
        // EXIT: rescan failed → keep the cached catalog (see the header's failure trade-off).
        if (alive && generation.current === mine) onRescanError.current?.(err);
      }
    );
    return () => {
      alive = false;
    };
  }, [paletteOpen, catalog, rescanner]);

  if (refreshed !== undefined && refreshed.base === catalog) {
    return refreshed.catalog;
  }
  return catalog;
}
