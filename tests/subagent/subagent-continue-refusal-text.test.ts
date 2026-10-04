/**
 * STATIC lock on the model-visible refusal text of `subagent_continue`.
 *
 * SC26 classifies tool rejection text as a model-input surface: the model reads
 * it and chooses its next move from it, so rewording is a versioned change
 * rather than a cosmetic one. `docs/guides/prompt-development.md` requires a
 * surface without a trajectory set to at least carry a STATIC lock and to have
 * its gap registered — this file is that lock for the
 * `prior_process_unconfirmed` kind added by session saved-state plan B.
 *
 * What is pinned, and why each part: the kind stays on the surface so the typed
 * error contract is legible, the task id names what is blocked, the
 * "not proven stopped" clause is the actual refusal, and the trailing clause is
 * the way out. A refusal that stops naming a remedy regresses the behavior the
 * whole surface exists for, so the remedy clause is asserted as a whole rather
 * than sampled.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { SubAgentResumeError } from "../../src/harness/subagent/manager.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import { createSubAgentContinueTool } from "../../src/harness/subagent/subagent-continue-tool.ts";
import type {
  SubAgentDefinition,
  SubAgentManager,
} from "../../src/harness/subagent/manager.ts";

/**
 * The `next` def the handler builds for a continuation hop. Held as a fixture
 * rather than inlined at each call because it is the shape the manager merges
 * the rehydrated identity into: a `SubAgentDefinition` carries only turn and
 * delivery fields, so `role` is absent by construction and the agent type
 * arrives from the durable record instead. Asserting the type compiles is part
 * of this file's job — a fixture that drifts from the real shape would make the
 * refusal lock test a fiction.
 */
const NEXT: SubAgentDefinition = {
  conversationId: "conv-1",
  role: "general",
  task: "continue please",
};

/**
 * The manager stub refuses with `err`, and records the def it was handed, so a
 * test can assert the refusal path received the real continuation fields.
 */
function managerRefusing(
  err: SubAgentResumeError,
  seen?: { def?: SubAgentDefinition }
): SubAgentManager {
  return {
    // Empty list: the ownership gate is then a no-op, so the refusal under
    // test is the one produced by the resume path and nothing else.
    listSubagents: () => [],
    resumeTask: (_taskId: string, def: SubAgentDefinition) => {
      if (seen !== undefined) seen.def = def;
      throw err;
    },
  } as unknown as SubAgentManager;
}

async function refusalTextFor(
  err: SubAgentResumeError,
  seen?: { def?: SubAgentDefinition }
): Promise<string> {
  const tool = createSubAgentContinueTool({
    manager: managerRefusing(err, seen),
  });
  // The handler throws the typed refusal rather than returning a failed
  // result — the executor is what turns it into model-visible text — so the
  // lock is placed on the thrown message.
  try {
    await tool.handler(
      { task_id: err.taskId, message: NEXT.task } as never,
      { conversationId: NEXT.conversationId } as never
    );
  } catch (thrown) {
    assert.ok(
      thrown instanceof ToolExecutionError,
      `expected a ToolExecutionError, got ${String(thrown)}`
    );
    return thrown.message;
  }
  assert.fail("expected the resume refusal to be thrown, but it returned");
}

describe("subagent_continue refusal text (STATIC lock)", () => {
  it("names the kind, the task, the refusal and the remedy when the prior process is unconfirmed", async () => {
    const text = await refusalTextFor(
      new SubAgentResumeError("t-42", "prior_process_unconfirmed")
    );
    assert.match(text, /prior_process_unconfirmed/);
    assert.match(text, /t-42/);
    assert.match(text, /not proven stopped/);
    // The remedy must remain a complete instruction, not a label: the model
    // has to be able to act on it without a second attempt.
    assert.match(text, /stop or end that process first, then retry/);
  });

  it("carries the confirmation detail through so the model can tell still-running from unidentifiable", async () => {
    const text = await refusalTextFor(
      new SubAgentResumeError(
        "t-42",
        "prior_process_unconfirmed",
        "identity_unreadable"
      )
    );
    assert.match(text, /identity_unreadable/);
    // The reason is additional information, never a replacement for the
    // refusal: the remedy clause must survive alongside it.
    assert.match(text, /not proven stopped/);
    assert.match(text, /then retry the continuation/);
  });

  it("omits the detail parenthetical when no detail was supplied", async () => {
    const text = await refusalTextFor(
      new SubAgentResumeError("t-42", "prior_process_unconfirmed")
    );
    assert.doesNotMatch(text, /\(\)/);
  });

  it("never tells the model the task did not exist, because a task on disk may be unprovable", async () => {
    // After a host restart a task id can carry a durable record and a worker
    // transcript while nothing proves the former process is gone. Saying
    // "unknown task" there would send the model off to spawn a duplicate worker
    // behind the same history, so the unprovable case must stay on the
    // `prior_process_unconfirmed` surface with its remedy.
    const text = await refusalTextFor(
      new SubAgentResumeError("t-42", "prior_process_unconfirmed")
    );
    assert.doesNotMatch(text, /no task .* is known/);
    assert.doesNotMatch(text, /not_found/);
  });

  it("hands the resume path the real continuation fields, not a placeholder", async () => {
    const seen: { def?: SubAgentDefinition } = {};
    await refusalTextFor(
      new SubAgentResumeError("t-42", "prior_process_unconfirmed"),
      seen
    );
    // The `NEXT` fixture is only worth holding if the handler forwards its task
    // text verbatim: that text is what the resumed worker would run.
    assert.equal(seen.def?.task, NEXT.task);
  });
});
