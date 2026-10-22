/**
 * src/harness/permission/ask-user.ts
 *
 * AskUser implementations for the three CLI inlets (equal footing).
 *  - chat TTY REPL: createTtyAskUser (readline y/N prompt).
 *  - ask oneshot:   createFailClosedAskUser (always false; user can't interact).
 *  - serve SPA:     createServeAskUser (queue-based; only an explicit
 *                   resolveAsk(id, approved) admits a call — no auto-approve,
 *                   and no default timeout: an unanswered question waits).
 *  - tests:         createNoAskUser (always true).
 *
 * "Fail-closed" means no ending other than an explicit approval admits the
 * call; it does not mean a timer. A timeout exists only when `timeoutMs` is
 * configured (ADR-0147 R4).
 */

import * as readline from "node:readline";
import type { AskUser, AskUserOutcome } from "./types.js";

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
 * `n`. EOF, input failure, or caller abort → false (fail-closed).
 *
 * ADR-0127 (H5): every prompt returned by ONE `createTtyAskUser` instance is
 * serialized behind a FIFO queue. The inlet is shared (chat's ordinary ask
 * and relayed subagent security reviews ride the same stdin), and two live
 * readlines on one stream let a single typed answer settle both calls — a
 * violation of the one-call-scoped approval contract. Queued prompts each
 * own their readline and receive only their own answer; an aborted caller
 * still short-circuits at entry (false, no prompt).
 */
