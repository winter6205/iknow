/**
 * Trajectory fixture for the agent-status-instruction-echo spec (golden set,
 * `<agent_status>` surface).
 *
 * Fixed input = a non-empty stale todo ledger plus a conflicting pivot
 * instruction arriving; the decidable behavior = the model's first tool on the
 * next hop is `todo_write` (reconcile the ledger before continuing the new
 * direction), instead of carrying on the old task trajectory (incident basis:
 * conversation `ee13c787`).
 *
 * Placement of the four golden-set artifacts (SSOT: roster row in
 * docs/guides/prompt-development.md):
 *   - STATIC lock   = tests/harness/agent-status-instruction-golden.test.ts
 *   - SEAM lock     = tests/harness/agent-status-instruction-bar.test.ts (echo into the bar)
 *                    + tests/harness/agent-status-reconcile.test.ts (settlement)
 *   - offline half of the trajectory set = tests/harness/agent-status-instruction-golden.test.ts
 *   - real-model half = archive/tests-real-llm/agent-status-instruction-echo.test.ts
 *                    (`npm run test:real-llm`; missing key → honest Not run)
 *
 * Co-location discipline follows tests/harness/graph/graph-mode-notification.fixtures.ts:
 * fixtures live beside the behavior they lock, not in a separate master cabinet.
 *
 * The prompt describes only the new direction's work and never names
 * `todo_write` or the reconciliation mechanism: the only text that steers the
 * model to the ledger is the reconcile constant line in the bar (SSOT:
 * AGENT_STATUS_RECONCILE_LINE in src/harness/agent-status.ts). If the prompt
 * named the tool, the trajectory verdict would be vacuous.
 */

export type AgentStatusInstructionFixtureId =
  "a1-pivot-arrival-first-tool-todo-write";

export interface AgentStatusInstructionFixture {
  readonly id: AgentStatusInstructionFixtureId;
  /** Vitest `-t` substring; the fixture can run standalone. */
  readonly title: string;
  /**
   * Stale ledger seeded into `<todoDir>/todos.md` (unfinished items of the old
   * direction). The real-model arm assembles with `conversationId: undefined`
   * → the bar reads the root todos.md (same SSOT resolution as
   * readOpenTodoLines' legacy shared-root form).
   */
  readonly staleLedger: string;
  /** The pivot instruction entering run() as a real user message. */
  readonly pivotPrompt: string;
  /** Decidable verdict: first tool on the hop following the pivot's arrival. */
  readonly expectedFirstTool: "todo_write";
}

/** Prompt tokens that would make the verdict vacuous (the mechanism belongs to the bar text, not the user instruction). */
export const AGENT_STATUS_FIXTURE_FORBIDDEN_PROMPT_TOKENS: readonly string[] =
  Object.freeze([
    "todo_write",
    "todo",
    "ledger",
    "reconcile",
    "agent_status",
    "status bar",
  ]);

export const AGENT_STATUS_INSTRUCTION_FIXTURES: readonly AgentStatusInstructionFixture[] =
  Object.freeze([
    {
      id: "a1-pivot-arrival-first-tool-todo-write",
      title: "A1: pivot 进场 + 非空 stale 账本 → 首工具 todo_write",
      staleLedger:
        "- [ ] [t1] Migrate the auth module to JWT access tokens\n" +
        "- [~] [t2] Rotate refresh tokens in the session store\n",
      pivotPrompt:
        "The JWT auth migration in your current plan is cancelled — do not " +
        "touch auth anymore. We are shipping a Node 22 compatibility pass " +
        "instead: check which Node version package.json engines pins, update " +
        "that field to 22, refresh the README setup section to match, and " +
        "re-run npm test. This new direction replaces the old plan outright; " +
        "start now and report what changed.",
      expectedFirstTool: "todo_write",
    },
  ]);

export function agentStatusFixtureById(
  id: AgentStatusInstructionFixtureId
): AgentStatusInstructionFixture {
  const fixture = AGENT_STATUS_INSTRUCTION_FIXTURES.find((f) => f.id === id);
  if (fixture === undefined) throw new Error(`missing fixture: ${id}`);
  return fixture;
}
