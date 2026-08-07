/**
 * src/harness/permission/ask-user.ts
 *
 * AskUser implementations for the three CLI inlets (#162 平权装配).
 *  - chat TTY REPL: createTtyAskUser (readline y/N prompt).
 *  - ask oneshot:   createFailClosedAskUser (always false; user can't interact).
 *  - serve SPA:     createServeAskUser (queue-based; fail-closed after
 *                   bounded timeout unless explicitly resolved via
 *                   resolveAsk(id, approved)). NO auto-approve.
 *  - tests:         createNoAskUser (always true).
 */

import * as readline from "node:readline";
import type { AskUser } from "./types.js";

/* -----------------------------------------------------------------------------
 * TTY (chat) — readline y/N prompt
 * -------------------------------------------------------------------------- */

export interface TtyAskUserOpts {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  /** Default answer when user just hits enter. */
  readonly defaultYes?: boolean;
}

const YES_TOKEN = "y";
const NO_TOKEN = "n";

/**
 * Prompt the user via readline for y/N approval. Returns true on `y`, false on
 * `n`. EOF on stdin → false (fail-closed). Throws on unexpected I/O failure.
 */
export function createTtyAskUser(opts?: TtyAskUserOpts): AskUser {
  return async (ctx) => {
    const stdin = opts?.stdin ?? process.stdin;
    const stdout = opts?.stdout ?? process.stdout;
    const hint = ctx.summaryHint ? ` ${ctx.summaryHint}` : "";
    const promptText = `[ask] ${ctx.tool}? [y/N]:`;
    return new Promise<boolean>((resolve, reject) => {
      const rl = readline.createInterface({
        input: stdin,
        output: stdout,
        terminal: false,
      });
      let done = false;
      const finish = (v: boolean, err?: unknown): void => {
        if (done) return;
        done = true;
        try {
          rl.close();
        } catch {
          // readline may already be closed; ignore
        }
        if (err) reject(err);
        else resolve(v);
      };
      rl.question(`${promptText}${hint} `, (ans) => {
        const trimmed = ans.trim().toLowerCase();
        if (trimmed === YES_TOKEN) finish(true);
        else if (trimmed === NO_TOKEN) finish(false);
        else if (trimmed === "" && opts?.defaultYes === true) finish(true);
        else finish(false);
      });
      rl.on("close", () => {
        if (!done) finish(false);
      });
      rl.on("error", (err) => {
        finish(false, err);
      });
    });
  };
}

/* -----------------------------------------------------------------------------
 * Fail-closed (ask oneshot) — always deny
 * -------------------------------------------------------------------------- */

export function createFailClosedAskUser(): AskUser {
  return async () => false;
}

/* -----------------------------------------------------------------------------
 * No-ask (tests) — always approve
 * -------------------------------------------------------------------------- */

export function createNoAskUser(): AskUser {
  return async () => true;
}

/* -----------------------------------------------------------------------------
 * Serve (SPA) — queue-based, FAIL-CLOSED on timeout
 *
 * #115 H3 fix: the previous stub auto-approved every ask on the next
 * microtask, making `iknow serve` a permanent-approval path. This is now
 * fail-closed: an ask only resolves via `resolveAsk(id, approved)`. If no
 * answer arrives within `timeoutMs` (default 5_000ms), the ask resolves
 * `false`. The timer uses `unref()` so it never holds the process alive.
 *
 * The handle exposes `{ ask, resolveAsk, pendingCount }` — surface is
 * backwards-compatible with the prior shape; production callers that did
 * `createServeAskUser().ask` keep working; the behavior changes from
 * auto-approve → fail-closed-on-timeout.
 *
 * `id` format: `ask-N` where N is a monotonic counter. The id is returned
 * out-of-band via the handle's `pendingCount` / `resolveAsk`; tests pull it
 * off via a side channel (see `tests/harness/permission/ask-user.test.ts`).
 * -------------------------------------------------------------------------- */

export interface ServeAskUserOpts {
  /** How long (ms) to wait for `resolveAsk` before failing closed. Default 5_000. */
  readonly timeoutMs?: number;
}

/** Lightweight view of a pending ask — exposed via `pendingAll()` to web/SPA. */
export interface PendingAskView {
  readonly id: string;
  readonly tool: string;
  readonly summaryHint: string;
}

interface PendingAsk extends PendingAskView {
  readonly ctx: Parameters<AskUser>[0];
  readonly resolve: (v: boolean) => void;
  readonly reject: (e: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

export interface ServeAskUserHandle {
  /** Trigger an ask; returns a Promise that resolves only via resolveAsk or timeout. */
  ask: AskUser;
  /**
   * Resolve a pending ask by id. Returns true if a pending entry existed and
   * was resolved; false if the id was unknown / already resolved / timed out.
   */
  resolveAsk: (id: string, approved: boolean) => boolean;
  /** Pending count — mainly for diagnostics / tests. */
  pendingCount: () => number;
  /** Snapshot of all pending asks (id + context). Process-global: the serving
   *  process owns a single in-flight turn at a time in v0, so no conversation
   *  scope is needed at this layer (hub can filter if desired). */
  pendingAll: () => ReadonlyArray<PendingAskView>;
}

const DEFAULT_SERVE_TIMEOUT_MS = 5_000;

/**
 * Build a serve-side AskUser that FAILS CLOSED. Each `ask(ctx)`:
 *   1. allocates `ask-N`,
 *   2. stores a PendingAsk (resolve + reject + timer),
 *   3. arms a `setTimeout(timeoutMs).unref()` that resolves `false`,
 *   4. only resolves truthy via `resolveAsk(id, true)`.
 *
 * Tests use `pendingCount()` to wait, then call `resolveAsk(id, true|false)`
 * to drive the outcome deterministically.
 */
export function createServeAskUser(
  opts: ServeAskUserOpts = {}
): ServeAskUserHandle {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SERVE_TIMEOUT_MS;
  const pending = new Map<string, PendingAsk>();
  let counter = 0;

  function settle(id: string, approved: boolean): boolean {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(approved);
    return true;
  }

  function snapshot(): PendingAskView[] {
    const out: PendingAskView[] = [];
    for (const p of pending.values()) {
      out.push({ id: p.id, tool: p.ctx.tool, summaryHint: p.ctx.summaryHint });
    }
    return out;
  }

  const askImpl: AskUser = (ctx) => {
    counter += 1;
    const id = `ask-${counter}`;
    return new Promise<boolean>((resolve) => {
      // Arm the fail-closed timer FIRST so a resolveAsk within the same tick
      // (synchronous in tests) still wins: settle() clears the timer.
      const timer = setTimeout(() => {
        settle(id, false);
      }, timeoutMs);
      if (timer.unref) timer.unref();
      pending.set(id, {
        id,
        tool: ctx.tool,
        summaryHint: ctx.summaryHint,
        ctx,
        resolve,
        reject: () => undefined,
        timer,
      });
    });
  };

  return Object.freeze({
    ask: Object.freeze(askImpl),
    resolveAsk: (id: string, approved: boolean): boolean =>
      settle(id, approved),
    pendingCount: () => pending.size,
    pendingAll: () => snapshot(),
  });
}
