/**
 * File-level hot reload for settings.json — pure watcher module.
 *
 * Watches two settings files: user-level `~/.iknow/settings.json` +
 * project-level `<cwd>/.iknow/settings.json`. A change to either (modify /
 * first create) → merged and deduplicated, notified via
 * `onChange({ path, reason })`. **Never parses file content** (env parsing
 * belongs to EnvLoader / loadIknowEnv); this module only does
 * "filesystem event → throttled callback".
 *
 * Tech (no new npm deps, Node built-in fs):
 *   - **Primary path**: `fs.watch(dir, { recursive: false })` — event-driven,
 *     reliably arriving in milliseconds in practice, covering both "creation"
 *     (rename) and "modification" (change) events.
 *   - **Fallback path**: `fs.watchFile(path, { interval: 500 })` — polling
 *     safety net, activated only when the primary path is unavailable (the
 *     `.iknow` directory does not exist yet → fs.watch throws ENOENT), waiting
 *     for the user's first directory / file creation. The two channels are
 *     **mutually exclusive** (single active channel): one physical change is
 *     never double-reported (both channels reporting would break the "many
 *     consecutive writes → one onChange" dedup acceptance).
 *
 * Event semantics:
 *   - `reason: "change"` — file content changed (write / touch);
 *   - `reason: "rename"` — file created / replaced (create / rename events,
 *     watchFile transitions from "absent → present").
 *   With a single channel each physical change is reported once (100ms
 *   debounce merges repeats inside the window).
 *
 * Startup semantics:
 *   - File / directory both absent → no throw; watchers register normally and
 *     wait for user creation;
 *   - A directory created after the watcher starts → the first fs.watch ENOENT
 *     is caught internally (never bubbles); watchFile polling reports the
 *     first creation.
 *
 * Lifecycle:
 *   - `stop()`: closes all `fs.watch` + `fs.watchFile`, idempotent; after
 *     stopping onChange never fires.
 *   - Errors thrown inside onChange callbacks are caught (never block later
 *     events, fire-and-forget semantics).
 */

import {
  unwatchFile,
  watch,
  watchFile,
  type FSWatcher,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** watchFile polling interval (consistent across platforms; the fs.watch event path does not depend on it). */
const WATCH_FILE_INTERVAL_MS = 500;
/** Debounce window: an editor's atomic save with multiple writeFile calls triggers onChange once. */
export const DEBOUNCE_MS = 100;

export type WatchReason = "change" | "rename";

export interface SettingsChangeEvent {
  /** Absolute path of the changed settings file (user or project). */
  readonly path: string;
  /** "change" = content changed; "rename" = created / replaced. */
  readonly reason: WatchReason;
}

export interface WatchSettingsOptions {
  /** Project root (project-level settings at `cwd/.iknow/settings.json`). */
  readonly cwd?: string;
  /** User home (user-level settings at `home/.iknow/settings.json`). */
  readonly home?: string;
  readonly onChange: (event: SettingsChangeEvent) => void;
}

export interface SettingsWatcher {
  /** Idempotent: repeatable; after stopping onChange never fires. */
  readonly stop: () => void;
}

/**
 * Normalize a "directory fs.watch event type" → callback reason.
 * Dir watch emits `rename` for creation and `change` for writes; any other
 * type (occasional on Linux) → "change" (conservative content-change semantics).
 */
function dirEventReason(eventType: string | Buffer): WatchReason {
  const t = typeof eventType === "string" ? eventType : eventType.toString();
  return t === "rename" ? "rename" : "change";
}

/**
 * Normalize a "watchFile two-generation stat compare" → callback reason.
 *  - absent → present (first creation / atomic replace) → "rename";
 *  - present and content changed (mtime or size) → "change".
 *  - Initial registration echo (both generations absent, or both present with
 *    no substantive change) → undefined (dropped).
 */
function statChangeReason(curr: Stats, prev: Stats): WatchReason | undefined {
  const currExists = curr.size > 0 || curr.mtimeMs > 0;
  const prevExists = prev.size > 0 || prev.mtimeMs > 0;
  if (currExists !== prevExists) return currExists ? "rename" : "change";
  if (!currExists) return undefined; // both generations absent: registration echo / idle poll
  // Both generations exist → report only when mtime or size actually changed (touch hits mtime).
  if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) return "change";
  return undefined;
}

