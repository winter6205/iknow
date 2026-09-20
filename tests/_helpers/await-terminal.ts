/**
 * Shared polling: "wait until all tasks of a SubAgentManager are terminal".
 *
 * Consolidates three byte-identical copies (tests/e2e/subagent-acceptance.test.ts,
 * tests/e2e/subagent-foreground-trace.test.ts ×2) — the sync contract was
 * re-derived per case, so any change to the terminal-state name set meant
 * shotgun surgery.
 *
 * **Do not use the drain read side as synchronization**: a `wait:false` spawn
 * returns `{task_id}` at once, and `run()` may close before the fake binary
 * emits an envelope; meanwhile host drain (`drainPendingSubagents`) is exactly
 * the channel these cases **assert on** — waiting on it via its own output is
 * self-proving. The criterion is therefore the manager's own four-state
 * projection (`listSubagents()`): tasks spawned (≥1) and all terminal, i.e.
 * the fake binary has emitted and stdout has been parsed; only then is reading
 * drain a valid assertion.
 *
 * The `maxPolls × pollMs` cap is an anti-hang bound, not the expected wait —
 * the happy path satisfies it within the first few polls. On overflow it does
 * **not throw**: the caller's later assertion gives the real diagnostic (e.g.
 * drain returns an empty array), which beats a generic timeout here.
 */
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";

export interface AwaitAllTasksTerminalOptions {
  /** Interval between polls (ms). */
  readonly pollMs?: number;
  /** Max poll count (anti-hang bound, not a wait duration). */
  readonly maxPolls?: number;
}

/** Terminal states in the four-state projection: stable once reached, safe to sync on. */
function isTerminal(state: string): boolean {
  return state === "completed" || state === "failed";
}

export async function awaitAllTasksTerminal(
  manager: Pick<SubAgentManager, "listSubagents">,
  options: AwaitAllTasksTerminalOptions = {}
): Promise<void> {
  const { pollMs = 10, maxPolls = 500 } = options;
  let polls = 0;
  const allTerminal = (): boolean => {
    const infos = manager.listSubagents();
    return infos.length > 0 && infos.every((i) => isTerminal(i.state));
  };
  while (!allTerminal() && polls < maxPolls) {
    await new Promise((r) => setTimeout(r, pollMs));
    polls += 1;
  }
}