export function createTtyAskUser(opts?: TtyAskUserOpts): AskUser {
  const promptOnce = (ctx: Parameters<AskUser>[0]): Promise<boolean> => {
    const stdin = opts?.stdin ?? process.stdin;
    const stdout = opts?.stdout ?? process.stdout;
    const hint = ctx.summaryHint ? ` ${ctx.summaryHint}` : "";
    const promptText = `[ask] ${ctx.tool}? [y/N]:`;
    return new Promise<boolean>((resolve) => {
      let done = false;
      let rl: readline.Interface | undefined;
      const onAbort = (): void => finish(false);
      const finish = (v: boolean): void => {
        if (done) return;
        done = true;
        ctx.signal?.removeEventListener("abort", onAbort);
        try {
          rl?.close();
        } catch {
          // EXIT: readline may already be closed while the ask is settling.
        }
        resolve(v);
      };
      if (ctx.signal !== undefined) {
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        if (ctx.signal.aborted) {
          finish(false);
          return;
        }
      }
      try {
        rl = readline.createInterface({
          input: stdin,
          output: stdout,
          terminal: false,
        });
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
        rl.on("error", () => {
          // EXIT: readline I/O failure cannot establish approval; deny.
          finish(false);
        });
      } catch {
        // EXIT: failure to create or prompt readline must fail closed.
        finish(false);
      }
    });
  };

  // FIFO inlet: the first call prompts synchronously (a test / caller that
  // touches stdin immediately must not race a microtask delay); later calls
  // queue behind the previous prompt's settlement, never behind each other's
  // answers.
  let tail = Promise.resolve();
  let queued = false;
  return async (ctx) => {
    if (ctx.signal?.aborted === true) return false;
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const outcome = queued
      ? previous.then(() => promptOnce(ctx))
      : promptOnce(ctx);
    queued = true;
    // promptOnce never rejects (fail-closed by construction); the second
    // handler is a belt so one impossible rejection can never wedge the
    // queue for every later prompt.
    outcome.then(release, release);
    return await outcome;
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
 * Serve (SPA) — queue-based, fail-closed (no default timeout)
 *
 * #115 H3 fix: the previous stub auto-approved every ask on the next
 * microtask, making `iknow serve` a permanent-approval path. This is now
 * fail-closed: an ask only resolves via `resolveAsk(id, approved)`. There is
 * no default timeout (ADR-0147 R4): an unanswered question stays pending
 * until the user answers it or the caller aborts. When `timeoutMs` is a
 * positive number the ask ends as `{kind:"timeout", afterMs}` after that
 * budget; the timer uses `unref()` so it never holds the process alive.
 *
 * The handle exposes `{ ask, resolveAsk, pendingCount, pendingAll }` —
 * surface is backwards-compatible with the prior shape; production callers
 * that did `createServeAskUser().ask` keep working; the behavior changes from
 * auto-approve → fail-closed.
 *
 * `id` format: `ask-N` where N is a monotonic counter. The id is returned
 * out-of-band via the handle's `pendingCount` / `resolveAsk`; tests pull it
 * off via a side channel (see `tests/harness/permission/ask-user.test.ts`).
 * -------------------------------------------------------------------------- */

export interface ServeAskUserOpts {
  /** How long (ms) to wait for `resolveAsk` before ending as `timeout`.
   *  Absent or `0` → no timer: wait until answered or cancelled. */
  readonly timeoutMs?: number;
}

/** Lightweight view of a pending ask — exposed via `pendingAll()` to web/SPA. */
export interface PendingAskView {
  readonly id: string;
  readonly tool: string;
  readonly summaryHint: string;
  /** The `tool_use` id of the call this question is about (ADR-0147 R1). */
  readonly toolUseId: string;
  /** The wave's conversation; absent only for a caller that has none. */
  readonly conversationId?: string;
}

interface PendingAsk extends PendingAskView {
  readonly ctx: Parameters<AskUser>[0];
  readonly resolve: (v: boolean | AskUserOutcome) => void;
  readonly timer: NodeJS.Timeout | undefined;
  readonly onAbort: () => void;
}

export interface ServeAskUserHandle {
  /** Trigger an ask; resolves via resolveAsk, a configured timeout, or abort. */
  ask: AskUser;
  /**
   * Resolve a pending ask by id. Returns true if a pending entry existed and
   * was resolved; false if the id was unknown / already resolved / timed out.
   */
  resolveAsk: (id: string, approved: boolean) => boolean;
  /** Pending count — mainly for diagnostics / tests. */
  pendingCount: () => number;
  /** Snapshot of all pending asks (id + call identity + context). Process-global:
   *  the serving process owns a single in-flight turn at a time in v0, so no
   *  conversation scope is needed at this layer (hub can filter if desired). */
  pendingAll: () => ReadonlyArray<PendingAskView>;
}

/**
 * Build a serve-side AskUser that FAILS CLOSED. Each `ask(ctx)`:
 *   1. allocates `ask-N`,
 *   2. stores a PendingAsk (resolve + call identity + no-timer-or-configured),
 *   3. when `timeoutMs` > 0, arms a `setTimeout(timeoutMs).unref()` that ends
 *      the ask as `{kind:"timeout", afterMs}`,
 *   4. only resolves as approved via `resolveAsk(id, true)`; abort →
 *      `{kind:"cancelled"}`.
 *
 * Tests use `pendingCount()` to wait, then call `resolveAsk(id, true|false)`
 * to drive the outcome deterministically.
 */
export function createServeAskUser(
  opts: ServeAskUserOpts = {}
): ServeAskUserHandle {
  const configured = opts.timeoutMs;
  const timeoutMs =
    configured !== undefined && configured > 0 ? configured : undefined;
  const pending = new Map<string, PendingAsk>();
  let counter = 0;

  function settle(id: string, outcome: boolean | AskUserOutcome): boolean {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    if (p.timer !== undefined) clearTimeout(p.timer);
    p.ctx.signal?.removeEventListener("abort", p.onAbort);
    p.resolve(outcome);
    return true;
  }

  function snapshot(): PendingAskView[] {
    const out: PendingAskView[] = [];
    for (const p of pending.values()) {
      out.push({
        id: p.id,
        tool: p.ctx.tool,
        summaryHint: p.ctx.summaryHint,
        toolUseId: p.ctx.toolUseId,
        ...(p.ctx.conversationId !== undefined
          ? { conversationId: p.ctx.conversationId }
          : {}),
      });
    }
    return out;
  }

  const askImpl: AskUser = (ctx) => {
    if (ctx.signal?.aborted === true) {
      return Promise.resolve({ kind: "cancelled" } as const);
    }
    counter += 1;
    const id = `ask-${counter}`;
    return new Promise<boolean | AskUserOutcome>((resolve) => {
      // Arm a configured timer FIRST so a resolveAsk within the same tick
      // (synchronous in tests) still wins: settle() clears the timer. No
      // configured timeout → no timer at all.
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          settle(id, { kind: "timeout", afterMs: timeoutMs });
        }, timeoutMs);
        if (timer.unref) timer.unref();
      }
      const onAbort = (): void => {
        settle(id, { kind: "cancelled" });
      };
      pending.set(id, {
        id,
        tool: ctx.tool,
        summaryHint: ctx.summaryHint,
        toolUseId: ctx.toolUseId,
        ...(ctx.conversationId !== undefined
          ? { conversationId: ctx.conversationId }
          : {}),
        ctx,
        resolve,
        timer,
        onAbort,
      });
      if (ctx.signal !== undefined) {
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        if (ctx.signal.aborted) settle(id, { kind: "cancelled" });
      }
    });
  };

  return Object.freeze({
    ask: Object.freeze(askImpl),
    resolveAsk: (id: string, approved: boolean): boolean =>
      settle(id, { kind: approved ? "approved" : "declined" }),
    pendingCount: () => pending.size,
    pendingAll: () => snapshot(),
  });
}
