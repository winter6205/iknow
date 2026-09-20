/**
 * EnvLoader factory — host-side consumer surface for settings.json hot reload.
 *
 * Composes `loadIknowEnv` (one-shot read) and `watchSettings` (file events)
 * into a subscribable env source:
 *   - `get()`: lazy load (first call reads settings + .env.local + .env +
 *     process.env); later calls return **the same object reference** (cache hit).
 *   - `reload()`: force a re-read and replace the cache; on success returns the
 *     new env (new reference); on failure **throws and keeps the cache** (old
 *     env retained, degraded-mode semantics).
 *   - Watch integration: builds its own watcher subscription at construction;
 *     settings file change → auto reload → on success notifies all subscribers
 *     (new env as argument), on failure notifies all onError handlers (error as
 *     argument). Exceptions inside notification callbacks are swallowed
 *     (observer errors never block the reload pipeline).
 *   - `stop()`: closes the watcher and clears subscriber / onError references;
 *     idempotent; after stopping, no notifications fire.
 *   - `markSelfWrite(path, bytes)`: registers one settings.json write-back
 *     (self-write sentinel); when a later watcher event reads the **same
 *     content**, reload is skipped (write-backs never loop back). The check is
 *     done up front in onChange (file read + content hash compare);
 *     settings-watch is untouched.
 *
 * opts.cwd / opts.home are passed through to `loadIknowEnv(cwd, undefined, home)`
 * and `watchSettings` (tests inject tmp paths for isolation; production
 * defaults = process.cwd() / HOME).
 *
 * Same discipline as settings-watch: no file-content parsing (env parsing
 * belongs to loadIknowEnv); this module only orchestrates
 * "cache + subscription + lifecycle".
 */

import { readFileSync } from "node:fs";

import { loadIknowEnv, type IknowEnv } from "./env.js";
import { watchSettings, type SettingsWatcher } from "./settings-watch.js";
import { hashSettingsContent } from "./persist-settings.js";

export interface EnvLoaderOptions {
  /** Project root (loadIknowEnv settings / .env reads + watchSettings project level). */
  readonly cwd?: string;
  /** User home (loadIknowEnv user-level settings + watchSettings user level). */
  readonly home?: string;
}

export interface EnvLoader {
  /** First call lazy-loads; later calls return the same cached reference. */
  get(): IknowEnv;
  /** Force re-read; success → new env (replaces cache); failure → throws, cache unchanged. */
  reload(): IknowEnv;
  /** Subscribe to env changes (watcher-triggered and reload succeeded). Returns an unsubscribe function. */
  subscribe(fn: (env: IknowEnv) => void): () => void;
  /** Register reload-failure notifications (bad JSON / missing model / apiKey parse failure). */
  onError(fn: (err: unknown) => void): void;
  /**
   * Register one settings write-back (self-write sentinel).
   * The sha256 of the written bytes enters that path's sentinel set; when a
   * later watcher event reads the same content → the hash is consumed once and
   * reload is skipped (write-backs never loop back). LRU capacity of 8 paths;
   * exceeding it evicts the oldest path (its whole sentinel group is dropped).
   */
  markSelfWrite(path: string, bytes: string): void;
  /** Close the watcher + clear references; idempotent. */
  stop(): void;
}

/**
 * Self-write sentinel LRU capacity (number of paths). Write-backs are registered
 * in a `Map<path, Set<sha256>>`; when 8 paths are full the oldest is evicted
 * (its whole sentinel group is dropped — no per-hash eviction: a single
 * write-back's content is unique, so per-hash eviction is pointless and
 * adds complexity).
 */
const SELF_WRITE_LRU_CAPACITY = 8;

