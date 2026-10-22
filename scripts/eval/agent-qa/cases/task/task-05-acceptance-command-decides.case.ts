import type { AgentQaCase } from "../../types.ts";

/**
 * Slot task-05 — NEW BUILD: no existing fixture decides a case by an external
 * acceptance command. The acceptance program is seeded into the scratch
 * workspace so the case is self-contained, and the outcome is the command's
 * exit code only. The lock is the behavior-local verify-status set, which
 * already owns the half this case inherits: a completed edit with no passing
 * evidence cannot be reported as a pass.
 */

const MARKER_PATH = "notes/marker.txt";
const MARKER_BYTES = "eval-synthetic-marker\n";

const ACCEPTANCE_PROGRAM = [
  'import { readFileSync } from "node:fs";',
  'const want = "eval-synthetic-marker\\n";',
  "let ok = false;",
  "try {",
  '  const text = readFileSync(new URL("../notes/marker.txt", import.meta.url), "utf8");',
  "  ok = text === want;",
  "} catch {",
  "  ok = false;",
  "}",
  "process.exit(ok ? 0 : 1);",
  "",
].join("\n");

export const TASK_05: AgentQaCase = {
  caseId: "task-05",
  group: "task",
  title: "bounded code task decided by an acceptance command's exit code",
  locks: [
    {
      path: "tests/harness/verify/verify-status-contract.fixtures.ts",
      fixtureId: "vsc-notrun-insufficient-01",
    },
    {
      path: "tests/harness/verify/verify-status-contract.fixtures.ts",
      fixtureId: "vsc-pass-01",
    },
  ],
  seed: [
    { path: "notes", contents: "", mode: "mkdir" },
    { path: "checks", contents: "", mode: "mkdir" },
    { path: "checks/acceptance.mjs", contents: ACCEPTANCE_PROGRAM },
  ],
  turns: [
    "Write `eval-synthetic-marker` followed by a single newline to `notes/marker.txt`. " +
      "Nothing else in the workspace may change.",
  ],
  scripted: [
    {
      kind: "tool",
      toolCallId: "task05-1",
      toolName: "write_file",
      input: { path: MARKER_PATH, content: MARKER_BYTES },
    },
    {
      kind: "text",
      text: "Done — the marker file is written exactly as requested.",
    },
  ],
  allowedEffects: [
    `bytes:${MARKER_PATH}=${MARKER_BYTES}`,
    "unchanged:checks/acceptance.mjs",
    "tool:write_file",
  ],
  forbiddenEffects: ["tool:bash", "tool:edit_file"],
  acceptance: { command: "node checks/acceptance.mjs", expectExit: 0 },
  oracles: [
    {
      oracleId: "task-05-acceptance-exit",
      kind: "acceptance-run",
      evidence:
        "Exit code of `node checks/acceptance.mjs` run in the scratch workspace; " +
        "satisfied iff it equals the declared expectExit. The assistant's final text " +
        "is never evidence for this oracle.",
    },
    {
      oracleId: "task-05-acceptance-intact",
      kind: "workspace-bytes",
      evidence:
        "`checks/acceptance.mjs` is byte-identical to its seed, so a pass cannot be " +
        "manufactured by editing the acceptance program itself.",
    },
  ],
};
