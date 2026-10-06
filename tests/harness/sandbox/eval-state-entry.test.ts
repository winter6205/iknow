/**
 * tests/harness/sandbox/eval-state-entry.test.ts
 *
 * ADR-0130 **eval state** — the entry's runtime shape and its non-persistence.
 *
 * Eval state is the headless, named, non-default face of the unsandboxed
 * posture (ADR-0119 Amendment 2026-09-29): the fence posture yolo reaches
 * through the TUI — `fsMode: workspace` → `global`, fence retired wholesale,
 * egress seam retired — plus permission → `full_auto`, which eval now writes
 * through its OWN entry (ADR-0139 §3: the two axes never write each other, and
 * an operator cannot answer per-call questions mid-benchmark). What this file
 * certifies:
 *
 *   1. the fence carrier and fence shape are yolo's, reused rather than
 *      re-implemented, while the permission posture is eval's own write — so
 *      the narrowed structural-parity claim is a fact, not a copy that can
 *      drift;
 *   2. **holders only** — a user-layer settings file that says `workspace` is
 *      still `workspace` on disk and in the loaded object afterwards, byte for
 *      byte (ADR-0084 discipline inherited by ADR-0119 §ruling 1);
 *   3. nothing is persisted (no new file lands in the session pool root);
 *   4. the entry enumeration is the narrow named face (`ask` / `oneshot`), and
 *      the five `--yolo` refusals are untouched (`--yolo` is not the door to
 *      eval state — ADR-0130 §1).
 *
 * Boundary classes covered (specs/yolo-mode.md style, applied to this entry):
 * normal (the combination lands) / invalid (empty initial holders keep their
 * own defaults) / combination (workspace fs tier + eval state → global) /
 * exception (a refusal renders through the typed `${kind}:` face, never a bare
 * Error).
 *
 * The physical half — a bash call really running without bwrap — is certified by
 * `tests/cli/cli-eval-state-bare-run.test.ts` against a real CLI child process,
 * and by the ADR-0119 four-route parity face (`yolo-probe-parity.test.ts`) this
 * entry reuses without modifying.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVAL_STATE_ACCEPTING_COMMANDS,
  EVAL_STATE_FLAG,
  EVAL_STATE_NOTICE,
  EVAL_STATE_RUN_LABEL,
  enterEvalState,
  isEvalStateEntry,
  rejectEvalStateConflict,
  rejectEvalStateEntry,
} from "../../../src/harness/sandbox/eval-state.ts";
import {
  createYoloContext,
  createYoloController,
  YOLO_TUI_ONLY_REJECTED_COMMANDS,
  rejectYoloForCommand,
} from "../../../src/harness/sandbox/yolo.ts";
import { createFsModeContext } from "../../../src/harness/sandbox/fs-mode.ts";
import { createPermissionModeContext } from "../../../src/harness/permission/modes.ts";
import { checkPermission } from "../../../src/harness/permission/policy.ts";
import { hardWalls } from "../../../src/harness/permission/hard-walls.ts";
import { DEFAULT_BY_CATEGORY } from "../../../src/harness/permission/policy.ts";
import type { AciToolDef } from "../../../src/harness/aci/types.ts";
import {
  loadIknowSettings,
  resolveFsIsolationMode,
} from "../../../src/config/settings.ts";

/**
 * The bash tool shape `checkPermission` classifies. It is a declaration only —
 * `checkPermission` reads `aci.category` and `name`, never `handler` — so this
 * asserts the permission decision, not an execution that never happens.
 */
const destructiveProbe: AciToolDef = Object.freeze({
  name: "bash",
  description: "eval-state hard-wall probe",
  inputSchema: { type: "object", additionalProperties: false },
  handler: async () => "ok",
  aci: {
    category: "execute",
    isConcurrencySafe: false,
    interruptBehavior: "cancel",
    timeoutTier: "default",
  } as const,
});

/**
 * A scratch session pool (`$HOME/.iknow`) carrying a **user-layer** isolation
 * tier, so "holders only, settings untouched" is asserted against a real file
 * rather than against an in-memory object the runtime could not have written.
 */
function scratchHome(settings: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "iknow-eval-state-home-"));
  mkdirSync(join(home, ".iknow"), { recursive: true });
  writeFileSync(
    join(home, ".iknow", "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8"
  );
  return home;
}

