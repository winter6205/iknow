/**
 * spec agent-status-instruction-echo T5 / SC7 黄金集离线半边：
 * <agent_status> 面的 STATIC 锁 + 轨迹夹具形状锁。
 *
 * STATIC（本文件）：reconcile 常量句逐字节锁 + 栏关键行前缀
 * （`last_tool:` / `instruction:` / `reconcile:` / `todos:` 头）次序模板锁。
 * 改文案 = 黄金集事件，必须显式过本锁（字段兼容 / round-trip 细则在
 * agent-status-fields.test.ts，本文件不重复，只钉模型可见字节）。
 *
 * SEAM 由 T3/T4 集成断言承担，可指认：
 *   - tests/harness/agent-status-instruction-bar.test.ts（回显进栏 + 不进
 *     system + 事件同源，trace 双轨）
 *   - tests/harness/agent-status-reconcile.test.ts（一次性结算，trace 双轨）
 *
 * 轨迹集：夹具 agent-status-instruction.fixtures.ts，真模型半边
 * archive/tests-real-llm/agent-status-instruction-echo.test.ts
 * （npm run test:real-llm；缺 key → Not run，不以本文件离线绿冒充）。
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

// -- STATIC：模型可见字节锁（invariant 1 / 4 / 5） ---------------------------

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

// -- 轨迹夹具形状锁（离线半边；vacuity guard 照 graph 集纪律） ----------------

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
      assert.ok(openLines.length > 0, `${fixture.id}: ledger must be non-empty`);
      for (const line of openLines) {
        assert.match(line, /^- \[[ x~]\] /);
      }
    }
  });
});
