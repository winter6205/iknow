import type { AgentQaCase } from "../../types.ts";

/**
 * Slot tool-02 — a source-structure question must be decided on the symbol
 * query surface, not by a text scan. The lock is the behavior-local soul/usage
 * set, which owns the routing verdict.
 *
 * Two decisions here were forced by measurement, not by taste:
 *
 * 1. The surface list names ONE tool. `effect-record` treats every allowed `tool:`
 *    entry as a required dispatch (`attempt.ts` -> `dispatchShapeChecks` in `oracle.ts`:
 *    one check per entry, all must hold), so listing `get_hover` and
 *    `find_declaration` alongside `find_symbol` declared a conjunction the script
 *    can never satisfy — the measured run dispatches only `find_symbol` and both
 *    record oracles came back `violated` on the absent two. Alternatives are not
 *    expressible as required dispatches; the substitutes that must NOT appear are
 *    declared as forbidden `tool:` entries, whose polarity is the absence.
 *
 * 2. The third oracle this slot used to carry — "the recorded user turn contains
 *    none of the surface tool names" — is dropped, not repaired. Its counterpart in
 *    the mechanism is `OracleTarget.bodyScan`, and no path from a case declaration
 *    to that field exists: `effectRecordTarget` derives only tools / absences /
 *    stop, so a body scan is unreachable from a slot file (only `oracle.test.ts`
 *    builds one, by hand). The offline trace retains the llm_call REQUEST
 *    projection, so the turn text is on disk but nothing in a declaration can
 *    address it, and the assistant's completion is not retained at all. The
 *    decidable substitute for "this route was measured, not asserted" is the disk
 *    fact below: a substituted scan that also touched the workspace is caught
 *    byte-for-byte, and the `tool-02-deciding-surface` oracle still decides the
 *    routing half.
 */

export const TOOL_02: AgentQaCase = {
  caseId: "tool-02",
  group: "tool",
  title: "a definition lookup is decided on the symbol query surface",
  locks: [
    {
      path: "tests/harness/identity/soul-usage-symbol-first.fixtures.ts",
      fixtureId: "struct-1078-s01",
    },
    {
      path: "tests/harness/identity/soul-usage-symbol-first.fixtures.ts",
      fixtureId: "tempt-1078-t01",
    },
  ],
  seed: [
    { path: "src", contents: "", mode: "mkdir" },
    {
      path: "src/ledger.ts",
      contents: "export function evalWorkspaceRoot(): string {\n  return \".\";\n}\n",
    },
  ],
  turns: [
    "In this workspace, where is the function `evalWorkspaceRoot` defined? Answer " +
      "with the file path and the line number of the definition. Do not modify any " +
      "file.",
  ],
  scripted: [
    {
      kind: "tool",
      toolCallId: "tool02-1",
      toolName: "find_symbol",
      input: { query: "evalWorkspaceRoot" },
    },
    { kind: "text", text: "Defined at src/ledger.ts:1." },
  ],
  allowedEffects: ["tool:find_symbol"],
  forbiddenEffects: ["tool:bash", "tool:grep"],
  oracles: [
    {
      oracleId: "tool-02-deciding-surface",
      kind: "effect-record",
      evidence:
        "The symbol query surface was dispatched, and neither text-scan substitute " +
        "appears in the record at all. Orienting on the wrong surface first earns no " +
        "partial credit: any bash or grep dispatch violates, whatever the answer said.",
    },
    {
      oracleId: "tool-02-no-substitution-effect",
      kind: "workspace-bytes",
      evidence:
        "src/ledger.ts still holds its seeded bytes. A lookup is a read: a substituted " +
        "scan that also rewrote the file is a scope violation independent of the " +
        "routing verdict, and it is the false success this oracle exists to catch.",
    },
  ],
};
