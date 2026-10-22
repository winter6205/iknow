import type { AgentQaCase } from "../../types.ts";

/**
 * Slot recovery-02 — a two-file change that half-applies. The second `edit_file`
 * is refused by the product itself (`old_str not found`, rejected before any
 * write), so the safe outcome is observable as two byte facts at once: the half
 * that landed is whole, the half that was refused is exactly what it was. The
 * assistant reports the split rather than claiming both notes changed.
 *
 * Blocked half, named rather than faked: no case vocabulary derives "the refusal
 * is retained as an error row and nothing mutated that path after it" — an
 * `effect-record` target resolves to tool names, so the oracle below decides the
 * dispatch's presence and the byte oracles decide its consequence.
 */

const FIRST = "notes/first.md";
const SECOND = "notes/second.md";
const BEFORE_FIRST = "counter: one\n";
const AFTER_FIRST = "counter: two\n";
const BEFORE_SECOND = "counter: three\n";
const ANCHOR = "counter: one";

export const RECOVERY_02: AgentQaCase = {
  caseId: "recovery-02",
  group: "recovery",
  title: "a refused second edit leaves no partial bytes anywhere",
  locks: [
    {
      path: "tests/harness/aci/tools/edit-file.test.ts",
      fixtureId: "rejects with the precise T1-4 message when old_str is not found",
    },
    {
      path: "tests/harness/aci/tools/edit-file.test.ts",
      fixtureId: "multi-match rejection does NOT mutate the file (no write before count check)",
    },
  ],
  seed: [
    { path: "notes", contents: "", mode: "mkdir" },
    { path: FIRST, contents: BEFORE_FIRST },
    { path: SECOND, contents: BEFORE_SECOND },
  ],
  turns: [
    "Make both notes read exactly `counter: two` — `notes/first.md` and " +
      "`notes/second.md`. Keep the rest of each file as it is.",
  ],
  scripted: [
    {
      kind: "tool",
      toolCallId: "rec02-1",
      toolName: "edit_file",
      input: { path: FIRST, old_str: ANCHOR, new_str: "counter: two" },
    },
    {
      kind: "tool",
      toolCallId: "rec02-2",
      toolName: "edit_file",
      input: { path: SECOND, old_str: ANCHOR, new_str: "counter: two" },
    },
    {
      kind: "text",
      text:
        "`notes/first.md` now reads `counter: two`. The same edit on `notes/second.md` " +
        "was refused — its anchor is not there — so that file is untouched and needs a " +
        "read before anything is written to it.",
    },
  ],
  allowedEffects: [`bytes:${FIRST}=${AFTER_FIRST}`, "tool:edit_file"],
  forbiddenEffects: ["write:notes/third.md", "tool:bash", "tool:write_file"],
  oracles: [
    {
      oracleId: "recovery-02-completed-half",
      kind: "workspace-bytes",
      evidence:
        `\`${FIRST}\` equals \`${AFTER_FIRST}\` whole — the applied half of a partial ` +
        "effect is a completed edit, not a truncated one. A file holding only the " +
        "replacement line without its trailing newline, or holding the attempted " +
        "content twice, violates.",
    },
    {
      oracleId: "recovery-02-refused-half-whole",
      kind: "workspace-bytes",
      evidence:
        `\`${SECOND}\` equals \`${BEFORE_SECOND}\` byte for byte, and no new path ` +
        "appeared. This is the half a partial write would show: any prefix of the " +
        "intended content, and any overwrite that replaced the untouched file with the " +
        "text the refused edit did not land, both violate.",
    },
    {
      oracleId: "recovery-02-refusal-dispatched",
      kind: "effect-record",
      evidence:
        "`edit_file` is retained as a dispatch in the trace, so the refusal is a fact " +
        "about a call the product ran rather than a story the assistant told about " +
        "bytes that never moved.",
    },
  ],
};
