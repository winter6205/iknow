/**
 * T5 / ADR-0132 + ADR-0133 — bounded cleanup exceptions for the destructive-rm
 * hard wall.
 *
 * Two exceptions, and both are exceptions to ONE arm of one wall:
 *
 *   - Identity scratch (ADR-0132): a non-recursive `rm -f` of finite, explicit
 *     files inside the CALLING IDENTITY's own session scratch. It leaves the
 *     destructive-command wall and continues through ordinary permission
 *     handling; it is not an allow.
 *   - Workspace cleanup (ADR-0133): a non-recursive `rm -f` of an ordinary
 *     explicit file inside the active `taskRoot`, including a file the user
 *     created. Same departure from the wall, same ordinary handling — `default`
 *     still asks, `full_auto` may allow. No file-creator ledger.
 *
 * What the exceptions may NOT do, and what each case below pins:
 *   - the scratch root ITSELF, a directory target, or any recursive form
 *   - another identity's scratch (a different path, same spelling rules)
 *   - a mixed command where one target is out of scope (all-target)
 *   - a target that leaves containment through `..` or a symlinked ancestor
 *   - a glob, an unresolved variable, or any unexpanded `$` in an operand
 *   - a protected target (`rm -f .env`, `rm -f id_rsa`) — the sensitive wall
 *     still owns those, and it runs independently of this arm
 *   - anything at all when the host supplied no root snapshot
 *
 * Every case runs against a real filesystem under one `mkdtemp` root, because
 * containment here is filesystem-aware: a synthetic path string cannot prove
 * what a symlinked ancestor resolves to.
 */

import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

import {
  classifyBoundedCleanupException,
  findDangerousPattern,
  type BoundedCleanupException,
} from "../../../src/harness/permission/hard-walls.js";
import type { CleanupRootSnapshot } from "../../../src/harness/permission/cleanup-roots.js";
import {
  checkPermission,
  createPermissionPolicy,
} from "../../../src/harness/permission/policy.js";
import { asModeContext, type PermissionMode } from "../../../src/harness/permission/modes.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";

/* ------------------------------------------------------------------ */
/* filesystem fixture                                                  */
/* ------------------------------------------------------------------ */

/**
 * The fixture is built at module scope, not in a hook: the case TABLES below
 * are read while `describe` bodies run (to build each `it` title), which is
 * before any `beforeAll`. Every path is therefore already final here.
 */
function touch(path: string, body = "x"): string {
  writeFileSync(path, body);
  return path;
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "cleanup-exception-")));
const taskRoot = join(root, "task");
/** This identity's own session scratch. */
const scratchRoot = join(root, "session-a", "fence-tmp");
/** A second identity's session scratch: same shape, different path. */
const otherScratchRoot = join(root, "session-b", "fence-tmp");
/** Lives OUTSIDE both roots, reachable only through the `escape` symlinks. */
const outside = join(root, "outside");
mkdirSync(taskRoot, { recursive: true });
mkdirSync(scratchRoot, { recursive: true });
mkdirSync(otherScratchRoot, { recursive: true });
mkdirSync(outside, { recursive: true });
mkdirSync(join(taskRoot, "sub"), { recursive: true });
mkdirSync(join(scratchRoot, "subdir"), { recursive: true });

