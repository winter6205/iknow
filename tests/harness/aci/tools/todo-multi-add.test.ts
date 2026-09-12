/**
 * Offline half of the todo multi-add golden set (SC7).
 *
 * Proves the fixture's expected `add` call is accepted by the real tool and
 * leaves exactly the decidable ledger the set claims; the first-tool verdict
 * for the same fixture runs under `npm run test:real-llm`
 * (archive/tests-real-llm/todo-multi-add.test.ts). Keeping this file offline
 * means default `npm test` never calls a model.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTodoWriteTool } from "../../../../src/harness/aci/tools/todo-write.ts";
import {
  expectedLedgerLines,
  TODO_MULTI_ADD_FIXTURES,
  todoMultiAddFixtureById,
} from "./todo-multi-add.fixtures.ts";

let todoDir: string;

beforeEach(async () => {
  todoDir = await mkdtemp(join(tmpdir(), "todo-multi-add-"));
});

afterEach(async () => {
  await rm(todoDir, { recursive: true, force: true });
});

describe("todo multi-add golden set (offline fixture)", () => {
  it("contains exactly one individually named SC7 fixture", () => {
    assert.equal(TODO_MULTI_ADD_FIXTURES.length, 1);
    assert.deepEqual(
      TODO_MULTI_ADD_FIXTURES.map((f) => f.id),
      ["sc7-plan-multi-step"]
    );
  });

  const fixture = todoMultiAddFixtureById("sc7-plan-multi-step");

  it(fixture.title, async () => {
    assert.ok(fixture.userPrompt.trim().length > 0);
    assert.ok(
      fixture.expectedAddInput.items.length > 1,
      "multi-step plan must carry more than one item"
    );

    const tool = createTodoWriteTool({ todoDir });
    const receipt = await tool.handler(fixture.expectedAddInput);

    // Receipt names every new id, in plan order.
    const ids = fixture.expectedAddInput.items.map((_, i) => `t${i + 1}`);
    assert.equal(
      receipt,
      `Added ${ids.length} items: ${ids.join(", ")}`
    );

    // Durable ledger = one pending line per step, ids t1..tN.
    const onDisk = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.equal(onDisk, expectedLedgerLines(fixture).join("\n") + "\n");

    // The read surface shows the same table (ids addressable by update).
    const readBack = await tool.handler({ mode: "read" });
    assert.equal(readBack, onDisk);
  });
});
