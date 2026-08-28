/**
 * auto-memory T4: chat host wiring.
 *
 * Spec: specs/auto-memory.md D1/D4; ADR-0031 Decision 1/5. The CLI chat host
 * must hand every finished turn to the hook, and a hook failure must never
 * change the outcome of the user's turn.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { processChatLine } from "../../src/cli/chat-session.ts";
import type { AutoMemoryTurn } from "../../src/harness/memory/index.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";

/** Records what the host handed the hook. */
const recorder = (): {
  readonly hook: {
    onTurnComplete: (t: AutoMemoryTurn) => void;
    drain: () => Promise<void>;
  };
  readonly seen: AutoMemoryTurn[];
} => {
  const seen: AutoMemoryTurn[] = [];
  return {
    hook: {
      onTurnComplete: (t) => seen.push(t),
      drain: async () => {},
    },
    seen,
  };
};

describe("processChatLine — auto-memory hook", () => {
  it("hands a completed turn to the hook with the rendered transcript", async () => {
    const { hook, seen } = recorder();
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["bar() is."] })],
    });
    const result = await processChatLine({
      line: "which entry point is thread-safe?",
      ctx: { ...ctx, autoMemory: hook },
    });

    assert.equal(result.ranQuery, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.stopReason, "completed");
    assert.equal(seen[0]!.sessionKey, "chat");
    assert.match(seen[0]!.transcript, /which entry point is thread-safe\?/);
    assert.match(seen[0]!.transcript, /bar\(\) is\./);
  });

  it("still hands over a non-completed turn so the hook owns the gate", async () => {
    const { hook, seen } = recorder();
    const ctx = makeCtx({
      responses: [assistantResult({ texts: [], supplierStop: "truncation" })],
    });
    await processChatLine({ line: "hello", ctx: { ...ctx, autoMemory: hook } });
    assert.equal(seen.length, 1);
    assert.notEqual(
      seen[0]!.stopReason,
      "completed",
      "the host reports the reason; the hook decides"
    );
  });

  it("does not touch the hook for a slash command", async () => {
    const { hook, seen } = recorder();
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["unused"] })],
    });
    const result = await processChatLine({
      line: "/status",
      ctx: { ...ctx, autoMemory: hook },
    });
    assert.equal(result.ranQuery, undefined);
    assert.deepEqual(seen, []);
  });

  it("keeps the turn successful when the hook throws", async () => {
    const ctx = makeCtx({ responses: [assistantResult({ texts: ["reply"] })] });
    const result = await processChatLine({
      line: "hello",
      ctx: {
        ...ctx,
        autoMemory: {
          onTurnComplete: () => {
            throw new Error("hook exploded");
          },
          drain: async () => {},
        },
      },
    });
    assert.equal(result.ranQuery, true);
    assert.ok(result.output.includes("reply"), result.output);
  });

  it("behaves exactly as before when no hook is wired", async () => {
    const ctx = makeCtx({ responses: [assistantResult({ texts: ["reply"] })] });
    const result = await processChatLine({ line: "hello", ctx });
    assert.equal(result.ranQuery, true);
    assert.ok(result.output.includes("reply"));
  });
});