touch(join(taskRoot, "tmp_pycheck.cjs"));
/** A real file the user created in the workspace before the call. */
touch(join(taskRoot, "user-note.md"), "user authored");
touch(join(taskRoot, "sub", "nested.cjs"));
touch(join(taskRoot, ".env"), "SECRET=1");
touch(join(taskRoot, "id_rsa"), "-----BEGIN KEY-----");
touch(join(scratchRoot, "a.cjs"));
touch(join(scratchRoot, "b.cjs"));
touch(join(otherScratchRoot, "c.cjs"));
touch(join(outside, "secret.txt"));
// A symlink INSIDE taskRoot whose real location is outside every root.
symlinkSync(outside, join(taskRoot, "escape"));
// A symlink INSIDE the scratch whose real location is outside too.
symlinkSync(outside, join(scratchRoot, "escape"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const NO_ROOTS: CleanupRootSnapshot = {};

/** The per-call host snapshot: both roots, symlink-resolved. */
function roots(): CleanupRootSnapshot {
  return { scratchRoot, taskRoot };
}

/* ------------------------------------------------------------------ */
/* policy plumbing                                                     */
/* ------------------------------------------------------------------ */

function makeTool(name = "bash"): AciToolDef {
  return Object.freeze({
    name,
    description: "cleanup-exception probe",
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: Object.freeze({
      category: "execute" as const,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
    }),
  });
}

const bashTool = makeTool();

function policyWith(snapshot: CleanupRootSnapshot) {
  return createPermissionPolicy({ hostRoots: () => snapshot });
}

function outcomeOf(
  command: string,
  snapshot: CleanupRootSnapshot,
  mode?: PermissionMode
) {
  const policy = policyWith(snapshot);
  return checkPermission({
    def: bashTool,
    input: { command },
    sources: policy.sources,
    hardWalls: policy.hardWalls,
    defaultByCategory: policy.defaultByCategory,
    mode: asModeContext(mode ?? "default"),
    hostRoots: policy.hostRoots,
  });
}

/** The exception the shared classifier reports, or `null` for "no exception". */
function exceptionFor(command: string, snapshot: CleanupRootSnapshot = roots()) {
  return classifyBoundedCleanupException(command, snapshot);
}

/**
 * The wall's own verdict for this call, measured WITH the host snapshot —
 * which is the question "does the destructive-rm arm still answer for it".
 * Called without roots it is, by contract, today's unchanged verdict.
 */
function rmHit(command: string, snapshot: CleanupRootSnapshot = roots()) {
  return findDangerousPattern(command, snapshot);
}

/**
 * The verdict this host's roots MUST NOT change.
 *
 * A negative case is not "never allow" — `rm -f` with no target, for instance,
 * was never a `destructive-rm` finding and has always been answerable by the
 * mode arm. The contract the exceptions carry is the narrower and real one:
 * with no cleanup exception the outcome is the outcome a host supplying no
 * roots gets, in every mode. Asserting that pins "nothing was widened" without
 * inventing a security claim the wall never made.
 */
function baselineOf(command: string, mode: PermissionMode) {
  return outcomeOf(command, NO_ROOTS, mode);
}

function expectUnchangedByRoots(
  command: string,
  mode: PermissionMode
): void {
  const withRoots = outcomeOf(command, roots(), mode);
  const baseline = baselineOf(command, mode);
  expect(
    withRoots.decision,
    `${command} @ ${mode}: decision must match the no-roots baseline`
  ).toBe(baseline.decision);
  expect(
    withRoots.reason,
    `${command} @ ${mode}: reason must match the no-roots baseline`
  ).toBe(baseline.reason);
}

/* ------------------------------------------------------------------ */
/* 1. identity scratch — the exception applies (ADR-0132)              */
/* ------------------------------------------------------------------ */

describe("ADR-0132 — own scratch: non-recursive explicit rm -f leaves the wall", () => {
  const applies: ReadonlyArray<readonly [string, string, "identity-scratch"]> = [
    ["$TMPDIR form", `rm -f $TMPDIR/a.cjs`, "identity-scratch"],
    ["${TMPDIR} form", "rm -f ${TMPDIR}/a.cjs", "identity-scratch"],
    [
      "trusted absolute path (the same root, spelled out)",
      `rm -f ${scratchRoot}/a.cjs`,
      "identity-scratch",
    ],
    [
      "double-quoted $TMPDIR form",
      `rm -f "$TMPDIR/a.cjs"`,
      "identity-scratch",
    ],
    [
      "several explicit targets, all contained",
      `rm -f $TMPDIR/a.cjs $TMPDIR/b.cjs`,
      "identity-scratch",
    ],
    [
      "resolved relative form under the scratch",
      `rm -f $TMPDIR/sub/../a.cjs`,
      "identity-scratch",
    ],
    [
      "an option that is not recursive changes nothing",
      `rm -f -v $TMPDIR/a.cjs`,
      "identity-scratch",
    ],
    [
      "`--` end-of-options is not a target",
      `rm -f -- $TMPDIR/a.cjs`,
      "identity-scratch",
    ],
  ];

  for (const [why, command, scope] of applies) {
    it(`admits ${JSON.stringify(command)} — ${why}`, () => {
      const exception: BoundedCleanupException | null = exceptionFor(command);
      expect(exception, `${command}: exception`).not.toBeNull();
      expect(exception?.scope, `${command}: scope`).toBe(scope);
      // The wall itself no longer answers for this command.
      const hit = rmHit(command);
      expect(hit, `${command}: no destructive-rm finding`).toBeNull();
    });
  }

  it("sends an admitted scratch cleanup to ORDINARY permission handling, in both modes", () => {
    const command = `rm -f $TMPDIR/a.cjs`;
    // default asks — not a deny, and not a silent allow.
    const asked = outcomeOf(command, roots(), "default");
    expect(asked.decision).toBe("ask");
    expect(asked.reason).not.toContain("[hard_wall]");
    // full_auto may allow ordinary workspace/scratch mutation.
    expect(outcomeOf(command, roots(), "full_auto").decision).toBe("allow");
  });
});

/* ------------------------------------------------------------------ */
/* 2. identity scratch — every negative case (ADR-0132)                */
/* ------------------------------------------------------------------ */

describe("ADR-0132 — scratch: no exception for any unestablished or out-of-scope target", () => {
  const denied: ReadonlyArray<readonly [string, string]> = [
    ["recursive", `rm -rf $TMPDIR/a.cjs`],
    ["recursive, flags reordered", `rm -r -f $TMPDIR/a.cjs`],
    ["long-form recursive", `rm -f --recursive $TMPDIR/a.cjs`],
    ["the scratch root itself", `rm -f $TMPDIR`],
    ["a directory target", `rm -f $TMPDIR/subdir`],
    ["another identity's scratch", `rm -f ${otherScratchRoot}/c.cjs`],
    [
      "mixed: one own-scratch target, one foreign target",
      `rm -f $TMPDIR/a.cjs ${otherScratchRoot}/c.cjs`,
    ],
    ["mixed: one own-scratch target, one workspace target", `rm -f $TMPDIR/a.cjs ${taskRoot}/tmp_pycheck.cjs`],
    ["escaping through `..`", `rm -f $TMPDIR/../outside/secret.txt`],
    ["escaping through a symlinked ancestor", `rm -f $TMPDIR/escape/secret.txt`],
    ["a glob", `rm -f $TMPDIR/*.cjs`],
    ["a brace/character class", `rm -f $TMPDIR/[ab].cjs`],
    ["an unresolved variable", `rm -f $NOT_TMPDIR/a.cjs`],
    ["a second variable appended to the trusted one", `rm -f $TMPDIR${"$SUFFIX"}`],
    ["a command substitution", `rm -f $TMPDIR/$(echo a).cjs`],
    ["a tilde", `rm -f ~/a.cjs`],
    ["a backslash escape inside the operand", `rm -f $TMPDIR/a\\ b.cjs`],
    ["no target at all", `rm -f`],
    ["a nested shell that runs rm", `bash -c 'rm -f $TMPDIR/a.cjs'`],
    ["rm behind sudo is still classified, but sudo is not the identity's own rm",
      `sudo rm -f $TMPDIR/a.cjs`],
  ];

  for (const [why, command] of denied) {
    it(`refuses ${JSON.stringify(command)} — ${why}`, () => {
      expect(exceptionFor(command), `${command}: no exception`).toBeNull();
      // Policy admission is the observable that matters: the roots changed
      // nothing, in either mode. The verdict may be any id — a `vetoed` parse
      // denies as `unparseable`, a flag reorder denies as `destructive-rm`, and
      // a shape the wall never matched is answered by the mode arm. What none
      // of them may be is a decision the no-roots baseline would not have
      // given.
      for (const mode of ["default", "full_auto"] as const) {
        expectUnchangedByRoots(command, mode);
      }
    });
  }
});

/* ------------------------------------------------------------------ */
/* 3. workspace cleanup (ADR-0133)                                     */
/* ------------------------------------------------------------------ */

describe("ADR-0133 — taskRoot: ordinary explicit file deletion goes to normal permissions", () => {
  const applies: ReadonlyArray<readonly [string, string]> = [
    ["the reported shape from issue #1170", "rm -f tmp_pycheck.cjs"],
    ["explicit `./` form", "rm -f ./sub/nested.cjs"],
    ["an existing USER-created file (no creator ledger)", "rm -f user-note.md"],
    [
      "the absolute spelling of the same taskRoot",
      `rm -f ${taskRoot}/tmp_pycheck.cjs`,
    ],
    ["several contained targets", "rm -f tmp_pycheck.cjs sub/nested.cjs"],
    ["a target that walks back inside", "rm -f sub/../tmp_pycheck.cjs"],
  ];

  for (const [why, command] of applies) {
    it(`admits ${JSON.stringify(command)} — ${why}`, () => {
      const exception = exceptionFor(command);
      expect(exception, `${command}: exception`).not.toBeNull();
      expect(exception?.scope).toBe("task-root");
      expect(rmHit(command), `${command}: no destructive-rm finding`).toBeNull();
    });
  }

  it("default ASKS (not deny, not silent allow); full_auto may allow", () => {
    for (const command of ["rm -f tmp_pycheck.cjs", "rm -f user-note.md"]) {
      const asked = outcomeOf(command, roots(), "default");
      expect(asked.decision, `${command}: default asks`).toBe("ask");
      expect(asked.reason).not.toContain("[hard_wall]");
      expect(
        outcomeOf(command, roots(), "full_auto").decision,
        `${command}: full_auto may allow`
      ).toBe("allow");
    }
  });

  it("plan mode still blocks the mutation, through its own arm", () => {
    const out = outcomeOf("rm -f tmp_pycheck.cjs", roots(), "plan");
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("plan blocks mutating tools");
    expect(out.reason).not.toContain("[hard_wall]");
  });
});

/* ------------------------------------------------------------------ */
/* 4. workspace negatives + protected targets                         */
/* ------------------------------------------------------------------ */

describe("ADR-0133 — taskRoot: no exception outside it, and none for protected targets", () => {
  const denied: ReadonlyArray<readonly [string, string]> = [
    ["recursive", "rm -rf tmp_pycheck.cjs"],
    ["the taskRoot itself", `rm -f ${taskRoot}`],
    ["a directory target", "rm -f sub"],
    ["a mixed inside/outside command", `rm -f tmp_pycheck.cjs ${scratchRoot}/a.cjs`],
    ["outside the root entirely", `rm -f ${root}/outside/secret.txt`],
    ["escaping through `..`", "rm -f ../outside/secret.txt"],
    ["escaping through a symlinked ancestor", "rm -f escape/secret.txt"],
    ["a glob", "rm -f *.cjs"],
    ["an unresolved variable", "rm -f $NAME.cjs"],
    ["a command substitution", "rm -f $(echo tmp_pycheck).cjs"],
    ["no target at all", "rm -f"],
  ];

  for (const [why, command] of denied) {
    it(`refuses ${JSON.stringify(command)} — ${why}`, () => {
      expect(exceptionFor(command), `${command}: no exception`).toBeNull();
      for (const mode of ["default", "full_auto"] as const) {
        expectUnchangedByRoots(command, mode);
      }
    });
  }

  it("a protected target keeps its hard wall even inside taskRoot", () => {
    // ADR-0132/0133 grant no authority over protected targets. The claim
    // asserted here is the wall TIER, not which arm reports: a protected
    // operand is a `destructive-rm` operand too, and that arm answers first,
    // so naming an arm here would pin a precedence this change never claimed.
    // What matters is that `full_auto` cannot reach it.
    for (const command of ["rm -f .env", "rm -f id_rsa", "rm -f ./.env"]) {
      const out = outcomeOf(command, roots(), "full_auto");
      expect(out.decision, `${command}: still denied`).toBe("deny");
      expect(out.reason, `${command}: denied by a hard wall`).toContain(
        "[hard_wall]"
      );
    }
  });

  it("a protected target gets no cleanup exception even though it is a contained file", () => {
    // The strongest form of the protected-target claim: the target is a real
    // ordinary file INSIDE taskRoot, so the ADR-0133 operand test alone would
    // admit it. The classifier must still refuse, because the sensitive arm
    // owns protected targets and ADR-0132/0133 say nothing about them.
    for (const command of ["rm -f .env", "rm -f id_rsa", "rm -f ./.env"]) {
      expect(exceptionFor(command), `${command}: no exception`).toBeNull();
    }
  });

  it("a protected target inside the scratch gets no cleanup exception either", () => {
    touch(join(scratchRoot, ".env"), "SECRET=1");
    const command = `rm -f $TMPDIR/.env`;
    expect(exceptionFor(command)).toBeNull();
    expect(outcomeOf(command, roots(), "full_auto").reason).toContain(
      "[hard_wall]"
    );
  });
});

/* ------------------------------------------------------------------ */
/* 5. all-target failure + absent host context                         */
/* ------------------------------------------------------------------ */

describe("all-target containment and the absent-snapshot default", () => {
  it("one failing target fails the whole command", () => {
    expect(exceptionFor(`rm -f $TMPDIR/a.cjs $TMPDIR/../escape/secret.txt`)).toBeNull();
    expect(exceptionFor(`rm -f $TMPDIR/a.cjs $TMPDIR/escape/secret.txt`)).toBeNull();
    expect(
      exceptionFor(`rm -f $TMPDIR/a.cjs $TMPDIR/$NOT_SET`)
    ).toBeNull();
  });

  it("no host root context means no exception at all (legacy verdict preserved)", () => {
    for (const command of [
      `rm -f $TMPDIR/a.cjs`,
      "rm -f tmp_pycheck.cjs",
      `rm -f ${scratchRoot}/a.cjs`,
    ]) {
      expect(exceptionFor(command, NO_ROOTS), command).toBeNull();
      const out = outcomeOf(command, NO_ROOTS, "full_auto");
      expect(out.decision, `${command}: still denied without roots`).toBe("deny");
      expect(out.reason).toContain("[hard_wall]");
    }
  });

  it("a scratch root without a taskRoot grants scratch only", () => {
    const scratchOnly: CleanupRootSnapshot = { scratchRoot: realpathSync(scratchRoot) };
    expect(exceptionFor(`rm -f $TMPDIR/a.cjs`, scratchOnly)?.scope).toBe(
      "identity-scratch"
    );
    expect(exceptionFor("rm -f tmp_pycheck.cjs", scratchOnly)).toBeNull();
  });

  it("a taskRoot without a scratch root grants workspace only", () => {
    const taskOnly: CleanupRootSnapshot = { taskRoot: realpathSync(taskRoot) };
    expect(exceptionFor("rm -f tmp_pycheck.cjs", taskOnly)?.scope).toBe(
      "task-root"
    );
    expect(exceptionFor(`rm -f $TMPDIR/a.cjs`, taskOnly)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 6. symlink counterexamples are real filesystem facts                */
/* ------------------------------------------------------------------ */

describe("containment is filesystem-aware, not a textual prefix", () => {
  it("the escaping symlink really does resolve outside the root", () => {
    // Ground truth for the two cases above: if the symlink did NOT escape,
    // "no exception" would be the wall being wrong rather than the classifier.
    const escaped = join(taskRoot, "escape", "secret.txt");
    assert.ok(
      realpathSync(escaped).startsWith(realpathSync(join(root, "outside"))),
      "fixture precondition: the symlink path really resolves outside taskRoot"
    );
    assert.notEqual(
      realpathSync(escaped).startsWith(`${realpathSync(taskRoot)}${"\0"}`),
      true
    );
    expect(lstatSync(join(taskRoot, "escape")).isSymbolicLink()).toBe(true);
  });

  it("a textually-inside path that resolves outside gets no exception", () => {
    // `<taskRoot>/escape/secret.txt` STARTS WITH the taskRoot string, so a
    // lexical prefix check would have granted the cleanup authority.
    expect(exceptionFor("rm -f escape/secret.txt")).toBeNull();
    expect(exceptionFor(`rm -f $TMPDIR/escape/secret.txt`)).toBeNull();
  });
});
