import type { AgentQaCase } from "../../types.ts";

/**
 * Slot recovery-03 — the repeated failure is the product's own: `todo_write` with
 * `mode: "update"` and no `id` fails input validation, three identical such phases
 * trip the engine's narrow validation-stall fuse, and the ledger bytes prove the
 * one application, since `add` mints a fresh serial per call instead of deduping.
 * The two halves are decided apart: the byte oracle reads the ledger row, the
 * record oracle reads the retry dispatches plus the stop reason the runner recorded.
 */

const LEDGER = "<todoDir>/todos.md";
const SUBJECT = "Apply the synthetic marker once";
const ROW = `- [ ] [t1] ${SUBJECT}`;

export const RECOVERY_03: AgentQaCase = {
  caseId: "recovery-03",
  group: "recovery",
  title: "repeated failure stops boundedly without duplicating the effect",
  locks: [
    {
      path: "tests/harness/loop-engine-tool-loop.test.ts",
      fixtureId:
        "same invalid todo_write ×3 → fused on the 3rd phase, before generic R=5",
    },
    {
      path: "tests/harness/aci/tools/todo-write-per-conversation.test.ts",
      fixtureId: "ledger physically lands at <todoDir>/<conversationId>/todos.md",
    },
  ],
  seed: [{ path: "notes", contents: "", mode: "mkdir" }],
  turns: [
    `Add exactly one item to the conversation todo list, \`${SUBJECT}\`, then mark ` +
      "that item done. Report the ledger contents you observed.",
  ],
  scripted: [
    {
      kind: "tool",
      toolCallId: "rec03-1",
      toolName: "todo_write",
      input: { mode: "add", item: SUBJECT },
    },
    {
      kind: "tool",
      toolCallId: "rec03-2",
      toolName: "todo_write",
      input: { mode: "update", status: "done" },
    },
    {
      kind: "tool",
      toolCallId: "rec03-3",
      toolName: "todo_write",
      input: { mode: "update", status: "done" },
    },
    {
      kind: "tool",
      toolCallId: "rec03-4",
      toolName: "todo_write",
      input: { mode: "update", status: "done" },
    },
    {
      kind: "text",
      text:
        "The item was added once; the three attempts to mark it done were rejected " +
        "for missing arguments, so the ledger still holds a single row.",
    },
  ],
  allowedEffects: [`bytes:${LEDGER}=${ROW}\n`, "tool:todo_write", "stopped:fused"],
  // One exact `bytes:` value is the no-duplicate claim, and `stopped:fused` is the
  // boundedness claim: both are read, so no slot-specific name is declared beside them.
  forbiddenEffects: ["write:notes/stray.md", "tool:bash"],
  oracles: [
    {
      oracleId: "recovery-03-single-row",
      kind: "workspace-bytes",
      // No `owns` here on purpose: the owned entry names `<todoDir>`, and the owns list
      // is read off the lock, where no per-attempt swap reaches it.
      evidence:
        `${LEDGER} holds exactly one line equal to \`${ROW}\`. Zero rows means the ` +
        "effect never landed; two rows means the bounded stop arrived after the " +
        "retries had already applied it again, which is the failure this slot exists " +
        "to catch. Retried calls alone must leave the file byte-identical.",
    },
    {
      oracleId: "recovery-03-bounded-stop",
      kind: "effect-record",
      owns: ["tool:todo_write", "stopped:fused"],
      evidence:
        "The run stops on a recorded limit — the validation-stall fuse or the turn " +
        "ceiling — at or before the declared budget, and the number of turns actually " +
        "run is retained. A stop readable only from the assistant's closing prose is " +
        "not a bounded stop, so the reason the runner recorded is the fact on trial.",
    },
  ],
};
