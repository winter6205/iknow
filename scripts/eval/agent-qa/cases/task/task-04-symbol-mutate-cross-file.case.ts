import type { AgentQaCase } from "../../types.ts";

/**
 * Slot task-04 — a symbol mutation whose WorkspaceEdit spans two files must land on
 * disk in BOTH files, and must land through the symbol tool rather than a hand write.
 * The lock is the behavior-local symbol-mutate applier set, which pins
 * `applies cross-file text edits to disk and reports files + edit count` and the
 * never-partially-apply contract.
 *
 * Two measured constraints shape the declaration:
 *
 * - The two files must be linked by a real import. The rename is tsserver's
 *   `textDocument/rename` over the project, and a bare occurrence of the same word in a
 *   module that never imports the binding is not a reference to it: measured with
 *   `src/caller.ts` holding `foo();`, the applier moved `src/portal.ts` alone and left
 *   the sibling byte-identical, so the cross-file fact the old declaration named could
 *   never have landed.
 * - `package-lock.json` is seeded because it is one of the product's TS project-root
 *   markers (`src/harness/lsp/server.ts:243-247`). Measured without it, `rename_symbol`
 *   returns the no-root sentinel and no byte moves anywhere.
 *
 * The edit COUNT the old declaration owed is dropped: it lives only in the tool
 * result body, and the retained `tool_call` row carries `result_captured:false`
 * (measured), while the effect-record derivation reads rows and never a body
 * (`scripts/eval/agent-qa/attempt.ts:244-271`). "Two files moved" is therefore stated
 * as the two landed byte facts, which is what the disk can decide.
 */

const ROOT_MARKER = "package-lock.json";
const MAIN_FILE = "src/portal.ts";
const SIBLING_FILE = "src/caller.ts";
const OUTSIDE_FILE = "src/registry.ts";

const MAIN_BEFORE =
  "export const foo = 1;\nexport const readFoo = () => foo;\n";
const SIBLING_BEFORE =
  'import { foo } from "./portal";\nexport const useFoo = () => foo;\n';
const OUTSIDE_BYTES = "export const registrySize = 3;\n";

const MAIN_AFTER = MAIN_BEFORE.replaceAll("foo", "baz");
const SIBLING_AFTER = SIBLING_BEFORE.replaceAll("foo", "baz");

export const TASK_04: AgentQaCase = {
  caseId: "task-04",
  group: "task",
  title: "symbol mutation applies a cross-file WorkspaceEdit to disk",
  locks: [
    {
      path: "tests/harness/aci/symbol-mutate.test.ts",
      fixtureId:
        "applies cross-file text edits to disk and reports files + edit count",
    },
    {
      path: "tests/harness/aci/symbol-mutate.test.ts",
      fixtureId:
        "unsupported WorkspaceEdit fragments are rejected, never partially applied",
    },
  ],
  seed: [
    { path: ROOT_MARKER, contents: "{}\n" },
    { path: "src", contents: "", mode: "mkdir" },
    { path: MAIN_FILE, contents: MAIN_BEFORE },
    { path: SIBLING_FILE, contents: SIBLING_BEFORE },
    { path: OUTSIDE_FILE, contents: OUTSIDE_BYTES },
  ],
  turns: [
    "Rename the exported const `foo` in `src/portal.ts` to `baz` and update every " +
      "reference to it in the workspace. Do not change any other file.",
  ],
  scripted: [
    {
      kind: "tool",
      toolCallId: "task04-1",
      toolName: "rename_symbol",
      input: { file: MAIN_FILE, symbol_path: "foo", new_name: "baz" },
    },
    {
      kind: "text",
      text: "Renamed `foo` to `baz` across the two modules that reference it.",
    },
  ],
  allowedEffects: [
    `bytes:${MAIN_FILE}=${MAIN_AFTER}`,
    `bytes:${SIBLING_FILE}=${SIBLING_AFTER}`,
    "tool:rename_symbol",
  ],
  forbiddenEffects: ["tool:bash"],
  oracles: [
    {
      oracleId: "task-04-cross-file-bytes",
      kind: "workspace-bytes",
      evidence:
        `${MAIN_FILE} and ${SIBLING_FILE} both equal their renamed bytes. A rename that ` +
        "moved the declaration and left the importing module saying `foo` is exactly the " +
        "half-applied WorkspaceEdit this slot exists to catch, and no reported edit count " +
        "makes it whole.",
    },
    {
      oracleId: "task-04-collateral-bytes",
      kind: "workspace-bytes",
      evidence:
        `Every other seeded path — ${ROOT_MARKER}, ${OUTSIDE_FILE} — is byte-identical ` +
        "to its seed. A rename that also moved an unrelated module is a violation even " +
        "when the two named files came out right.",
    },
    {
      oracleId: "task-04-rename-dispatch",
      kind: "effect-record",
      evidence:
        "The record holds a `rename_symbol` dispatch and no shell dispatch. The right " +
        "bytes reached disk by hand-editing every file is not this contract: the symbol " +
        "tool is the one seam that applies one WorkspaceEdit across the project.",
    },
  ],
};
