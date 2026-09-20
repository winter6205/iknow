/**
 * Offline half of the agent-status-instruction-echo golden set: the STATIC
 * lock on the <agent_status> surface plus the trajectory fixture shape lock.
 *
 * STATIC (this file): byte-for-byte lock on the reconcile constant sentence +
 * ordering-template lock on the bar's key line prefixes (`last_tool:` /
 * `instruction:` / `reconcile:` / `todos:` header). Changing model-visible
 * text is a golden-set event and must pass this lock explicitly (field
 * compatibility / round-trip details live in agent-status-fields.test.ts, not
 * repeated here; this file pins only the bytes the model sees).
 *
 * SEAM is carried by integration assertions, locatable at:
 *   - tests/harness/agent-status-instruction-bar.test.ts (echo into the bar +
 *     never in system + event same-source, trace double-track)
 *   - tests/harness/agent-status-reconcile.test.ts (one-shot settlement, trace double-track)
 *
 * Trajectory set: fixtures in agent-status-instruction.fixtures.ts; the
 * real-model half is archive/tests-real-llm/agent-status-instruction-echo.test.ts
 * (npm run test:real-llm; missing key → Not run; offline green here never impersonates it).
 */
import assert from "node:assert/strict";
import { describe, it, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_STATUS_RECONCILE_LINE,
  buildAgentStatusText,
  readOpenTodoLines,
} from "../../src/harness/agent-status.ts";
import {
  AGENT_STATUS_FIXTURE_FORBIDDEN_PROMPT_TOKENS,
  AGENT_STATUS_INSTRUCTION_FIXTURES,
} from "./agent-status-instruction.fixtures.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// -- STATIC: model-visible byte locks (invariant 1 / 4 / 5) ---------------------------

describe("agent_status STATIC 锁（黄金集）", () => {
  it("reconcile 常量句逐字节锁定（改文案 = 黄金集事件，需显式过锁）", () => {
    assert.equal(
      AGENT_STATUS_RECONCILE_LINE,
      "reconcile: A new user instruction has arrived; if it conflicts with " +
        "the current todo ledger, reconcile the ledger via todo_write first, " +
        "then continue."
    );
  });

  it("栏关键行前缀次序模板锁定：last_tool → instruction → reconcile → todos: 头 → todo 行", () => {
    const bar = buildAgentStatusText({
      lastTool: "read_file",
      instruction: "改成做B",
      reconcile: true,
      openTodoLines: ["- [ ] [t1] a"],
    });
    assert.equal(
      bar,
      [
        "<agent_status>",
        "last_tool: read_file",
        "instruction: 改成做B",
        AGENT_STATUS_RECONCILE_LINE,
        "todos:",
        "- [ ] [t1] a",
        "</agent_status>",
      ].join("\n")
    );
  });

  it("reconcile 常量行是唯一点名 todo_write 的栏文案（verdict 不空转的根）", () => {
    assert.match(AGENT_STATUS_RECONCILE_LINE, /\btodo_write\b/);
    const barWithoutReconcile = buildAgentStatusText({
      lastTool: "idle",
      instruction: "do B",
      reconcile: false,
      openTodoLines: ["- [ ] [t1] a"],
    });
    assert.doesNotMatch(barWithoutReconcile, /todo_write/);
  });
});

// -- trajectory fixture shape lock (offline half; vacuity guard follows the graph-set discipline) ----------------

describe("agent_status pivot 轨迹夹具（离线半边）", () => {
  it("夹具册恰好一条 A1，verdict = todo_write", () => {
    assert.equal(AGENT_STATUS_INSTRUCTION_FIXTURES.length, 1);
    const [fixture] = AGENT_STATUS_INSTRUCTION_FIXTURES;
    assert.equal(fixture!.id, "a1-pivot-arrival-first-tool-todo-write");
    assert.equal(fixture!.expectedFirstTool, "todo_write");
    assert.ok(fixture!.title.length > 0);
  });

  it("pivot prompt 不点名 todo_write / 对齐机制（否则真模型 verdict 空转）", () => {
    for (const fixture of AGENT_STATUS_INSTRUCTION_FIXTURES) {
      const lower = fixture.pivotPrompt.toLowerCase();
      for (const token of AGENT_STATUS_FIXTURE_FORBIDDEN_PROMPT_TOKENS) {
        assert.ok(
          !lower.includes(token.toLowerCase()),
          `${fixture.id} prompt must not name ${token}`
        );
      }
    }
  });

  it("固定输入成立：stale 账本经真实读取器投影为非空 todo 段", async () => {
    for (const fixture of AGENT_STATUS_INSTRUCTION_FIXTURES) {
      const todoDir = await mkdtemp(join(tmpdir(), "iknow-as-golden-ledger-"));
      tempDirs.push(todoDir);
      await writeFile(join(todoDir, "todos.md"), fixture.staleLedger, "utf8");
      const openLines = await readOpenTodoLines(todoDir);
      assert.ok(
        openLines.length > 0,
        `${fixture.id}: ledger must be non-empty`
      );
      for (const line of openLines) {
        assert.match(line, /^- \[[ x~]\] /);
      }
    }
  });
});
