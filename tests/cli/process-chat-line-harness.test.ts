/**
 * Focused integration coverage for `processChatLine` on the harness path
 * (plan T5 acceptance).
 *
 * Three guarantees pinned:
 *   1. Multi-turn pipe: same ctx reused across queries strictly grows the
 *      `messages` history (host 续传 priorMessages via `run`'s 4th arg).
 *   2. `/reset` clears `messages` but preserves the `session` object.
 *   3. `/status` reflects `state.messages.length` (NOT the old `turns.length`).
 *
 * Uses harness stubs (`createStubModel` / `createStubTool` / `createRegistry`
 * / `createExecutor`) the same way as `tests/harness/loop-engine.test.ts`.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { processChatLine } from "../../src/cli/chat-session.ts";
import { applySlashCommand } from "../../src/cli/slash.ts";
import {
  assistantResult,
  makeCtx,
  makeNative,
  makeState,
} from "./_fixtures.ts";

describe("processChatLine harness path", () => {
  it("two-turn pipe continuation: same ctx strictly grows messages; priorMessages really 续传", async () => {
    const ctx = makeCtx({
      responses: [
        assistantResult({ texts: ["reply-1"] }),
        assistantResult({ texts: ["reply-2"] }),
      ],
    });

    // Turn 1: empty history → produces [user, assistant] = 2 messages.
    const r1 = await processChatLine({ line: "question one", ctx });
    assert.equal(r1.quit, false);
    assert.equal(r1.ranQuery, true);
    assert.equal(ctx.state.messages.length, 2);
    assert.equal(ctx.state.messages[0]!.role, "user");
    assert.equal(ctx.state.messages[1]!.role, "assistant");
    const turn1UserText = (
      ctx.state.messages[0]!.content[0] as { type: "text"; text: string }
    ).text;
    assert.equal(turn1UserText, "question one");

    const beforeTurn2 = ctx.state.messages.length;
    // Turn 2: priorMessages should contain turn 1's full history → output is
    // [user1, assistant1, user2, assistant2] = 4 messages after run.
    const r2 = await processChatLine({ line: "question two", ctx });
    assert.equal(r2.quit, false);
    assert.equal(r2.ranQuery, true);
    assert.ok(
      ctx.state.messages.length > beforeTurn2,
      "messages must strictly grow after turn 2"
    );
    assert.equal(ctx.state.messages.length, beforeTurn2 + 2);

    // Strictly grew (3 → 4 in our case). History head preserves turn 1.
    assert.equal(ctx.state.messages[0]!.role, "user");
    assert.equal(
      (ctx.state.messages[0]!.content[0] as { type: "text"; text: string })
        .text,
      "question one"
    );
    // Turn 2's user message must be the last-but-one user role.
    assert.equal(
      ctx.state.messages[beforeTurn2]!.role,
      "user",
      "turn 2 user message appended after turn 1 history"
    );
    assert.equal(
      (
        ctx.state.messages[beforeTurn2]!.content[0] as {
          type: "text";
          text: string;
        }
      ).text,
      "question two"
    );
    // Turn 2's assistant message is the most recent.
    const lastMsg = ctx.state.messages[ctx.state.messages.length - 1]!;
    assert.equal(lastMsg.role, "assistant");
    assert.equal(
      (lastMsg.content[0] as { type: "text"; text: string }).text,
      "reply-2"
    );
  });

  it("/reset clears messages but preserves the session object", async () => {
    // Seed messages + a distinct session object.
    const session = {};
    const ctx = makeCtx({
      responses: [],
      stateOverrides: {
        messages: [
          makeNative({ role: "user", text: "x" }),
          makeNative({ role: "assistant", text: "y" }),
        ],
        session,
      },
    });
    assert.equal(ctx.state.messages.length, 2);

    const r = await processChatLine({ line: "/reset", ctx });
    assert.equal(r.quit, false);
    assert.match(r.output, /cleared|Session/i);
    // /reset clears messages.
    assert.equal(ctx.state.messages.length, 0);
    // /reset preserves the session object (same reference).
    assert.equal(ctx.state.session, session);
  });

  it("/status renders state.messages.length (NOT turns.length) + json", async () => {
    // 020 frozen shape: `messages=N`, NOT `turns=N`. No `role=` / `mode=` / `priors=`.
    const state = makeState({
      messages: [
        makeNative({ role: "user", text: "a" }),
        makeNative({ role: "assistant", text: "b" }),
        makeNative({ role: "user", text: "c" }),
        makeNative({ role: "assistant", text: "d" }),
        makeNative({ role: "user", text: "e" }),
      ],
      jsonMode: false,
    });
    // Drive through applySlashCommand directly to assert the canonical line
    // (this is the same path processChatLine uses for slash lines).
    const eff = applySlashCommand({
      command: "status",
      args: [],
      ctx: { state },
    });
    assert.equal(eff.type, "info");
    if (eff.type !== "info") return;
    assert.match(eff.text, /messages=5/);
    assert.match(eff.text, /json=off/);
    assert.ok(
      !eff.text.includes("turns="),
      "status must not contain the removed `turns=` line"
    );
    assert.ok(!eff.text.includes("role="));
    assert.ok(!eff.text.includes("mode="));
    assert.ok(!eff.text.includes("priors="));
  });

  it("emptyFinalResponse drops context (no dangling user message续传)", async () => {
    // isEmptyFinalResponse is set by assistantResult when supplierStop is
    // "success" and both texts and toolCalls are empty (see helper above).
    // loop-engine returns finalState: state for that branch, so
    // result.messages = priorMessages + [dangling currentUserText] with no
    // assistant reply. processChatLine must NOT replace ctx.state.messages
    // with that dangling version — continuing next turn would feed a
    // dangling user message to the model and poison the loop.
    const ctx = makeCtx({
      responses: [assistantResult({ texts: [] })],
    });
    const before = ctx.state.messages.length;
    assert.equal(before, 0);

    const r = await processChatLine({ line: "some query", ctx });
    // Empty final response still produced output (the run path took the
    // emptyFinalResponse branch and the formatter rendered something).
    assert.equal(r.quit, false);
    assert.equal(r.ranQuery, true);

    // Context dropped: NOT replaced with the dangling-user version.
    // If the bug were present, ctx.state.messages would be [dangling user] (length 1).
    assert.equal(
      ctx.state.messages.length,
      before,
      "emptyFinalResponse must drop context (no dangling user message续传)"
    );
    assert.notEqual(
      ctx.state.messages.length,
      before + 1,
      "messages must NOT be poisoned with a dangling user message"
    );
  });
});
