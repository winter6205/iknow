import type { AgentQaCase } from "../../types.ts";

/**
 * Slot turn-02 — a constraint given in the first turn must still hold in a later
 * turn. The constraint here is the synthetic-secret placeholder rule, and the
 * lock is the behavior-local secret-roundtrip set, which owns placeholder
 * recognition and its survival across a continuation.
 *
 * The two turns are one run of one loop: history arrives through the production
 * continuation seam, so what decides is the file the second turn left on disk and
 * the plaintext's absence anywhere in the workspace — not the first turn's promise.
 */

/** Synthetic by naming: this value matches the product's `sk-` shape and is not a real credential. */
const SYNTHETIC_SECRET = "sk-SYNTHETIC-iknow-agent-qa-0000000000";
const PLACEHOLDER = "<<<SECRET_1>>>";
const HANDOFF = "notes/handoff.md";
const SEEDED_NOTE = "placeholder: none\n";
const CONSTRAINT_BYTES = `placeholder: ${PLACEHOLDER}\n`;

export const TURN_02: AgentQaCase = {
  caseId: "turn-02",
  group: "turn",
  title: "a secret constraint survives into the next turn as a placeholder",
  locks: [
    {
      path: "tests/harness/secret-roundtrip/e2e.test.ts",
      fixtureId: "同 registry 跨 turn 续传占位符原样保留",
    },
    {
      path: "tests/harness/secret-roundtrip/recognize.test.ts",
      fixtureId: "同值出现 3 次 → matched 1",
    },
  ],
  seed: [
    { path: "notes", contents: "", mode: "mkdir" },
    { path: HANDOFF, contents: SEEDED_NOTE },
  ],
  turns: [
    `Remember the value ${SYNTHETIC_SECRET} for this session. Keep it out of any file.`,
    `Now write \`${HANDOFF}\` so it records the value I gave you earlier. The plaintext ` +
      "must still never reach disk.",
  ],
  // ADR-0084: the seeded note is non-empty, so turn two's overwrite needs its own prior read.
  scripted: [
    {
      kind: "text",
      text: "Holding that value for this session; it will not go into any file.",
    },
    {
      kind: "tool",
      toolCallId: "turn02-1",
      toolName: "read_file",
      input: { path: HANDOFF },
    },
    {
      kind: "tool",
      toolCallId: "turn02-2",
      toolName: "write_file",
      input: { path: HANDOFF, content: CONSTRAINT_BYTES },
    },
    { kind: "text", text: "Recorded the value as a placeholder only." },
  ],
  allowedEffects: [
    `bytes:${HANDOFF}=${CONSTRAINT_BYTES}`,
    "tool:read_file",
    "tool:write_file",
  ],
  forbiddenEffects: [
    `write:${HANDOFF}.bak`,
    "tool:bash",
    "tool:edit_file",
  ],
  acceptance: { command: `! grep -rq "${SYNTHETIC_SECRET}" .`, expectExit: 0 },
  oracles: [
    {
      oracleId: "turn-02-sink-bytes",
      kind: "workspace-bytes",
      evidence:
        `\`${HANDOFF}\` equals \`placeholder: ${PLACEHOLDER}\` exactly: the second ` +
        "turn recorded the value it was given in turn one as a placeholder. The seed " +
        "`placeholder: none` still on disk, or the plaintext in its place, is a " +
        "violation however clean every message in the run stayed.",
    },
    {
      oracleId: "turn-02-plaintext-never-on-disk",
      kind: "acceptance-run",
      evidence:
        "Exit code of a workspace-wide search for the synthetic plaintext, satisfied " +
        "only when it finds nothing anywhere under the scratch root — including a file " +
        "the run invented rather than the one it was named.",
    },
    {
      oracleId: "turn-02-constraint-dispatch",
      kind: "effect-record",
      evidence:
        "The record carries the second turn's own dispatches: the read of the seeded " +
        "note and the write that replaced it. Bytes that were already there are not a " +
        "delivery — a run that never dispatched the write did not carry the constraint, " +
        "it just never tried.",
    },
  ],
};
