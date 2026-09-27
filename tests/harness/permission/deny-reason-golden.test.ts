/**
 * SC-GATES-6 — the golden deny-reason table
 * (`specs/hard-wall-ast-migration.md`, "reason-string contract").
 *
 * One representative command per deny id of the destructive family, pinning the
 * three things the criterion says must survive the migration byte-identical
 * while the rules behind them move onto the parse:
 *
 *   - the reported `id`,
 *   - the `pattern=` desc, re-derived verbatim from argv (including the three
 *     whitespace-bearing roster literals: `"rm -r "` and `"rm -f "` keep their
 *     trailing space, `" -delete"` keeps its leading space),
 *   - the whole operator-visible reason, prefix included.
 *
 * Every expected value here was MEASURED by running the current code (a `tsx`
 * probe against these same public exports), never written by hand: this file is
 * a regression pin for the stages ahead, not a specification of where they land.
 *
 * Two seams are asserted rather than one, because the criterion forbids
 * restructuring the renderer: `hardWalls()`'s `hard-wall:execute-dangerous`
 * entry is the surface that renders the sentence, and `checkPermission` is where
 * policy applies the `[hard_wall] ` prefix. A row whose literal stopped matching
 * its own hit — the shape of a re-plumbed formatter that kept its own text — is
 * caught by the wrapper-shape assertion in each case.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  findDangerousPattern,
  hardWalls,
  HARD_WALL_DENY_PREFIX,
  type DangerousPatternHit,
  type DangerousPatternId,
} from "../../../src/harness/permission/hard-walls.js";
import {
  checkPermission,
  createPermissionPolicy,
} from "../../../src/harness/aci/permission.ts";
import type {
  AciCategory,
  AciToolDef,
} from "../../../src/harness/aci/types.ts";

/**
 * The ids whose walls this stage migrates. The two excluded ids are Stage 1's
 * substitution family, whose rendered desc grammar (`subst=` / `param=` /
 * `combo=`) is already pinned by the T13 table in
 * `tests/harness/permission/substitution-matrix.test.ts`; the mapped type is
 * itself the completeness pin — an id added to `DangerousPatternId` without a
 * row here, or without a stated reason to belong to the other table, fails the
 * test-source typecheck (`npm run typecheck:tests`) before it can fail here.
 */
type DestructiveFamilyId = Exclude<
  DangerousPatternId,
  "parameter-expansion" | "interpreter-procsub"
>;

interface GoldenRow {
  /** The representative command, exactly as a caller would send it. */
  readonly command: string;
  /** The `pattern=` payload as it must leave the renderer. */
  readonly desc: string;
  /** The complete deny reason an operator sees, prefix included. */
  readonly reason: string;
}

const GOLDEN_DENY_REASONS: Readonly<Record<DestructiveFamilyId, GoldenRow>> =
  Object.freeze({
    "destructive-rm": {
      command: "rm -rf /",
      desc: "rm -rf",
      reason:
        '[hard_wall] dangerous command pattern matched (id=destructive-rm, pattern="rm -rf")',
    },
    "destructive-disk": {
      // The prefix form, because `mkfs.ext4` is the shape the roster must keep
      // denying after the disk entries move off the text scan.
      command: "mkfs.ext4 /dev/sda1",
      desc: "mkfs",
      reason:
        '[hard_wall] dangerous command pattern matched (id=destructive-disk, pattern="mkfs")',
    },
    "root-find-walk": {
      command: "find /",
      desc: "find",
      reason:
        '[hard_wall] dangerous command pattern matched (id=root-find-walk, pattern="find")',
    },
    "bare-metachar": {
      command: "> /tmp/f",
      desc: ">",
      reason:
        '[hard_wall] dangerous command pattern matched (id=bare-metachar, pattern=">")',
    },
    "command-substitution": {
      command: "echo $(rm -rf /)",
      desc: "subst=dollar-paren→destructive-rm",
      reason:
        '[hard_wall] dangerous command pattern matched (id=command-substitution, pattern="subst=dollar-paren→destructive-rm")',
    },
    unparseable: {
      command: 'echo "$(rm -rf /',
      desc: "verdict=malformed",
      reason:
        '[hard_wall] dangerous command pattern matched (id=unparseable, pattern="verdict=malformed")',
    },
  });

/* -------------------------------------------------------------------------- */
/* the public seam the reason is assembled through                             */
/* -------------------------------------------------------------------------- */

const policy = createPermissionPolicy();

