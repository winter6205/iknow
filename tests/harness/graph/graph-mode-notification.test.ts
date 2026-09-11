/**
 * Offline lock for the graph-mode notification golden set.
 *
 * The verdicts anchor to the SSOT text (src/harness/graph/notification.ts),
 * not to an ADR number: the steering clauses (dependent split → run_graph,
 * single task / no ordering → spawn_subagent) are contract facts that read
 * the same under any presence-injection rhythm.
 *
 * Invariant: three individually runnable fixtures exist whose prompts state the
 * work shape (dependent split / single task / independent set) without naming
 * either tool, so the real-LLM first-tool verdict is not vacuous
 * (archive/tests-real-llm/graph-mode-notification.test.ts). This file stays
 * offline so default `npm test` does not call a model.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  IKNOW_GRAPH_MODE_ON_NOTIFICATION,
  IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
} from "../../../src/harness/graph/notification.ts";
import {
  GRAPH_FIXTURE_FORBIDDEN_PROMPT_TOKENS,
  GRAPH_NOTIFICATION_FIXTURES,
  graphFixtureById,
  type GraphNotificationFixture,
} from "./graph-mode-notification.fixtures.ts";

describe("graph mode notification golden set (fixtures)", () => {
  it("contains exactly three individually named fixtures", () => {
    assert.equal(GRAPH_NOTIFICATION_FIXTURES.length, 3);
    assert.deepEqual(
      GRAPH_NOTIFICATION_FIXTURES.map((f) => f.id),
      [
        "g1-dependency-split-first-run-graph",
        "g2-single-task-first-spawn-subagent",
        "g3-independent-parallel-first-spawn-subagent",
      ]
    );
  });

  it("no prompt names either tool or a bare-tool synonym (else the verdict is vacuous)", () => {
    for (const fixture of GRAPH_NOTIFICATION_FIXTURES) {
      for (const token of GRAPH_FIXTURE_FORBIDDEN_PROMPT_TOKENS) {
        assert.ok(
          !fixture.userPrompt.includes(token),
          `${fixture.id} prompt must not name ${token}`
        );
      }
    }
  });

  const g1 = graphFixtureById("g1-dependency-split-first-run-graph");
  it(g1.title, () => {
    assertFixtureRunnable(g1);
    assert.equal(g1.expectedFirstTool, "run_graph");
    // The work shape must be stated: an ordered split whose second step
    // consumes the first step's results.
    assert.match(g1.userPrompt, /step|cannot start before|ordered/i);
    assert.match(g1.userPrompt, /sub-agent/i);
  });

  const g2 = graphFixtureById("g2-single-task-first-spawn-subagent");
  it(g2.title, () => {
    assertFixtureRunnable(g2);
    assert.equal(g2.expectedFirstTool, "spawn_subagent");
    assert.match(g2.userPrompt, /one task|whole job/i);
  });

  const g3 = graphFixtureById("g3-independent-parallel-first-spawn-subagent");
  it(g3.title, () => {
    assertFixtureRunnable(g3);
    assert.equal(g3.expectedFirstTool, "spawn_subagent");
    // Independence must be stated: nothing feeds anything else.
    assert.match(g3.userPrompt, /nothing here waits|none of these results/i);
  });
});

describe("graph mode notification set covers both sides of the tool choice", () => {
  it("declares at least one run_graph verdict and one spawn_subagent verdict", () => {
    const verdicts = new Set(
      GRAPH_NOTIFICATION_FIXTURES.map((f) => f.expectedFirstTool)
    );
    assert.ok(verdicts.has("run_graph"));
    assert.ok(verdicts.has("spawn_subagent"));
  });

  it("every verdict is decidable from the SSOT steering clauses", () => {
    // The split doctrine lives in notification.ts's model-visible text:
    // "Keep using spawn_subagent for a single task, or for several tasks
    // with no ordering between them — a graph with no edges buys nothing
    // over parallel spawns." Each fixture's verdict must be readable off
    // that doctrine, so the set survives superseding ADR renumbering.
    const ssot = [
      IKNOW_GRAPH_MODE_ON_NOTIFICATION,
      IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
    ].join(" ");
    assert.match(ssot, /spawn_subagent for a single task/);
    assert.match(
      ssot,
      /several (tasks|independent tasks) with no ordering|several independent tasks/
    );
    for (const fixture of GRAPH_NOTIFICATION_FIXTURES) {
      assert.ok(
        fixture.expectedFirstTool === "run_graph" ||
          fixture.expectedFirstTool === "spawn_subagent"
      );
    }
  });
});

function assertFixtureRunnable(fixture: GraphNotificationFixture): void {
  assert.ok(fixture.title.length > 0);
  assert.ok(fixture.userPrompt.trim().length > 0);
  assert.ok(
    fixture.userPrompt.length <= 1200,
    `${fixture.id} prompt grew past the fixture budget — keep fixtures short`
  );
}
