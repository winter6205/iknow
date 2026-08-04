/**
 * src/harness/permission/ask-user.ts
 *
 * AskUser implementations for the three CLI inlets (#162 平权装配).
 *  - chat TTY REPL: createTtyAskUser (readline y/N prompt).
 *  - ask oneshot:   createFailClosedAskUser (always false; user can't interact).
 *  - serve SPA:     createServeAskUser (queue-based; v0 stub resolves true so
 *                   smoke tests can inject resolveAsk via the queue).
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
 * Serve (SPA) — queue-based v0 stub
 *
 * Spec says: "queue + resolveAsk(id, approved) method exposed for tests;
 * real wiring is out of scope — create simple in-memory version that resolves
 * immediately to true via a future-resolved Promise; throw at startup if
 * askUser missing and toolset declares execute."
 *
 * The stub keeps the API surface; tests inject resolves, production callers
 * rely on the immediate true resolution or wire resolveAsk from the websocket.
 * -------------------------------------------------------------------------- */

interface PendingAsk {
  readonly ctx: Parameters<AskUser>[0];
  readonly resolve: (v: boolean) => void;
  readonly reject: (e: unknown) => void;
}

export interface ServeAskUserHandle {
  /** Trigger an ask; returns a Promise + an id used by tests / WS to resolve. */
  ask: AskUser;
  /** Resolve a pending ask by id (id is returned via the Promise wrapper; v0 stub returns id="auto"). */
  resolveAsk: (id: string, approved: boolean) => boolean;
  /** Pending count — mainly for diagnostics / tests. */
  pendingCount: () => number;
}

/**
 * Build a serve-side AskUser. v0 stub: every ask resolves immediately with true
 * (a future-resolved Promise), with the option for tests to inject answers via
 * resolveAsk(id, ...). Real WS wiring is future work; the factory surface
 * stays stable.
 */
export function createServeAskUser(): ServeAskUserHandle {
  const pending = new Map<string, PendingAsk>();
  let counter = 0;
  const askImpl: AskUser = (ctx) => {
    counter += 1;
    const id = `ask-${counter}`;
    return new Promise<boolean>((resolve, reject) => {
      // v0 stub: resolve after one microtask (simulates "user hit approve".
      // production wiring replaces this with WS round-trip + pending Map).
      queueMicrotask(() => {
        if (pending.has(id)) {
          const p = pending.get(id);
          pending.delete(id);
          if (p) {
            p.resolve(true);
            return;
          }
        }
        resolve(true);
      });
      // also store so resolveAsk() can find it within the same tick (tests)
      pending.set(id, { ctx, resolve, reject });
    }).finally(() => {
      pending.delete(id);
    });
  };
  return Object.freeze({
    ask: Object.freeze(askImpl),
    resolveAsk: (id: string, approved: boolean): boolean => {
      const p = pending.get(id);
      if (!p) return false;
      pending.delete(id);
      p.resolve(approved);
      return true;
    },
    pendingCount: () => pending.size,
  });
}
