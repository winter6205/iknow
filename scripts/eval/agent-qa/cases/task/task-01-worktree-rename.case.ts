import type { AgentQaCase } from "../../types.ts";

/**
 * Slot task-01 — a bounded symbol rename inside the conversation's own task tree must
 * land on disk at the file the dispatch named, and must move nothing else. The lock is
 * `tests/harness/aci/symbol-mutate.test.ts`#`accepts the legacy changes form`, which
 * pins the single-file apply-to-disk path the recorded call takes.
 *
 * The worktree-isolation half of this slot is named here as blocked, not faked.
 * `create-worktree` is registered only when the host task-worktree seam is threaded
 * (`src/harness/build-engine.ts:530`), and the offline assembly does not thread it; the
 * measured dispatch of that tool in this run root is a `tool_not_found` row with status
 * `error`. An effect that names a tree the offline runner cannot build resolves to
 * `unreadable` and can never be satisfied, so the slot is re-scoped onto the paths this
 * case seeds inside its own attempt workspace. What stays under measurement is the
 * rename's landed bytes plus the scope constraint, which is what the harness can decide.
 * The file name stays `task-01-worktree-rename.case.ts` because it is the slot's address
 * in the registry import graph, not a claim about what the slot now measures.
 *
 * `package-lock.json` is seeded because it is one of the product's TS project-root
 * markers (`src/harness/lsp/server.ts:243-247`): without a root marker the rename never
 * reaches the server at all and returns the no-root sentinel.
 */

const ROOT_MARKER = "package-lock.json";
const TARGET_FILE = "src/unique.ts";
const SIBLING_FILE = "src/helper.ts";

const ORIGINAL_SOURCE =
  "export function evalUniqueSymbol(): number {\n  return 1;\n}\n";
const RENAMED_SOURCE = ORIGINAL_SOURCE.replace(
  "evalUniqueSymbol",
  "evalUniqueSymbolRenamed"
);
const SIBLING_SOURCE =
  'export function helperLabel(): string {\n  return "helper";\n}\n';

export const TASK_01: AgentQaCase = {
  caseId: "task-01",
  group: "task",
  title: "bounded symbol rename lands in the task tree and moves nothing else",
  locks: [
    {
      path: "tests/harness/aci/symbol-mutate.test.ts",
      fixtureId: "accepts the legacy `changes` form (uri → TextEdit[])",
    },
  ],
  seed: [
    { path: ROOT_MARKER, contents: "{}\n" },
    { path: "src", contents: "", mode: "mkdir" },
    { path: TARGET_FILE, contents: ORIGINAL_SOURCE },
    { path: SIBLING_FILE, contents: SIBLING_SOURCE },
  ],
  turns: [
    "Rename the function `evalUniqueSymbol` in `src/unique.ts` to " +
      "`evalUniqueSymbolRenamed`. Touch no other file, and do not create a new one.",
  ],
  scripted: [
    {
      kind: "tool",
      toolCallId: "task01-1",
      toolName: "rename_symbol",
      input: {
        file: TARGET_FILE,
        symbol_path: "evalUniqueSymbol",
        new_name: "evalUniqueSymbolRenamed",
      },
    },
    {
      kind: "text",
      text: "Renamed in place: `src/unique.ts` now declares `evalUniqueSymbolRenamed`.",
    },
  ],
  allowedEffects: [
    `bytes:${TARGET_FILE}=${RENAMED_SOURCE}`,
    "tool:rename_symbol",
  ],
  forbiddenEffects: ["tool:bash"],
  oracles: [
    {
      oracleId: "task-01-target-bytes",
      kind: "workspace-bytes",
      evidence:
        `${TARGET_FILE} declares \`evalUniqueSymbolRenamed\` and no longer declares ` +
        "`evalUniqueSymbol`, byte for byte. The assistant's claim that it renamed the " +
        "function is not evidence; these bytes are.",
    },
    {
      oracleId: "task-01-scope-bytes",
      kind: "workspace-bytes",
      evidence:
        `Every other seeded path — ${ROOT_MARKER}, ${SIBLING_FILE} — is byte-identical ` +
        "to its seed. A rename that widened its scope past the file the user named " +
        "violates here even when the target file itself came out right.",
    },
    {
      oracleId: "task-01-rename-dispatch",
      kind: "effect-record",
      evidence:
        "The record holds a `rename_symbol` dispatch and no shell dispatch. The same " +
        "bytes produced by a hand edit or a `bash` rewrite are not this contract: the " +
        "slot measures the symbol tool doing the rename.",
    },
  ],
};