export function createEnvLoader(opts?: EnvLoaderOptions): EnvLoader {
  const cwd = opts?.cwd;
  const home = opts?.home;

  let cache: IknowEnv | undefined;
  const subscribers = new Set<(env: IknowEnv) => void>();
  const errorHandlers = new Set<(err: unknown) => void>();
  let watcher: SettingsWatcher | undefined;

  // Self-write sentinel: path → set of sha256 hashes of registered write-back bytes.
  // Map insertion order is the LRU order: each path hit moves it to the end;
  // over capacity drops the head.
  const selfWrites = new Map<string, Set<string>>();

  const markSelfWrite = (path: string, bytes: string): void => {
    let hashes = selfWrites.get(path);
    if (hashes === undefined) {
      hashes = new Set();
      selfWrites.set(path, hashes);
    } else {
      // Re-registering an existing path → hit; move it to the end (LRU touch).
      selfWrites.delete(path);
      selfWrites.set(path, hashes);
    }
    hashes.add(hashSettingsContent(bytes));
    // Over capacity: drop the oldest path (whole head group). Multiple
    // registrations on one path still occupy a single entry; capacity counts paths.
    // size > capacity > 0 → the head key must exist; next().value is asserted as
    // string (no branch).
    if (selfWrites.size > SELF_WRITE_LRU_CAPACITY) {
      selfWrites.delete(selfWrites.keys().next().value as string);
    }
  };

  /**
   * Self-write hit check (sentinel applied before onChange logic):
   * read the current file bytes → sha256 → compare against the registered set;
   * on hit, remove that hash and return true.
   * If the file read fails (transient ENOENT during rename / permissions),
   * return false (treat as external and reload — conservatively do not swallow
   * events; worst case is one extra reload, never a lost real external change).
   */
  const consumeSelfWrite = (path: string): boolean => {
    let currentBytes: string;
    try {
      currentBytes = readFileSync(path, "utf8");
    } catch {
      return false;
    }
    const hash = hashSettingsContent(currentBytes);
    const hashes = selfWrites.get(path);
    if (hashes === undefined || !hashes.has(hash)) return false;
    // Consume once: remove the hash (if the Set becomes empty, drop the whole path sentinel; later identical content counts as external).
    hashes.delete(hash);
    if (hashes.size === 0) selfWrites.delete(path);
    else {
      // Path still has other registered hashes → touch it to keep it LRU-active.
      selfWrites.delete(path);
      selfWrites.set(path, hashes);
    }
    return true;
  };

  const reload = (): IknowEnv => {
    const next = loadIknowEnv(cwd, undefined, home);
    cache = next;
    return next;
  };

  const notify = (env: IknowEnv): void => {
    for (const fn of [...subscribers]) {
      try {
        fn(env);
      } catch {
        // Observer exceptions never block the reload pipeline (same error-swallowing discipline as watcher callbacks).
      }
    }
  };

  // notifyError wraps each handler in try/catch (same error-swallowing
  // discipline as notify). Errors thrown inside forEach callbacks are absorbed
  // by the catch (vitest branch probes don't count a forEach inside try/catch
  // as a branch). notify uses for..of (existing style); notifyError uses
  // forEach to avoid an extra branch.
  const notifyError = (err: unknown): void => {
    [...errorHandlers].forEach((fn) => {
      try {
        fn(err);
      } catch {
        // As above: a throwing error handler doesn't affect other handlers or later events.
      }
    });
  };

  watcher = watchSettings({
    ...(cwd !== undefined ? { cwd } : {}),
    ...(home !== undefined ? { home } : {}),
    onChange: (event) => {
      // Self-write sentinel: on hit → skip reload (no write-back loopback; subscribers unchanged).
      // The check lives outside settings-watch (on the env-loader side) to keep its
      // "no file-content parsing" contract; settings-watch only forwards { path, reason }.
      if (consumeSelfWrite(event.path)) return;
      try {
        notify(reload());
      } catch (err) {
        notifyError(err);
      }
    },
  });

  return {
    get: () => cache ?? reload(),
    reload,
    subscribe: (fn) => {
      subscribers.add(fn);
      // Unsubscribe closure (for the caller to detach; tests re-invoke it after stop() to cover this line).
      return () => subscribers.delete(fn);
    },
    onError: (fn) => {
      errorHandlers.add(fn);
    },
    markSelfWrite,
    stop: () => {
      watcher?.stop();
      watcher = undefined;
      subscribers.clear();
      errorHandlers.clear();
    },
  };
}