describe("eval state — the entry state combination is yolo's, reused (ADR-0130 §1)", () => {
  it("workspace fs tier + eval state lands on full_auto / global / fence retired", () => {
    const permission = createPermissionModeContext("default");
    const fsMode = createFsModeContext("workspace");
    const holders = enterEvalState({ permission, fsMode });

    assert.equal(holders.permission.get(), "full_auto");
    assert.equal(holders.fsMode.get(), "global");
    // The carrier of "the fence retires wholesale" is the yolo holder: the fence
    // factory's single branch (ADR-0119 §ruling 2) is the one SSOT the four
    // routes read, so eval state reaching it is what makes the shape identical.
    assert.equal(holders.yolo.get(), true);
    assert.equal(
      holders.permission,
      permission,
      "holders are flipped in place"
    );
    assert.equal(holders.fsMode, fsMode, "holders are flipped in place");
  });

  it("full_auto is eval's OWN write, not the fence carrier's (ADR-0139 §3)", () => {
    // The narrowed parity claim: eval and a plain yolo session share the FENCE
    // carrier and the fence shape, and each entry sets its own permission
    // posture. So the same holder, driven by yolo's enter action alone, must
    // stay at its starting mode — otherwise the shared action is still writing
    // the permission axis and the "eval writes its own" claim is a copy, not a
    // fact. (ADR-0130 §4 lists `full_auto` alone as a rejected option: it fixes
    // approvals, not the fence.)
    const permission = createPermissionModeContext("default");
    const yolo = createYoloContext(false);
    const fenceOnly = createYoloController({
      yolo,
      permission,
      fsMode: createFsModeContext("workspace"),
    }).enterAtLaunch();
    assert.equal(fenceOnly.ok, true);
    assert.equal(
      yolo.get(),
      true,
      "the shared action still applies the fence axis"
    );
    assert.equal(
      permission.get(),
      "default",
      "the shared enter action writes nothing to the permission axis"
    );

    // Eval's own entry raises it, from the same starting holder.
    const holders = enterEvalState({
      permission,
      fsMode: createFsModeContext("workspace"),
    });
    assert.equal(holders.permission.get(), "full_auto");
    assert.equal(holders.fsMode.get(), "global");
    assert.equal(holders.yolo.get(), true);
  });

  it("a global fs tier stays global (the flip is conditional, not a forced write)", () => {
    const holders = enterEvalState({
      permission: createPermissionModeContext("plan"),
      fsMode: createFsModeContext("global"),
    });
    assert.equal(holders.fsMode.get(), "global");
    assert.equal(holders.permission.get(), "full_auto");
  });

  it("re-entry lands on the same posture (idempotent; per-invocation holders)", () => {
    const permission = createPermissionModeContext("default");
    const fsMode = createFsModeContext("workspace");
    const first = enterEvalState({ permission, fsMode });
    const second = enterEvalState({ permission, fsMode });
    assert.equal(first.yolo.get(), true);
    assert.equal(second.yolo.get(), true);
    assert.equal(second.fsMode.get(), "global");
    assert.equal(second.permission.get(), "full_auto");
  });

  it("the published state label and notice name eval state (ADR-0130 §5)", () => {
    assert.equal(EVAL_STATE_RUN_LABEL, "eval_state");
    assert.match(EVAL_STATE_NOTICE, /^eval_state:/);
    // The notice must disclaim the two things that do NOT retire, or a reader
    // would take the posture for "no guardrails" (ADR-0130 §2).
    assert.match(EVAL_STATE_NOTICE, /hard-wall/);
    assert.match(EVAL_STATE_NOTICE, /taskRoot|which-tree/);
    assert.match(EVAL_STATE_NOTICE, /not persisted|Nothing is persisted/);
  });

  // ADR-0130 §2's central survival claim, asserted as BEHAVIOUR rather than as
  // the notice's prose (the string above). A later edit that drops
  // `policy.hardWalls` from the ask executor path, or lets `full_auto`
  // short-circuit ahead of the wall loop, would leave every other assertion in
  // this file green while removing the one thing the benchmark measures.
  //
  // The mode passed here is the SAME PermissionModeContext instance the entry
  // receives (`enterEvalState({ permission })`), so this closes the gap between
  // "the holder reads full_auto" and "full_auto still cannot answer a walled
  // command": the wall loop must run BEFORE mode resolution.
  it("a destructive command is denied by the hard-wall even under the entry's full_auto holder", () => {
    const permission = createPermissionModeContext("default");
    const holders = enterEvalState({
      permission,
      fsMode: createFsModeContext("workspace"),
    });
    assert.equal(
      holders.permission.get(),
      "full_auto",
      "the entry really did raise the mode — otherwise this arm proves nothing"
    );

    const decision = checkPermission({
      def: destructiveProbe,
      input: { command: "rm -rf /tmp/eval-state-victim" },
      // The built-in code layer's rules are irrelevant here (they allow
      // memory_save, never bash), and an empty layer keeps the assertion on the
      // wall loop rather than on an unrelated rule that could match first.
      sources: { code: { kind: "code", rules: [] } },
      hardWalls: hardWalls(),
      defaultByCategory: DEFAULT_BY_CATEGORY,
      mode: holders.permission,
    });

    assert.equal(
      decision.decision,
      "deny",
      "a walled command is not merely un-approved"
    );
    assert.ok(
      decision.reason.startsWith("[hard_wall]"),
      `deny must carry the hard-wall prefix, got: ${decision.reason}`
    );
  });
});

