/**
 * Golden set for graph mode notification steering.
 *
 * Invariant (SSOT: src/harness/graph/notification.ts — the `<graph_mode>`
 * switch notification and the per-model-call presence line): with graph
 * mode ON, the model-visible graph text steers tool choice between the two
 * sub-agent entry points:
 *
 *   - work that splits into pieces with dependencies → `run_graph`
 *   - a single task, or several tasks with no ordering → `spawn_subagent`
 *
 * The verdicts are decidable regardless of the presence injection rhythm:
 * they read which tool the model reaches for, not how often the reminder
 * arrives, so the set survives a rhythm change (per-hop vs once-per-run)
 * without being rewritten.
 *
 * Prompt-development: fixtures exist before text edits. The verdicts below
 * are the set; they run under `npm run test:real-llm` (HAS_KEY). Missing
 * key → skip + Not run.
 *
 * Fixture prompts describe the work, never the tool: naming `run_graph` or
 * `spawn_subagent` (or a bare-tool synonym such as `DAG`) in a prompt would
 * make the trajectory vacuous, so the offline sibling asserts the names
 * stay out.
 */

export type GraphNotificationFixtureId =
  | "g1-dependency-split-first-run-graph"
  | "g2-single-task-first-spawn-subagent"
  | "g3-independent-parallel-first-spawn-subagent";

export interface GraphNotificationFixture {
  readonly id: GraphNotificationFixtureId;
  /** Vitest `-t` substring; each fixture is individually runnable. */
  readonly title: string;
  readonly userPrompt: string;
  /** Decidable first-tool verdict for this graph-ON trajectory. */
  readonly expectedFirstTool: "run_graph" | "spawn_subagent";
}

export const GRAPH_NOTIFICATION_FIXTURES: readonly GraphNotificationFixture[] =
  Object.freeze([
    {
      id: "g1-dependency-split-first-run-graph",
      title: "G1: graph ON, dependent split → first tool run_graph",
      expectedFirstTool: "run_graph",
      userPrompt:
        "I need a two-step comparison done by sub-agents, in one go. " +
        "Step one: gather the current pricing tiers of GitHub Actions, CircleCI, and Buildkite. " +
        "Step two: take that gathered pricing and write a one-page recommendation. " +
        "The second step cannot start before the first step's results exist, and I want " +
        "both steps handled as one ordered piece of sub-agent work that comes back to me " +
        "as a single combined report. Delegate the work — do not answer from your own knowledge, " +
        "and do not ask me follow-up questions.",
    },
    {
      id: "g2-single-task-first-spawn-subagent",
      title: "G2: graph ON, single standalone task → first tool spawn_subagent",
      expectedFirstTool: "spawn_subagent",
      userPrompt:
        "Ask a sub-agent to read this repository's README and report the exact npm test " +
        "command verbatim. That is the whole job — one task, nothing depends on anything " +
        "else, and I do not want a multi-step plan. Delegate it and give me the answer.",
    },
    {
      id: "g3-independent-parallel-first-spawn-subagent",
      title:
        "G3: graph ON, several independent tasks → first tool spawn_subagent",
      expectedFirstTool: "spawn_subagent",
      userPrompt:
        "Delegate three unrelated lookups to sub-agents: (a) the license declared in " +
        "package.json, (b) the Node version pinned in package.json engines, " +
        "(c) the name of the CI workflow file under .github/workflows. " +
        "Nothing here waits for anything else — none of these results feed another. " +
        "Delegate them and report the three answers.",
    },
  ]);

export function graphFixtureById(
  id: GraphNotificationFixtureId
): GraphNotificationFixture {
  const found = GRAPH_NOTIFICATION_FIXTURES.find((f) => f.id === id);
  if (found === undefined) {
    throw new Error(`graph notification fixture missing: ${id}`);
  }
  return found;
}

/** Tool names a fixture prompt must not name (else the verdict is vacuous). */
export const GRAPH_FIXTURE_FORBIDDEN_PROMPT_TOKENS: readonly string[] =
  Object.freeze(["run_graph", "spawn_subagent"]);