/**
 * Set up event reporting for one settings file (two channels: directory
 * fs.watch + watchFile polling).
 *
 * Each physical write is merged by `debouncedEmit`: whichever channel arrives
 * first starts the 100ms debounce; later triggers inside the window are
 * swallowed. At window end onChange fires once with the **first** event.
 */
function watchOneFile(
  filePath: string,
  dirPath: string,
  onChange: (event: SettingsChangeEvent) => void
): { readonly close: () => void } {
  const fileResolved = resolve(filePath);
  const dirResolved = resolve(dirPath);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: SettingsChangeEvent | undefined;
  let closed = false;

  const debouncedEmit = (reason: WatchReason): void => {
    if (closed) return;
    if (timer !== undefined) return; // inside the window: swallow later triggers (dedup)
    pending = { path: fileResolved, reason };
    timer = setTimeout(() => {
      timer = undefined;
      const event = pending;
      pending = undefined;
      if (closed || event === undefined) return;
      try {
        onChange(event);
      } catch {
        // fire-and-forget: errors inside the callback never block later events.
      }
    }, DEBOUNCE_MS);
  };

  // Single-active-channel design: each physical change per file goes through
  // **one** channel only, avoiding "one write double-reported by both
  // channels" breaking dedup.
  //   - directory present → fs.watch event-driven (primary path, reliably
  //     millisecond-level in practice: write→change, create→rename);
  //   - directory absent → fs.watch ENOENT caught, fall back to watchFile
  //     polling (reports the user's first directory/file creation, no throw,
  //     startup semantics).
  // The two channels are "mutually exclusive", not "redundant in parallel":
  // watchFile activates only when fs.watch is unavailable, so one physical
  // change is never double-reported. Slow-fs.watch scenarios are covered by
  // the waitForEvents timeout (tests SETTLE_MS ≥750ms).
  const listenerRef = (curr: Stats, prev: Stats): void => {
    const reason = statChangeReason(curr, prev);
    if (reason === undefined) return;
    debouncedEmit(reason);
  };
  let dirWatcher: FSWatcher | undefined;
  try {
    dirWatcher = watch(
      dirResolved,
      { recursive: false },
      (eventType, filename) => {
        // filename null or not this file → ignore (other files in the same directory do not trigger).
        if (filename === null) return;
        if (resolve(dirResolved, filename.toString()) !== fileResolved) return;
        debouncedEmit(dirEventReason(eventType));
      }
    );
  } catch {
    // Directory absent → use the watchFile fallback channel (reports first creation).
    dirWatcher = undefined;
    watchFile(fileResolved, { interval: WATCH_FILE_INTERVAL_MS }, listenerRef);
  }

  return {
    close: () => {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        pending = undefined;
      }
      try {
        dirWatcher?.close();
      } catch {
        // close() on an already-closed watcher is idempotent (may already be released via stop).
      }
      // watchFile is only registered on the fallback path; unwatchFile is idempotent (no-op when unregistered).
      unwatchFile(fileResolved, listenerRef);
    },
  };
}

export function watchSettings(opts: WatchSettingsOptions): SettingsWatcher {
  const cwd = resolve(opts.cwd ?? process.cwd());
  // Aligns with settings.ts which uses os.homedir(): process.env.HOME is
  // undefined when HOME is unset, and falling back to process.cwd() would
  // duplicate the project file and miss the real user file.
  const home = resolve(opts.home ?? homedir());
  const paths = [
    { file: join(home, ".iknow", "settings.json"), dir: join(home, ".iknow") },
    { file: join(cwd, ".iknow", "settings.json"), dir: join(cwd, ".iknow") },
  ];
  const handles = paths.map(({ file, dir }) =>
    watchOneFile(file, dir, opts.onChange)
  );
  return {
    stop: () => {
      for (const h of handles) h.close();
    },
  };
}