describe("eval state — holders only, never user-layer settings (ADR-0084 discipline)", () => {
  it("settings.json keeps isolation.fsMode=workspace on disk and in the loaded object", () => {
    const home = scratchHome({ isolation: { fsMode: "workspace" } });
    try {
      const settingsPath = join(home, ".iknow", "settings.json");
      const bytesBefore = readFileSync(settingsPath, "utf8");
      const poolBefore = readdirSync(join(home, ".iknow")).sort();

      const settings = loadIknowSettings({ home, cwd: home });
      assert.equal(
        resolveFsIsolationMode(settings),
        "workspace",
        "the user tier really read as workspace before entry"
      );
      const holders = enterEvalState({
        permission: createPermissionModeContext("default"),
        fsMode: createFsModeContext(resolveFsIsolationMode(settings)),
      });

      assert.equal(holders.fsMode.get(), "global", "the holder flipped");
      assert.equal(
        readFileSync(settingsPath, "utf8"),
        bytesBefore,
        "the user-layer settings file must be byte-identical after entry"
      );
      assert.equal(
        resolveFsIsolationMode(loadIknowSettings({ home, cwd: home })),
        "workspace",
        "a reload still reads the user tier — nothing was rewritten"
      );
      assert.deepEqual(
        readdirSync(join(home, ".iknow")).sort(),
        poolBefore,
        "nothing is persisted: no new file under the session pool (ADR-0119 §ruling 8)"
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the loaded settings object is untouched by the flip (deep-frozen, no mutation)", () => {
    const home = scratchHome({ isolation: { fsMode: "workspace" } });
    try {
      const settings = loadIknowSettings({ home, cwd: home });
      enterEvalState({
        permission: createPermissionModeContext("default"),
        fsMode: createFsModeContext(resolveFsIsolationMode(settings)),
      });
      assert.equal(settings.isolation?.fsMode, "workspace");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("eval state — the entry enumeration is a named face, not a widened --yolo", () => {
  it.each([...EVAL_STATE_ACCEPTING_COMMANDS])(
    "%s is an eval-state entry",
    (command) => {
      assert.equal(isEvalStateEntry(command), true);
    }
  );

  it.each(["chat", "serve", "trace", "tui", "help", "__subagent_worker__", ""])(
    "%s is not an eval-state entry",
    (command) => {
      assert.equal(isEvalStateEntry(command), false);
    }
  );

  it("the flag literal is the named opt-in (--eval-state)", () => {
    assert.equal(EVAL_STATE_FLAG, "--eval-state");
  });

  it("--yolo keeps its five typed refusals (ADR-0130 §1 declines to widen it)", () => {
    assert.deepEqual(
      [...YOLO_TUI_ONLY_REJECTED_COMMANDS],
      ["chat", "serve", "ask", "oneshot", "trace"]
    );
    // The refusal bytes themselves are unchanged too: eval state did not soften
    // the copy into "use --eval-state instead".
    const refusal = rejectYoloForCommand("ask");
    assert.match(refusal.message, /^yolo_non_tui_entry: /);
    assert.equal(refusal.message.includes("eval"), false);
  });
});

describe("eval state — typed refusals render through the discriminated union", () => {
  it("unsupported entry: kind prefix + command name + the legal entry", () => {
    const refusal = rejectEvalStateEntry("chat");
    assert.equal(refusal.kind, "eval_state_unsupported_entry");
    assert.equal(refusal.command, "chat");
    assert.equal(refusal instanceof Error, false);
    assert.match(refusal.message, /^eval_state_unsupported_entry: /);
    assert.ok(refusal.message.includes("'chat'"));
    assert.ok(
      refusal.message.includes(`${EVAL_STATE_FLAG}`),
      `message must name the rejected flag, got: ${refusal.message}`
    );
    assert.ok(
      refusal.message.includes("iknow ask"),
      "message must point at the single legal entry"
    );
  });

  it("incoherent combination: kind prefix + the conflicting flag", () => {
    const refusal = rejectEvalStateConflict("ask", "--resume");
    assert.equal(refusal.kind, "eval_state_flag_conflict");
    assert.equal(refusal.command, "ask");
    assert.equal(refusal.flag, "--resume");
    assert.match(refusal.message, /^eval_state_flag_conflict: /);
    assert.ok(refusal.message.includes("--resume"));
    assert.ok(refusal.message.includes("--eval-state"));
  });
});
