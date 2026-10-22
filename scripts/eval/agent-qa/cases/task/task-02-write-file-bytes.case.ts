import type { AgentQaCase } from "../../types.ts";

/**
 * Slot task-02 — a bounded file write under the scratch root, decided by the
 * bytes on disk. The lock is the behavior-local write_file set, which already
 * pins create, overwrite, and parent-directory creation against real temp dirs.
 */

const OLD_NOTE = "status: draft\n";
const NEW_NOTE = "status: verified\nowner: eval-synthetic\n";

export const TASK_02: AgentQaCase = {
  caseId: "task-02",
  group: "task",
  title: "write_file creates and overwrites a scratch file, bytes verified",
  locks: [
    {
      path: "tests/harness/aci/tools/write-file.test.ts",
      fixtureId: "overwrites the complete contents of an existing file",
    },
    {
      path: "tests/harness/aci/tools/write-file.test.ts",
      fixtureId: "creates a new file and returns a stable relative-path",
    },
  ],
  seed: [
    { path: "notes", contents: "", mode: "mkdir" },
    { path: "notes/status.md", contents: OLD_NOTE },
    { path: "notes/unrelated.md", contents: "do not touch\n" },
  ],
  turns: [
    "Replace the whole contents of `notes/status.md` with exactly `status: verified` " +
      "on the first line and `owner: eval-synthetic` on the second line. Leave every " +
      "other file in the workspace alone.",
  ],
  // The read step is load-bearing: write_file refuses an overwrite the session never read (ADR-0084).
  scripted: [
    {
      kind: "tool",
      toolCallId: "task02-1",
      toolName: "read_file",
      input: { path: "notes/status.md" },
    },
    {
      kind: "tool",
      toolCallId: "task02-2",
      toolName: "write_file",
      input: { path: "notes/status.md", content: NEW_NOTE },
    },
    { kind: "text", text: "Rewrote notes/status.md with the two required lines." },
  ],
  allowedEffects: [
    "bytes:notes/status.md=" + NEW_NOTE,
    "tool:read_file",
    "tool:write_file",
  ],
  forbiddenEffects: ["write:notes/status.md.bak", "tool:edit_file", "tool:bash"],
  oracles: [
    {
      oracleId: "task-02-target-bytes",
      kind: "workspace-bytes",
      evidence:
        "`notes/status.md` equals the two-line block exactly, with no leftover " +
        "`status: draft` line. Prose that says the file was replaced while the old " +
        "line survives is a violation.",
    },
    {
      oracleId: "task-02-scope-bytes",
      kind: "workspace-bytes",
      evidence:
        "Every other seeded path is byte-identical to its seed and " +
        "`notes/status.md.bak` does not exist: the rewrite is graded in place, not by " +
        "leaving a copy of the old file behind.",
    },
  ],
};
