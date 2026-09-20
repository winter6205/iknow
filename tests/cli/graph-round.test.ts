/**
 * Round boundary in the chat host — the graph assembly freezes per round, so
 * "the next run() is what takes effect" must pin down where the snapshot lands.
 *
 * The overlay can be flipped at any time; the assembled view is frozen by
 * round, and the freeze point must live in the host: one user input = one
 * round. Query lines take the snapshot; slash commands and blank lines do not
 * (they never run run(), and snapshotting them would scramble the semantics of
 * sequences like "flip the key, then immediately /graph status").
 */
import { describe, expect, it } from "vitest";
import { processChatLine } from "../../src/cli/chat-session.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";
import { createGraphModeContext } from "../../src/harness/graph/mode.ts";
import { createGraphAssembly } from "../../src/harness/graph/assembly.ts";
import type { GraphAssembly } from "../../src/harness/graph/assembly.ts";

function spyAssembly(inner: GraphAssembly): {
  assembly: GraphAssembly;
  rounds: () => number;
} {
  let rounds = 0;
  return {
    assembly: {
      beginRound: () => {
        rounds += 1;
        return inner.beginRound();
      },
      enabled: inner.enabled,
    },
    rounds: () => rounds,
  };
}

describe("chat host — graph 装配 round 边界", () => {
  it("一条查询行 = 一次 beginRound()", async () => {
    const mode = createGraphModeContext();
    const { assembly, rounds } = spyAssembly(createGraphAssembly(mode));
    const ctx = makeCtx({ responses: [assistantResult({ texts: ["ok"] })] });

    await processChatLine({
      line: "hello",
      ctx: { ...ctx, graphAssembly: assembly },
    });

    expect(rounds()).toBe(1);
  });

  it("斜杠命令 / 空行不拍快照（不跑 run()）", async () => {
    const mode = createGraphModeContext();
    const { assembly, rounds } = spyAssembly(createGraphAssembly(mode));
    const ctx = makeCtx({ responses: [assistantResult({ texts: ["ok"] })] });
    const graphMode = mode;

    await processChatLine({
      line: "/graph on",
      ctx: { ...ctx, graphAssembly: assembly, graphMode },
    });
    await processChatLine({
      line: "   ",
      ctx: { ...ctx, graphAssembly: assembly, graphMode },
    });

    expect(rounds()).toBe(0);
    // The holder has flipped, but no round has snapshotted it yet — the assembled view is still off.
    expect(mode.get().enabled).toBe(true);
    expect(assembly.enabled()).toBe(false);
  });

  it("`/graph on` 后的下一条查询行才把 overlay 拍进装配面", async () => {
    const mode = createGraphModeContext();
    const assembly = createGraphAssembly(mode);
    const ctx = makeCtx({ responses: [assistantResult({ texts: ["ok"] })] });

    await processChatLine({
      line: "/graph on",
      ctx: { ...ctx, graphAssembly: assembly, graphMode: mode },
    });
    expect(assembly.enabled()).toBe(false);

    await processChatLine({
      line: "build it",
      ctx: { ...ctx, graphAssembly: assembly, graphMode: mode },
    });
    expect(assembly.enabled()).toBe(true);
  });

  it("graphAssembly 缺席 → 查询行照常跑（未接 overlay 的入口零变化）", async () => {
    const ctx = makeCtx({ responses: [assistantResult({ texts: ["ok"] })] });
    const res = await processChatLine({ line: "hello", ctx });
    expect(res.quit).toBe(false);
  });
});
