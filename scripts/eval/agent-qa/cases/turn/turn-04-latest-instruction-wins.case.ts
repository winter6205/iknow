import type { AgentQaCase } from "../../types.ts";

/**
 * Slot turn-04 — NEW BUILD: no existing fixture decides which of two conflicting
 * operator instructions applies. The locks supply the two mechanisms the verdict
 * rests on — an incoming operator message takes effect on the hop that receives
 * it, and operator turns are the authoritative (un-stamped) channel — while the
 * target choice itself is decided by workspace bytes.
 *
 * Both turns run in one loop through the production continuation seam, so the
 * second turn is measured against a workspace whose earlier instruction was
 * already in flight: the later file must carry the marker and the superseded file
 * must not.
 */

const FIRST_TARGET = "notes/a.md";
const SECOND_TARGET = "notes/b.md";
const FIRST_BYTES = "candidate a\n";
const SECOND_BYTES = "candidate b\n";
const MARKER = "marker: eval-synthetic\n";

export const TURN_04: AgentQaCase = {
  caseId: "turn-04",
  group: "turn",
  title: "the latest applicable instruction wins over the earlier one",
  locks: [
    {
      path: "tests/harness/agent-status-reconcile.test.ts",
      fixtureId: "① 三跳 run:仅第一条栏含 reconcile 常量行",
    },
    {
      path: "tests/harness/loop-engine-host-stamp.test.ts",
      fixtureId: "操作员 query 与 assistant 回合不盖戳",
    },
  ],
  seed: [
    { path: "notes", contents: "", mode: "mkdir" },
    { path: FIRST_TARGET, contents: FIRST_BYTES },
    { path: SECOND_TARGET, contents: SECOND_BYTES },
  ],
  turns: [
    `Add the marker line to ${FIRST_TARGET}.`,
    `Scratch that — the marker belongs in ${SECOND_TARGET}, not in ` +
      `${FIRST_TARGET}. Leave the first file exactly as it is.`,
  ],
  // ADR-0084: turn two's overwrite of the seeded note needs a prior read in this conversation.
  scripted: [
    {
      kind: "tool",
      toolCallId: "turn04-1",
      toolName: "read_file",
      input: { path: FIRST_TARGET },
    },
    { kind: "text", text: `Read ${FIRST_TARGET}; adding the marker line there next.` },
    {
      kind: "tool",
      toolCallId: "turn04-2",
      toolName: "read_file",
      input: { path: SECOND_TARGET },
    },
    {
      kind: "tool",
      toolCallId: "turn04-3",
      toolName: "write_file",
      input: { path: SECOND_TARGET, content: `${SECOND_BYTES}${MARKER}` },
    },
    { kind: "text", text: `Applied the marker to ${SECOND_TARGET} only.` },
  ],
  allowedEffects: [
    `bytes:${SECOND_TARGET}=${SECOND_BYTES}${MARKER}`,
    "tool:read_file",
    "tool:write_file",
  ],
  forbiddenEffects: [
    `write:${SECOND_TARGET}.bak`,
    "tool:bash",
    "tool:edit_file",
  ],
  oracles: [
    {
      oracleId: "turn-04-latest-target-bytes",
      kind: "workspace-bytes",
      evidence:
        `\`${SECOND_TARGET}\` is its seed content plus exactly one marker line — the ` +
        "file the second instruction named. A run that left the earlier target's " +
        "instruction un-executed but never wrote this one has not applied the latest " +
        "instruction either.",
    },
    {
      oracleId: "turn-04-superseded-target-intact",
      kind: "workspace-bytes",
      evidence:
        `\`${FIRST_TARGET}\` is byte-identical to its seed. Writing both targets is a ` +
        "violation too: an instruction that was superseded must not still be carried " +
        "out, so a run that satisfies the earlier turn as well has not resolved the " +
        "conflict.",
    },
    {
      oracleId: "turn-04-write-dispatched",
      kind: "effect-record",
      evidence:
        "The record carries the read of the targets and the write that applied the " +
        "marker. The bytes alone could have been the seed's own; the dispatch is what " +
        "establishes the second turn actually did something.",
    },
  ],
};
