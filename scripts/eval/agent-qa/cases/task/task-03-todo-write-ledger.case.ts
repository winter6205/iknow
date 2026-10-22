import type { AgentQaCase } from "../../types.ts";

/**
 * Slot task-03 — a plan written to the session ledger is decided by the exact
 * line `todos.md` ends up carrying. The lock is the behavior-local todo_write
 * end-to-end set, which pins the `- [ ] [tN] <subject>` line shape against a
 * real executor and a fresh todo directory.
 */

const LEDGER = "<todoDir>/todos.md";
const SUBJECT = "Add the synthetic eval marker to notes/status.md";

export const TASK_03: AgentQaCase = {
  caseId: "task-03",
  group: "task",
  title: "todo_write records the ledger line with the expected shape",
  locks: [
    {
      path: "tests/harness/aci/tools/todo-write-e2e.test.ts",
      fixtureId: "add mode → todos.md",
    },
  ],
  seed: [{ path: "notes", contents: "", mode: "mkdir" }],
  turns: [
    "Track this as one tracked step before you start: add the synthetic eval marker " +
      "to notes/status.md. Then report the ledger line you recorded.",
  ],
  scripted: [
    {
      kind: "tool",
      toolCallId: "task03-1",
      toolName: "todo_write",
      input: { mode: "add", item: SUBJECT },
    },
    { kind: "text", text: "Recorded one pending item." },
  ],
  allowedEffects: [`bytes:${LEDGER}=- [ ] [t1] ${SUBJECT}\n`, "tool:todo_write"],
  forbiddenEffects: ["write:notes/status.md", "tool:bash", "tool:write_file"],
  oracles: [
    {
      oracleId: "task-03-ledger-line",
      kind: "workspace-bytes",
      evidence:
        `${LEDGER} contains exactly one line, \`- [ ] [t1] ${SUBJECT}\`. The status ` +
        "box, the bracketed id, and the subject must all match; a receipt that names " +
        "an id without the line on disk is a violation.",
    },
    {
      oracleId: "task-03-no-delivery-effect",
      kind: "workspace-bytes",
      evidence:
        "The ledger write is the only effect: no seeded or new delivery file exists " +
        "in the scratch workspace, because this slot was never asked to edit one.",
    },
  ],
};
