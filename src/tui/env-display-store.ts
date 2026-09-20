/**
 * src/tui/env-display-store.ts
 *
 * **Framework-agnostic** observable store for the env-derived display
 * snapshot (current model routing string + thinking baseline): the single
 * publication point for CLI/env resolution, consumed on the React side via
 * `useSyncExternalStore(store.subscribe, store.get)`.
 *
 * Why this layer exists: /model and /effort can rewrite the routing and
 * baseline mid-session, and the display (context-bar's `{model} · {effort}`
 * prefix) must follow — but the changes originate in session-api callbacks,
 * outside the React tree. Extracting "current value + change notification"
 * into a plain store frees the TUI from threading the env snapshot through
 * props along the whole component chain, when only one display depends on it.
 * Same shape as src/cli/stream-draft.ts.
 *
 * No React / no fd dependencies — plain values + a Set, unit-testable alone.
 */

import type { DefaultThinkingShape } from "./thinking-gate.js";

/**
 * Publish input (omit-version shape): publish and the factory initial value
 * share it — the store alone assigns the sequence number, callers do not
 * self-number. Named export so callers (host wiring / test fixtures) annotate
 * variables with it instead of re-declaring the object shape inline and drifting.
 */
export interface EnvDisplaySeed {
  readonly model: string | undefined;
  readonly defaultThinking: DefaultThinkingShape | undefined;
}

/** Published snapshot: all derived values the display needs + the publish sequence number. */
export interface EnvDisplaySnapshot {
  /** Current model routing string (SSOT of env.llm.model). */
  readonly model: string | undefined;
  /** Thinking baseline (projection of env.llm.thinking / thinkingEffort). */
  readonly defaultThinking: DefaultThinkingShape | undefined;
  /** Monotonically increasing publish count (observation/debugging only; never a render input). */
  readonly version: number;
}

export interface EnvDisplayStore {
  /**
   * Current snapshot. **Must return the same object identity while nothing
   * has been published** — `useSyncExternalStore` compares getSnapshot
   * results with Object.is; building a fresh object per call looks like "the
   * snapshot changed" → rerender → re-snapshot → infinite loop (React warns
   * "getSnapshot should be cached" and may hang). Hence the snapshot is
   * rebuilt only on publish; get only reads it back.
   */
  get(): EnvDisplaySnapshot;
  /** Subscribe to changes; returns the unsubscribe function (idempotent: calling it twice is harmless). */
  subscribe(listener: () => void): () => void;
  /** Replace the snapshot and notify subscribers synchronously. */
  publish(snapshot: EnvDisplaySeed): void;
}

/** Factory: `initial` is the omit-version shape; version starts at 0. */
export function createEnvDisplayStore(
  initial: EnvDisplaySeed
): EnvDisplayStore {
  // Snapshot cell: replaced wholesale on publish; get reads the same reference (stable identity).
  let current: EnvDisplaySnapshot = {
    model: initial.model,
    defaultThinking: initial.defaultThinking,
    version: 0,
  };
  const listeners = new Set<() => void>();

  return {
    get(): EnvDisplaySnapshot {
      return current;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      // Idempotent unsubscribe: React may call cleanup repeatedly under
      // StrictMode / dep changes, and cleanup may run after the listener
      // fired, so duplicate deletes must be harmless (Set.delete is already
      // idempotent; the closure flag only makes the semantics explicit
      // instead of relying on Set internals).
      let unsubscribed = false;
      return (): void => {
        if (unsubscribed) return;
        unsubscribed = true;
        listeners.delete(listener);
      };
    },

    publish(snapshot: {
      readonly model: string | undefined;
      readonly defaultThinking: DefaultThinkingShape | undefined;
    }): void {
      // The store alone assigns the sequence number (publishers do not
      // self-number): it advances even when every field holds the same value
      // — the change itself is the "new publish" signal, so consumers never
      // diff fields themselves.
      current = {
        model: snapshot.model,
        defaultThinking: snapshot.defaultThinking,
        version: current.version + 1,
      };
      // Copy before iterating (snapshot semantics): a listener that
      // unsubscribes itself, removes a not-yet-notified listener, or
      // subscribes during notification must not change **this** delivery set
      // — mutating a Set mid-iteration either skips pending listeners or
      // hands new subscribers an in-flight publish, and silent skips mean
      // stale UI on the React side. New subscribers take effect from the
      // next publish (pinned by a test).
      const pending = Array.from(listeners);
      for (const listener of pending) {
        try {
          listener();
        } catch {
          // Swallowed: display listeners are mostly React notification
          // callbacks; their exceptions must not break the data producer
          // nor block later listeners (same isolation contract as
          // stream-draft). A failed display refresh must never crash the
          // TUI or drop frames.
        }
      }
    },
  };
}

/** Unwired snapshot: fields always empty. Frozen + a module-level singleton —
 * a constant identity is a hard requirement of useSyncExternalStore, so
 * instantiation happens once at module load. */
const EMPTY_ENV_DISPLAY_SNAPSHOT: EnvDisplaySnapshot = Object.freeze({
  model: undefined,
  defaultThinking: undefined,
  version: 0,
});

/**
 * The unwired lazy store (the shared fallback for the optional
 * `envDisplay?` prop): reads are always empty and subscriptions never fire —
 * rendering-equivalent to "env never changed". Exported from the same file
 * as the factory so consumers (TuiApp / ContextBar) never grow a second
 * implementation: when the snapshot shape or store contract changes, the
 * fallback and the real store can only drift together, in one place.
 */
export const EMPTY_ENV_DISPLAY_STORE: EnvDisplayStore = Object.freeze({
  get: () => EMPTY_ENV_DISPLAY_SNAPSHOT,
  subscribe: () => (): void => {},
  publish: (): void => {},
});
