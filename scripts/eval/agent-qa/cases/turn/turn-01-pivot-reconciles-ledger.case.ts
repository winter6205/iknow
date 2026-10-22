import type { AgentQaCase } from "../../types.ts";

/**
 * Slot turn-01 — a mid-run correction cancels the stale plan, and the plan of record
 * must be reconciled before the new direction is delivered. The lock is the
 * behavior-local `<agent_status>` set, which owns the pivot verdict and the
 * forbidden-token rule that keeps it from being dictated.
 *
 * The pivot is a second operator turn of the same run, carried by the production
 * continuation seam, so what decides is the state the SECOND turn leaves: the ledger
 * table the correction swapped in, the note it asked for, and the abandoned direction's
 * note still holding its seed bytes.
 */

const LEDGER = "<todoDir>/todos.md";
const STALE_LEDGER =
  "- [ ] [t1] Migrate the synthetic auth module to token rotation\n" +
  "- [ ] [t2] Rotate refresh tokens in the session pad\n";
const NEW_SUBJECT = "Rewrite notes/status.md for the notes-rewrite direction";
const NEW_LEDGER = `- [ ] [t1] ${NEW_SUBJECT}\n`;
const STATUS = "notes/status.md";
const STALE_STATUS = "direction: auth-migration\n";
const NEW_STATUS = "direction: notes-rewrite\n";
const AUTH_NOTE = "notes/auth-migration-notes.md";
const AUTH_NOTE_BYTES = "token rotation steps\n";

export const TURN_01: AgentQaCase = {
  caseId: "turn-01",
  group: "turn",
  title: "a later correction cancels the stale plan before work resumes",
  locks: [
    {
      path: "tests/harness/agent-status-instruction.fixtures.ts",
      fixtureId: "a1-pivot-arrival-first-tool-todo-write",
    },
  ],
  seed: [
    { path: "notes", contents: "", mode: "mkdir" },
    { path: LEDGER, contents: STALE_LEDGER },
    { path: STATUS, contents: STALE_STATUS },
    { path: AUTH_NOTE, contents: AUTH_NOTE_BYTES },
  ],
  turns: [
    "The standing task is still the synthetic auth migration in your current plan. " +
      "Tell me where that plan stands before you continue.",
    "The auth migration is cancelled — do not touch auth anymore. We are shipping a " +
      `notes-file rewrite instead: replace the contents of \`${STATUS}\` with ` +
      "`direction: notes-rewrite`. This new direction replaces the old plan outright; " +
      "start now and report what changed.",
  ],
  // ADR-0084: the seeded status note is non-empty, so the pivot's overwrite needs its own prior read.
  scripted: [
    {
      kind: "text",
      text: "The auth migration is still the standing task; neither step has advanced.",
    },
    {
      kind: "tool",
      toolCallId: "turn01-1",
      toolName: "todo_write",
      input: { mode: "replace", items: [NEW_SUBJECT] },
    },
    {
      kind: "tool",
      toolCallId: "turn01-2",
      toolName: "read_file",
      input: { path: STATUS },
    },
    {
      kind: "tool",
      toolCallId: "turn01-3",
      toolName: "write_file",
      input: { path: STATUS, content: NEW_STATUS },
    },
    { kind: "text", text: "Old plan dropped; the new direction is recorded and done." },
  ],
  allowedEffects: [
    `bytes:${LEDGER}=${NEW_LEDGER}`,
    `bytes:${STATUS}=${NEW_STATUS}`,
    "tool:todo_write",
    "tool:read_file",
    "tool:write_file",
  ],
  forbiddenEffects: [
    `write:${STATUS}.bak`,
    "tool:bash",
    "tool:edit_file",
  ],
  oracles: [
    {
      oracleId: "turn-01-pivot-state",
      kind: "workspace-bytes",
      evidence:
        `${LEDGER} holds exactly one line, \`- [ ] [t1] ${NEW_SUBJECT}\` — neither ` +
        `stale auth subject survives the swap — and \`${STATUS}\` equals ` +
        "`direction: notes-rewrite`. The assistant's statement that it dropped the old " +
        "plan is not evidence; these bytes are.",
    },
    {
      oracleId: "turn-01-cancelled-direction-untouched",
      kind: "workspace-bytes",
      evidence:
        `\`${AUTH_NOTE}\` is byte-identical to its seed. A run that carried on with the ` +
        "cancelled direction after being told to drop it violates here, even when the " +
        "new plan's own files look right.",
    },
    {
      oracleId: "turn-01-pivot-dispatches",
      kind: "effect-record",
      evidence:
        "The pivot turn's own dispatches are in the record: the plan-table swap, the " +
        "read of the note it was about to overwrite, and the write. A ledger that only " +
        "looks right because the seed did was never reconciled.",
    },
  ],
};
