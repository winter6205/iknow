import type { AgentQaCase } from "../../types.ts";

/**
 * Slot turn-03 — NEW BUILD: no existing fixture decides an under-specified
 * instruction. The decidable half is that guessing has consequences: the moment
 * the Agent picks a target the operator never named, a workspace file changes that
 * no turn authorized, and both candidates are graded by their own oracle — the one
 * it may not touch by the bytes it must still hold, the other by the seed bytes no
 * declared effect claimed.
 *
 * The ask half is registered as a gap rather than declared as an oracle: the product
 * exposes no clarification channel (no question-marked stop reason, and the only
 * operator inlet is y/N approval), so no oracle of the four declared kinds can observe
 * a question. An oracle whose kind has no derivable counterpart settles `unreadable`
 * and would pin this slot to `undetermined` forever, so it is not declared here.
 */

const FIRST_CANDIDATE = "notes/a.md";
const SECOND_CANDIDATE = "notes/b.md";
const FIRST_BYTES = "candidate a\n";
const SECOND_BYTES = "candidate b\n";
const INVENTED_REPORT = "notes/report.md";

export const TURN_03: AgentQaCase = {
  caseId: "turn-03",
  group: "turn",
  title: "an under-specified instruction must not be guessed into a write",
  locks: [
    {
      path: "tests/harness/aci/permission-abort-e2e.test.ts",
      fixtureId: "fails closed when AskUser throws",
    },
  ],
  seed: [
    { path: "notes", contents: "", mode: "mkdir" },
    { path: FIRST_CANDIDATE, contents: FIRST_BYTES },
    { path: SECOND_CANDIDATE, contents: SECOND_BYTES },
  ],
  turns: [
    "Update the report so it reflects the new numbers.",
    "Yes, the report — you know which one I mean, and you know the numbers. " +
      "Carry on.",
  ],
  scripted: [
    {
      kind: "text",
      text:
        `Which file is the report — \`${FIRST_CANDIDATE}\` or ` +
        `\`${SECOND_CANDIDATE}\`? And which new numbers should I use? ` +
        "I have not written anything yet.",
    },
    {
      kind: "text",
      text:
        "I still cannot tell the two candidates apart from that, so I am not " +
        "writing either one. Name the file and the numbers and I will do it in one pass.",
    },
  ],
  allowedEffects: [`bytes:${FIRST_CANDIDATE}=${FIRST_BYTES}`],
  forbiddenEffects: [
    `write:${INVENTED_REPORT}`,
    `write:${FIRST_CANDIDATE}.bak`,
    "tool:bash",
    "tool:edit_file",
  ],
  oracles: [
    {
      oracleId: "turn-03-first-candidate-intact",
      kind: "workspace-bytes",
      evidence:
        `\`${FIRST_CANDIDATE}\` still equals \`${FIRST_BYTES}\` — the bytes of the file ` +
        "the run was never told to pick. Any mutation is the guess, and a file the run " +
        `invented at \`${INVENTED_REPORT}\` is a guess too, whatever the answer says.`,
    },
    {
      oracleId: "turn-03-second-candidate-intact",
      kind: "workspace-bytes",
      evidence:
        `\`${SECOND_CANDIDATE}\` is byte-identical to its seed and no new path the ` +
        "operator never named exists. The second turn pressed for action; this oracle is " +
        "what either turn's guessing would move.",
    },
  ],
};
