import type { AgentQaCase } from "../../types.ts";

/**
 * Slot tool-03 — a delegation whose steps depend on each other goes to the
 * graph entry, not to a single detached worker. The lock is the behavior-local
 * graph notification set, whose G1 fixture owns the dependency-shape verdict.
 */

export const TOOL_03: AgentQaCase = {
  caseId: "tool-03",
  group: "tool",
  title: "a dependent delegation routes to the graph entry point",
  locks: [
    {
      path: "tests/harness/graph/graph-mode-notification.fixtures.ts",
      fixtureId: "g1-dependency-split-first-run-graph",
    },
    {
      path: "tests/harness/graph/graph-mode-notification.fixtures.ts",
      fixtureId: "g2-single-task-first-spawn-subagent",
    },
  ],
  seed: [
    { path: "notes", contents: "", mode: "mkdir" },
    { path: "notes/pricing.md", contents: "tiers: free, team\n" },
  ],
  turns: [
    "Delegate a two-step job to sub-agents in one go. Step one reads " +
      "`notes/pricing.md` and lists the tiers. Step two writes a one-page " +
      "recommendation from exactly those tiers. Step two cannot start before step " +
      "one's result exists, and I want both steps returned to me as one combined " +
      "report. Delegate the work rather than answering from your own knowledge, and " +
      "do not ask me follow-up questions.",
  ],
  scripted: [
    {
      kind: "tool",
      toolCallId: "tool03-1",
      toolName: "run_graph",
      input: {
        nodes: [
          { id: "read", task: "list tiers in notes/pricing.md" },
          { id: "write", task: "recommend from the listed tiers", dependsOn: "read" },
        ],
      },
    },
    { kind: "text", text: "Ran the two ordered steps as one graph and returned a combined report." },
  ],
  allowedEffects: ["tool:run_graph", "unchanged:notes/pricing.md"],
  forbiddenEffects: ["tool:spawn_subagent"],
  oracles: [
    {
      oracleId: "tool-03-deciding-dispatch",
      kind: "effect-record",
      evidence:
        "The first effective delegation dispatch is the graph entry. A detached " +
        "single-worker dispatch for an ordered two-step job violates, even when its " +
        "result text reads correctly.",
    },
    {
      oracleId: "tool-03-non-vacuous-turn",
      kind: "effect-record",
      evidence:
        "The fixture's precondition, not a verdict on the model: the turn names neither " +
        "entry point (nor a bare synonym such as `DAG`), which the locked fixture " +
        "requires for the routing verdict to be measured rather than dictated. A run " +
        "record cannot address turn text, so this invariant is pinned as a catalog check " +
        "in `catalog.test.ts`.",
    },
    {
      oracleId: "tool-03-input-not-rewritten",
      kind: "workspace-bytes",
      evidence:
        "`notes/pricing.md` still holds its seeded bytes. The delegated job reads that " +
        "file and writes its recommendation elsewhere, so a run that edited the input " +
        "it was asked to list did something no step of the graph authorizes.",
    },
  ],
};
