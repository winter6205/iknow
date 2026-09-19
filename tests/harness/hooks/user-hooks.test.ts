/**
 * Pre/Post hook multiplexer（composePreHooks / composePostHooks）。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  composePostHooks,
  composePreHooks,
} from "../../../src/harness/hooks/user-hooks.js";
import type {
  PostToolUseHook,
  PreToolUseHook,
} from "../../../src/harness/permission/types.js";

async function assertBlockedAsync(
  hook: PreToolUseHook,
  tool: string,
  input: unknown,
  reasonPart?: string
): Promise<void> {
  const block = await hook({ tool, input });
  assert.ok(block, `expected block for tool=${tool}`);
  if (reasonPart !== undefined) {
    assert.ok(
      block.reason.includes(reasonPart),
      `reason should include ${JSON.stringify(reasonPart)}, got: ${block.reason}`
    );
  }
}

async function assertPassthroughAsync(
  hook: PreToolUseHook,
  tool: string,
  input: unknown
): Promise<void> {
  assert.equal(await hook({ tool, input }), undefined);
}

describe("composePreHooks — multiplexer 组合", () => {
  const first: PreToolUseHook = ({ tool }) =>
    tool === "bash" ? { reason: "first hit" } : undefined;
  const second: PreToolUseHook = () => ({ reason: "second hit" });

  it("先拦先赢：前一个 block 后不再评估后续", async () => {
    const composed = composePreHooks([first, second]);
    await assertBlockedAsync(composed, "bash", { command: "x" }, "first hit");
    const block = await composed({ tool: "bash", input: { command: "x" } });
    assert.ok(!block!.reason.includes("second hit"));
  });

  it("user deny 时后续 hook 不再被调用（短路）", async () => {
    const calls: string[] = [];
    const denyUser: PreToolUseHook = () => {
      calls.push("user");
      return { reason: "user deny" };
    };
    const after: PreToolUseHook = () => {
      calls.push("after");
      return undefined;
    };
    const composed = composePreHooks([denyUser, after]);
    const block = await composed({ tool: "bash", input: {} });
    assert.deepEqual(calls, ["user"]);
    assert.equal(block!.reason, "user deny");
  });

  it("全部未命中 → undefined，全部 hook 均被评估", async () => {
    const calls: string[] = [];
    const a: PreToolUseHook = () => {
      calls.push("a");
      return undefined;
    };
    const b: PreToolUseHook = () => {
      calls.push("b");
      return undefined;
    };
    const composed = composePreHooks([a, b]);
    assert.equal(await composed({ tool: "bash", input: {} }), undefined);
    assert.deepEqual(calls, ["a", "b"]);
  });

  it("空组合 → 恒 undefined", async () => {
    const composed = composePreHooks([]);
    await assertPassthroughAsync(composed, "bash", {
      command: "git commit -m x",
    });
  });

  it("异步 hook 按声明序 await", async () => {
    const calls: string[] = [];
    const slow: PreToolUseHook = async () => {
      await new Promise((r) => setTimeout(r, 20));
      calls.push("slow");
      return undefined;
    };
    const fast: PreToolUseHook = async () => {
      calls.push("fast");
      return undefined;
    };
    const composed = composePreHooks([slow, fast]);
    await composed({ tool: "bash", input: {} });
    assert.deepEqual(calls, ["slow", "fast"]);
  });

  it("异步 hook 返回 block → 短路", async () => {
    const calls: string[] = [];
    const asyncDeny: PreToolUseHook = async () => {
      calls.push("deny");
      return { reason: "async deny" };
    };
    const after: PreToolUseHook = () => {
      calls.push("after");
      return undefined;
    };
    const composed = composePreHooks([asyncDeny, after]);
    const block = await composed({ tool: "bash", input: {} });
    assert.equal(block!.reason, "async deny");
    assert.deepEqual(calls, ["deny"]);
  });

  it("异步 hook 拒绝 → composed 拒绝", async () => {
    const boom: PreToolUseHook = async () => {
      throw new Error("async hook exploded");
    };
    const composed = composePreHooks([boom]);
    await assert.rejects(
      () => Promise.resolve(composed({ tool: "bash", input: {} })),
      /async hook exploded/
    );
  });
});

describe("composePostHooks — Post 侧组合器", () => {
  const postResult = {
    toolUseId: "id-1",
    name: "read_file",
    input: {},
    kind: "ok" as const,
  };

  it("全槽缺席 → undefined", () => {
    assert.equal(composePostHooks([]), undefined);
    assert.equal(composePostHooks([undefined, undefined]), undefined);
  });

  it("undefined 槽跳过，在场的按数组序 await", async () => {
    const calls: string[] = [];
    const tui: PostToolUseHook = () => {
      calls.push("tui");
    };
    const plugin: PostToolUseHook = async () => {
      calls.push("plugin");
    };
    const composed = composePostHooks([tui, undefined, plugin]);
    assert.ok(composed);
    await composed(postResult);
    assert.deepEqual(calls, ["tui", "plugin"]);
  });

  it("顺序 await：慢 hook 完成前不启动下一个", async () => {
    const calls: string[] = [];
    const slow: PostToolUseHook = async () => {
      await new Promise((r) => setTimeout(r, 20));
      calls.push("slow");
    };
    const fast: PostToolUseHook = () => {
      calls.push("fast");
    };
    const composed = composePostHooks([slow, fast]);
    await composed!(postResult);
    assert.deepEqual(calls, ["slow", "fast"]);
  });

  it("result 透传：每个 hook 收到同一份结果对象", async () => {
    const seen: unknown[] = [];
    const a: PostToolUseHook = (r) => {
      seen.push(r);
    };
    const b: PostToolUseHook = (r) => {
      seen.push(r);
    };
    await composePostHooks([a, b])!(postResult);
    assert.deepEqual(seen, [postResult, postResult]);
  });

  it("hook 拒绝 → composed 拒绝", async () => {
    const boom: PostToolUseHook = async () => {
      throw new Error("post exploded");
    };
    const composed = composePostHooks([boom]);
    await assert.rejects(
      () => Promise.resolve(composed!(postResult)),
      /post exploded/
    );
  });
});
