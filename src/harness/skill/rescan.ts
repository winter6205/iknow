/**
 * Skill rescanner seam — the "hot right now" scan of the loadable face
 * (`specs/skill-index-increment.md`).
 *
 * ## What this seam owns
 *
 * One `rescan()` = rerun `createSkillScanner().scan()` with the CURRENT root
 * list and wrap the result as a NEW `SkillCatalogFaces` (named `modelIndex()`
 * / `loadable()` faces). It covers every skill root: user / project /
 * `IKNOW_SKILL_DIRS` / resolved plugin skill dirs.
 *
 * Why the root list lives in a mutable holder: plugin roots are the only
 * part that must be swapped on explicit reload. The seam never reads
 * `installed_plugins.json` or discovers plugins itself — it accepts the list
 * the host resolved at reload time. Consequently "plugin package changed
 * without a reload → no new entries" holds structurally: the root list
 * didn't swap, so the scan has no new roots to walk.
 *
 * ## What this seam does NOT own
 *
 * Frozen table / entry history / dedupe / injection all belong to consumers.
 * `rescan()` neither reads nor writes session state; on failure it only
 * throws a typed error and touches nothing — callers keep the frozen table,
 * skip pasting partial deltas, and retain entry history.
 *
 * ## Failure taxonomy
 *
 * The scanner's standing discipline is "missing dir = empty, never throw"
 * (assembly can't be sunk by one unreadable dir), and this seam keeps that
 * half (ENOENT is still a legal empty state) while upgrading REAL IO faults
 * to a typed error — pasting a partial scan as "all skills were deleted"
 * would be wrong. Coexistence mechanism: the scanner's `onIoFailure`
 * observer collects the facts, and `rescan()` throws `SkillRescanError`
 * after the scan (all faults at once, so operators see every broken root in
 * one round).
 */
import { createSkillCatalog, type SkillCatalogFaces } from "./catalog.js";
import {
  createSkillScanner,
  type PluginSkillDir,
  type SkillIoFailure,
  type SkillScannerOptions,
} from "./scanner.js";

export type { SkillIoFailure };

/**
 * Typed rescan failure. `kind` is the stable wire discriminator (same
 * discipline as `SessionStoreError`: consumers branch on `kind`, never parse
 * the message).
 *
 * `faults` carries ALL IO faults in one throw (not just the first): one
 * rescan can hit several broken roots at once, and reporting only the first
 * would make the operator fix one per round. Empty faults never occur (only
 * thrown when there really are faults).
 */
export class SkillRescanError extends Error {
  override readonly name = "SkillRescanError";
  readonly kind = "rescan_failed" as const;
  readonly faults: readonly SkillIoFailure[];
  constructor(faults: readonly SkillIoFailure[]) {
    super(
      `skill rescan failed: ${faults
        .map((f) => `${f.kind} ${f.path}${f.code ? ` (${f.code})` : ""}`)
        .join("; ")}`
    );
    this.faults = Object.freeze([...faults]);
  }
}

export interface SkillRescanOptions {
  userHome: string;
  /** Session's `projectIdentityRoot` (same as `SkillScannerOptions`). */
  projectIdentityRoot: string;
  /**
   * Environment source. Each `rescan()` re-reads `IKNOW_SKILL_DIRS` — it
   * belongs to the "current scan roots", not the plugin face that requires a
   * reload to swap, so it isn't frozen into the holder (callers typically
   * pass `process.env` itself).
   */
  env: Readonly<Record<string, string | undefined>>;
  /**
   * Initial plugin skill dirs (host's assembly-time resolution). Afterwards
   * replaced only via `setPluginSkillDirs()` on explicit reload. Default: [].
   */
  pluginSkillDirs?: readonly PluginSkillDir[];
  warn?: SkillScannerOptions["warn"];
}

export interface SkillRescanner {
  /**
   * Rescan with the CURRENT root list → new `SkillCatalogFaces`.
   *
   * Each call returns a new instance; older instances remain snapshots (not
   * rewritten by later rescans). IO faults → throws `SkillRescanError`; the
   * caller keeps the frozen table and skips partial deltas.
   */
  rescan(): Promise<SkillCatalogFaces>;
  /**
   * Wholesale replacement (not merge) of the plugin root list — the host
   * calls it after an explicit reload with the fully re-resolved list. Takes
   * effect only for the next `rescan()`; already-returned catalogs are
   * snapshots and stay untouched.
   */
  setPluginSkillDirs(dirs: readonly PluginSkillDir[]): void;
  /** Snapshot of the current plugin root list (new array each call; not a write channel). */
  pluginSkillDirs(): readonly PluginSkillDir[];
}

export function createSkillRescanner(
  options: SkillRescanOptions
): SkillRescanner {
  // The only mutable state: the plugin root list. Everything else
  // (userHome / projectIdentityRoot / env source / warn) is constant for the
  // seam's lifetime — session roots are identity (ADR-0037) and env is
  // re-read per call, so neither needs a holder.
  let pluginSkillDirs: readonly PluginSkillDir[] = Object.freeze([
    ...(options.pluginSkillDirs ?? []),
  ]);

  return Object.freeze({
    async rescan(): Promise<SkillCatalogFaces> {
      const faults: SkillIoFailure[] = [];
      const entries = await createSkillScanner({
        userHome: options.userHome,
        projectIdentityRoot: options.projectIdentityRoot,
        env: options.env,
        pluginSkillDirs,
        ...(options.warn !== undefined ? { warn: options.warn } : {}),
        // Collect all faults first; throw once after the scan so the caller
        // sees every broken root, not just the first.
        onIoFailure: (failure) => faults.push(failure),
      }).scan();
      // EXIT: real IO faults (non-ENOENT) → typed error; a partial catalog is
      // NEVER returned. The caller leaves the frozen table, entry history,
      // and messages untouched — this seam only throws, it mutates nothing.
      if (faults.length > 0) throw new SkillRescanError(faults);
      return createSkillCatalog(entries);
    },
    setPluginSkillDirs(dirs: readonly PluginSkillDir[]): void {
      pluginSkillDirs = Object.freeze([...dirs]);
    },
    pluginSkillDirs(): readonly PluginSkillDir[] {
      return [...pluginSkillDirs];
    },
  });
}
