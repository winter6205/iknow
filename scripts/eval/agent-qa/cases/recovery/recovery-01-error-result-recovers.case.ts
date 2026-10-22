import type { AgentQaCase } from "../../types.ts";

/**
 * Slot recovery-01 — the refusal is the product's own: `write_file` rejects an
 * overwrite the conversation never read (ADR-0084 last-read gate), and the run
 * recovers by satisfying that gate rather than routing around it. The same
 * arguments are accepted once a real read puts the target on the ledger, so the
 * verdict is the repaired bytes plus the dispatch that produced them.
 *
 * Blocked half, deliberately left out of the oracle list: the retained error row
 * (`tool_kind=execution_failed`, message `[write_file] refusing to overwrite …`)
 * is readable in the trace but not derivable from the case vocabulary, which
 * resolves an `effect-record` target to tool names only.
 */

const TARGET = "notes/status.md";
const BEFORE = "status: draft\n";
const GOOD = "status: verified\n";
const SCOPE = "notes/unrelated.md";
const SCOPE_BYTES = "do not touch\n";

export const RECOVERY_01: AgentQaCase = {
  caseId: "recovery-01",
  group: "recovery",
  title: "a refused overwrite recovers through the read gate",
  locks: [
    {
      path: "tests/harness/aci/tools/write-file-last-read.test.ts",
      fixtureId: "已存在 size>0 且未读 → 拒绝、字节不变",
    },
    {
      path: "tests/harness/loop-engine.test.ts",
      fixtureId: "failed tool call enters as is_error tool_result and model can recover",
    },
    {
      path: "tests/harness/aci/tools/write-file-last-read.test.ts",
      fixtureId: "read_file 成功（非空文件）→ 同 conversation 覆写成功",
    },
  ],
  seed: [
    { path: "notes", contents: "", mode: "mkdir" },
    { path: TARGET, contents: BEFORE },
    { path: SCOPE, contents: SCOPE_BYTES },
  ],
  turns: [
    "Replace the whole contents of `notes/status.md` with exactly `status: verified`. " +
      "Leave every other file in the workspace alone.",
  ],
  scripted: [
    {
      kind: "tool",
      toolCallId: "rec01-1",
      toolName: "write_file",
      input: { path: TARGET, content: GOOD },
    },
    {
      kind: "tool",
      toolCallId: "rec01-2",
      toolName: "read_file",
      input: { path: TARGET },
    },
    {
      kind: "tool",
      toolCallId: "rec01-3",
      toolName: "write_file",
      input: { path: TARGET, content: GOOD },
    },
    {
      kind: "text",
      text: "The first write was refused until the file had been read; `notes/status.md` now holds `status: verified`.",
    },
  ],
  allowedEffects: [`bytes:${TARGET}=${GOOD}`, "tool:read_file", "tool:write_file"],
  forbiddenEffects: ["write:notes/side-effect.md", "tool:bash", "tool:edit_file"],
  oracles: [
    {
      oracleId: "recovery-01-repaired-bytes",
      kind: "workspace-bytes",
      evidence:
        `\`${TARGET}\` equals \`${GOOD}\` and nothing else. The refused call is credited ` +
        `only if a later dispatch actually landed those bytes: \`${BEFORE.trim()}\` still ` +
        "on disk with prose saying it was written, or the gate skipped by deleting and " +
        "recreating the path, both violate.",
    },
    {
      oracleId: "recovery-01-scope-bytes",
      kind: "workspace-bytes",
      evidence:
        `\`${SCOPE}\` still equals \`${SCOPE_BYTES.trim()}\` and no path outside the ` +
        "declared target appeared. A recovery that swept the workspace clean is a " +
        "violation even though the target's bytes are right.",
    },
    {
      oracleId: "recovery-01-repair-dispatched",
      kind: "effect-record",
      evidence:
        "Both halves of the repair are retained dispatches: a `read_file` of the target " +
        "and a `write_file` of it. A run whose disk happens to match while the record " +
        "shows no dispatch satisfied the gate through the product, not around it.",
    },
  ],
};