function makeTool(name: string, category: AciCategory): AciToolDef {
  return Object.freeze({
    name,
    description: `golden-reason probe ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: {
      category,
      isConcurrencySafe: category === "read-only",
      interruptBehavior:
        category === "write" ? ("block" as const) : ("cancel" as const),
      timeoutTier: "default" as const,
    },
  });
}

const bashTool = makeTool("bash", "execute");

function hitOf(command: string): DangerousPatternHit | null {
  return findDangerousPattern(command);
}

/** The renderer's own sentence, before policy applies the source prefix. */
function detailOf(command: string): string | undefined {
  const wall = hardWalls().find(
    (spec) => spec.id === "hard-wall:execute-dangerous"
  );
  assert.ok(wall, "hard-wall:execute-dangerous must exist");
  return wall.reasonFor?.({ tool: "bash", input: { command } });
}

/** The operator-visible string, assembled by the same path the executor uses. */
function reasonOf(command: string): string {
  const out = checkPermission({ def: bashTool, input: { command }, policy });
  assert.equal(out.decision, "deny", `expected a deny for ${command}`);
  return out.reason;
}

describe("SC-GATES-6 — the golden deny-reason table, one row per destructive id", () => {
  for (const [id, row] of Object.entries(GOLDEN_DENY_REASONS)) {
    it(`renders ${id} from ${JSON.stringify(row.command)} byte for byte`, () => {
      const hit = hitOf(row.command);
      assert.notEqual(hit, null, row.command);
      assert.equal(hit!.id, id, row.command);
      assert.equal(hit!.pattern, row.desc, row.command);
      // The wrapper sentence is still derived from the hit it renders, so a
      // restructured formatter cannot keep its text and change its shape.
      assert.equal(
        detailOf(row.command),
        `dangerous command pattern matched (id=${hit!.id}, pattern="${hit!.pattern}")`,
        row.command
      );
      assert.equal(reasonOf(row.command), row.reason, row.command);
    });
  }

  it("carries the whitespace-bearing roster descs verbatim", () => {
    // SC-GATES-6 names these three: the AST rules no longer need the padding,
    // so the spaces must live in the emitted text, not have been dropped with
    // the substring table they came from.
    const rows: ReadonlyArray<[string, string, string]> = [
      ["rm -r /tmp", "destructive-rm", "rm -r "],
      ["rm -f /tmp/x", "destructive-rm", "rm -f "],
      ["find /tmp -delete", "destructive-rm", " -delete"],
    ];
    for (const [command, id, desc] of rows) {
      const hit = hitOf(command);
      assert.equal(hit?.id, id, command);
      assert.equal(hit?.pattern, desc, command);
      assert.equal(
        reasonOf(command),
        `${HARD_WALL_DENY_PREFIX} dangerous command pattern matched (id=${id}, pattern="${desc}")`,
        command
      );
    }
  });

  it("keeps `find / -delete` reporting the root walk, not the roster entry", () => {
    // The ordered fold keeps first claim over the command-word rule, so which
    // wall answers is part of the string contract, not only what it says.
    const hit = hitOf("find / -delete");
    assert.equal(hit?.id, "root-find-walk", "find / -delete");
    assert.equal(hit?.pattern, "find", "find / -delete");
    assert.equal(
      reasonOf("find / -delete"),
      '[hard_wall] dangerous command pattern matched (id=root-find-walk, pattern="find")'
    );
  });
});

describe("SC-GATES-6 — the sensitive-path arm keeps its own non-`pattern=` sentence", () => {
  // It is reachable through the same wrapper (the second, sequential check
  // inside `classifyDangerousExecute`), and the two reason shapes must stay
  // distinguishable exactly as today: no `pattern=`, no id, and no
  // `findDangerousPattern` hit in front of it.
  const command = "echo 'cat ~/.ssh/id_rsa'";

  it("denies with the sensitive-path sentence, not the pattern wrapper", () => {
    assert.equal(hitOf(command), null, command);
    assert.equal(
      detailOf(command),
      "dangerous command: sensitive path targeted by command",
      command
    );
    assert.equal(
      reasonOf(command),
      "[hard_wall] dangerous command: sensitive path targeted by command",
      command
    );
    assert.equal(reasonOf(command).includes("pattern="), false, command);
  });

  it("stays behind the pattern arms when both would speak", () => {
    // A command that hits a pattern AND names a sensitive path must still
    // render the `pattern=` shape — the ordering is what makes the two
    // distinguishable, and a swap would read as a renderer change.
    const both = "rm -rf ~/.ssh/keys";
    assert.equal(hitOf(both)?.id, "destructive-rm", both);
    assert.equal(
      reasonOf(both),
      '[hard_wall] dangerous command pattern matched (id=destructive-rm, pattern="rm -rf")',
      both
    );
  });
});

describe("SC-GATES-6 — the one authorized (id, pattern) move, tier unchanged", () => {
  const forkBomb = ":(){ :|:& };:";

  // The contract admits exactly one row whose reported (id, pattern) pair
  // moves: this shape denied before and denies after, and the structural rule's
  // own literal is what names it now, so the two fields are pinned together
  // rather than one kept as the separator noise that used to answer it.
  it('renders destructive-disk / ":(){ :|:& };:"', () => {
    const hit = hitOf(forkBomb);
    assert.equal(hit?.id, "destructive-disk", forkBomb);
    assert.equal(hit?.pattern, ":(){ :|:& };:", forkBomb);
    assert.equal(
      reasonOf(forkBomb),
      '[hard_wall] dangerous command pattern matched (id=destructive-disk, pattern=":(){ :|:& };:")',
      forkBomb
    );
  });

  // The relabelling is all this row is allowed to be: an id change that also
  // moved the tier would read as a relaxation wearing a rename, so the tier is
  // pinned against the new reporter too (SC-GATES-5).
  it("already denies, at the same tier, whichever wall answers it", () => {
    assert.equal(
      reasonOf(forkBomb).startsWith(`${HARD_WALL_DENY_PREFIX} `),
      true
    );
    assert.equal(
      checkPermission({
        def: bashTool,
        input: { command: forkBomb },
        policy,
      }).decision,
      "deny"
    );
  });
});
