/**
 * D-α T3 —— chat host 的 round 边界（spec SC2「下一次 run() 才生效」）。
 *
 * overlay 随时可翻，装配面按 round 冻结 —— 冻结点必须落在 host 上：一次用户
 * 输入 = 一个 round。这里锁的就是那一下：查询行拍一次快照，斜杠命令与空行
 * 不拍（它们不跑 run()，拍了会把「翻完键紧接着 /graph status」这种序列的
 * 语义搅乱）。
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
    // holder 已翻,但还没有 round 拍过它 —— 装配面仍是关的。
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
