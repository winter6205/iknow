/**
 * Effort-fuse threshold constant.
 *
 * Maximum executor entries per node id within one `run_graph` call
 * (including the first). Default **8**: the 9th entry trips the typed fuse,
 * the whole call stops, already-done nodes stay frozen, and the outer loop
 * can still run new ids.
 *
 * **Not a setting.** This graph deliberately keeps the number out of
 * settings; changing it requires a separate decision. This file is the
 * pinned entry point — a guarding test asserts the constant equals 8.
 *
 * For the fuse's placement and shape (counter + AbortController signal),
 * see the header comment of `effort-fuse.ts`.
 */

export const EFFORT_FUSE_THRESHOLD = 8;
