/**
 * Chat entry `/graph` — the slash peer across entry points.
 *
 * Two layers:
 *   1. `applySlashCommand` parses `/graph` into `{ type: "graph", args }`,
 *      passing args through verbatim (value domain and wording live in one
 *      place: `harness/graph/mode.ts`);
 *   2. `processChatLine` executes on the host's `graphMode` holder; after
 *      `/graph off` the holder returns to the off state; holder absent (ask
 *      entry) → stderr hint, no state change.
 */
import { describe, expect, test } from "vitest";
import assert from "node:assert/strict";
import {
  applySlashCommand,
  HELP_TEXT,
  type SlashContext,
} from "../../src/cli/slash.ts";
import { processChatLine } from "../../src/cli/chat-session.ts";
import { createGraphModeContext } from "../../src/harness/graph/mode.ts";
import { makeState } from "./_fixtures.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";

function mockCtx(overrides: Partial<SlashContext> = {}): SlashContext {
  return { state: makeState(), ...overrides };
}

/** When processChatLine only takes the slash branch it never touches deps; this is a non-callable placeholder. */
const UNUSED_DEPS = {} as unknown as LoopEngineDeps;

describe("/graph 解析 (cli slash)", () => {
  test("空 args → { type: graph, args: [] }", () => {
    expect(
      applySlashCommand({ command: "graph", args: [], ctx: mockCtx() })
    ).toEqual({ type: "graph", args: [] });
  });

  test("args 原样透传（解析归 harness/graph/mode.ts 单点）", () => {
    expect(
      applySlashCommand({ command: "graph", args: ["on"], ctx: mockCtx() })
    ).toEqual({ type: "graph", args: ["on"] });
  });

  test("HELP_TEXT 列出 /graph", () => {
    assert.match(HELP_TEXT, /\/graph/);
  });
});

describe("/graph 执行 (chat host holder)", () => {
  test("/graph on → holder 开；/graph off → holder 关", async () => {
    const graphMode = createGraphModeContext();
    const ctx = { deps: UNUSED_DEPS, state: makeState(), graphMode };

    const on = await processChatLine({ line: "/graph on", ctx });
    assert.equal(on.quit, false);
    assert.match(on.output, /on/);
    assert.equal(graphMode.get().enabled, true);

    const status = await processChatLine({ line: "/graph", ctx });
    assert.match(status.output, /图模式/);

    const off = await processChatLine({ line: "/graph off", ctx });
    assert.equal(graphMode.get().enabled, false);
    assert.match(off.output, /off/);
  });

  test("非法参数 → stderr usage，不改状态", async () => {
    const graphMode = createGraphModeContext();
    const ctx = { deps: UNUSED_DEPS, state: makeState(), graphMode };
    const res = await processChatLine({ line: "/graph maybe", ctx });
    assert.equal(res.output, "");
    assert.match(res.stderr ?? "", /Usage: \/graph/);
    assert.equal(graphMode.get().enabled, false);
  });

  test("holder 缺席（ask 入口）→ stderr 提示，不抛", async () => {
    const ctx = { deps: UNUSED_DEPS, state: makeState() };
    const res = await processChatLine({ line: "/graph on", ctx });
    assert.equal(res.output, "");
    assert.match(res.stderr ?? "", /graph/);
  });
});
