/**
 * Hard-wall: the read-only root-search exception (spec Success Criterion 6,
 * `specs/hard-wall-denial-alignment.md`; Assumption 4 "Root search"; ADR-0134
 * "Read-only root traversal reaches normal permission checks and this common
 * execution contract").
 *
 * The contract this file pins, in the two halves the spec states separately:
 *
 *   1. A `find` whose search root denotes the filesystem root is NOT denied for
 *      that reason. It proceeds through ordinary permission checks (which is
 *      where the mode, the session grants and the category default live) and,
 *      once admitted, through the SAME Bash execution deadline every other
 *      foreground call uses (ADR-0134: 10 s by default, a validated
 *      `timeout_ms` otherwise). There is no root-search-specific limit — the
 *      absence of one is asserted directly against the tool's own declaration.
 *
 *   2. The exception covers READ-ONLY TRAVERSAL INTENT ONLY. A root search
 *      carrying mutation — `-delete`, any `-exec` / `-execdir` / `-ok` /
 *      `-okdir` form, any `-fprint` / `-fprint0` / `-fprintf` / `-fls` file-
 *      producing form, or a `rm` / `xargs rm` combination the search feeds —
 *      does not inherit the allowance and keeps denying.
 *
 * The allowance is decided from `find`'s OWN GRAMMAR, not from a list of bad
 * words. Every predicate the allowance admits is a name in
 * `READ_ONLY_FIND_PREDICATES` with its real arity, and anything the roster does
 * not name withholds it. That direction is deliberate: an open-ended "is this
 * predicate harmless?" test would leak every future flag `find` grows, whereas
 * a closed roster only ever has to be extended by a human who has read what the
 * new flag does.
 *
 * The roster itself is pinned against the real binary in
 * `root-find-predicate-roster.test.ts`, which runs GNU findutils and records
 * what it actually accepts — including the abbreviation question, since an
 * allowlist that missed a shortened spelling would be spelled around.
 *
 * `root-find-hard-wall.test.ts` pins the wall's deny surface and the grammar
 * facts (which root spellings fold to `/`, which carriers read them); this file
 * pins the two questions SC6 asks about what the wall does with that root.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  findDangerousPattern,
  isDangerousCommand,
} from "../../../src/harness/permission/hard-walls.js";
import {
  checkPermission,
  createPermissionPolicy,
} from "../../../src/harness/permission/policy.js";
import { createSessionGrants } from "../../../src/harness/permission/session-grants.js";
import { createPermissionRuntime } from "../../../src/harness/permission/permission-executor.js";
import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import {
  DEFAULT_FOREGROUND_BASH_TIMEOUT_MS,
  TIMEOUT_TIER_MS,
  type AciToolDef,
} from "../../../src/harness/aci/types.js";
import type { Executor, ToolCall } from "../../../src/harness/tools/types.js";

function patternId(command: string): string | undefined {
  return findDangerousPattern(command)?.id;
}

/** The bash tool def the permission layer is asked about. */
function bashDef(category: "execute" | "read-only" = "execute"): AciToolDef {
  return Object.freeze({
    name: "bash",
    description: "test bash",
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: Object.freeze({
      category,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "build" as const,
    }),
  }) as AciToolDef;
}

/**
 * Representative read-only root searches, with and without `-maxdepth`, and
 * across the spellings of the root and the search root's position in the argv.
 * Every one must clear the hard wall.
 */
const READ_ONLY_ROOT_SEARCHES: ReadonlyArray<string> = [
  "find /",
  "find / -maxdepth 1",
  "find / -maxdepth 3",
  "find / -maxdepth 3 -name '*.ts'",
  "find / -name x",
  "find / -type f -print",
  "find / -type f -printf '%p\\n'",
  "find / -name x -print0",
  "find / -size +10M",
  "find / -user root -group root -ls",
  "find / -path /proc -prune -o -type f -print",
  "find / \\( -name '*.pem' -o -name 'id_rsa' \\) -print",
  "find / ! -type d -print",
  "find / -name x -o -name y -print",
  "find / -newer /tmp/anchor -print",
  "find / -maxdepth 1 -quit",
  // root spellings
  "find //",
  'find "/"',
  "find '/'",
  "find /./ -name x",
  "find /../ -maxdepth 1",
  "find /tmp/.. -maxdepth 2",
  "find /*",
  // global options and `--` before the root
  "find -L / -maxdepth 2",
  "find -H / -maxdepth 2",
  "find -P / -maxdepth 2",
  "find -- / -maxdepth 1",
  "find -O2 / -maxdepth 1",
  "find -D tree / -maxdepth 1",
  // multiple roots, one of them the filesystem root. Both roots must PRECEDE
  // the expression: `find / -maxdepth 1 /tmp` is not a two-root search, it is a
  // command real find rejects with "paths must precede expression" (verified
  // against findutils 4.10), so there is no traversal for it to be.
  "find /tmp / -maxdepth 1",
  "find / /tmp -maxdepth 1",
  // quoted / escaped command word
  '"find" / -maxdepth 3',
  "'find' / -maxdepth 3",
  "f\\ind / -maxdepth 3",
  // wrapper prefixes forward the same argv
  "sudo find / -maxdepth 2",
  "sudo -u root find / -maxdepth 3",
  "env -i find / -maxdepth 1",
  "timeout -s KILL 5 find / -maxdepth 3",
  "nohup find / -maxdepth 1",
  "xargs find / -maxdepth 3",
  // the root hidden in a `cd`, which is the fold's whole reason for existing
  "cd / && find .",
  "cd /; find .",
  'cd "/" && find .',
  "cd / && find . -name x",
  "cd / && find -maxdepth 2",
  "cd / && find",
  "cd / && find -name x",
  "cd /tmp && find ..",
  "cd /home && find ..",
  "cd /tmp/.. && find .",
  "cd / && find ./..",
  "cd / && find ../ && ls",
  "cd -- / && find .",
  "cd -P / && find .",
  "cd /tmp && cd .. && find .",
  "cd / && cd /tmp && cd - && find .",
  "echo go\ncd / && find .",
];

describe("SC6 — a read-only root search is not denied for being rooted at /", () => {
  for (const command of READ_ONLY_ROOT_SEARCHES) {
    it(`clears the wall for ${JSON.stringify(command)}`, () => {
      assert.equal(
        patternId(command),
        undefined,
        `unexpected hit: ${JSON.stringify(findDangerousPattern(command))}`
      );
      assert.equal(isDangerousCommand(command), false);
    });
  }
});

/**
 * The mutating and effectful root searches, each of which must keep denying.
 * The id is not pinned per row — the spec only requires that these never gain
 * the allowance — but every row is asserted to deny, and the rows are grouped
 * so the report names which shape is being held.
 */
const MUTATING_ROOT_SEARCHES: ReadonlyArray<
  readonly [group: string, command: string]
> = [
  // -delete, in the shapes find actually accepts
  ["delete", "find / -delete"],
  ["delete", "find / -name '*.log' -delete"],
  ["delete", "find / -delete -print"],
  ["delete", "find / -print -delete"],
  ["delete", "find / \\( -name x -o -delete \\)"],
  ["delete", "find / -name x -o -delete"],
  ["delete", "find /tmp -name x -delete"],
  ["delete", "cd / && find . -delete"],
  // -exec / -execdir / -ok / -okdir, both terminators
  ["exec", "find / -exec rm {} +"],
  ["exec", "find / -exec rm {} \\;"],
  ["exec", "find / -execdir rm {} \\;"],
  ["exec", "find / -ok rm {} \\;"],
  ["exec", "find / -okdir rm {} \\;"],
  ["exec", "find / -name '*.log' -exec sh -c 'rm -f $1' _ {} \\;"],
  ["exec", "find / -exec touch /tmp/pwned \\;"],
  ["exec", "cd / && find . -exec chmod 777 {} \\;"],
  ["exec", "sudo find / -exec rm -rf {} \\;"],
  // file-producing actions
  ["fprint", "find / -fprint /tmp/out"],
  ["fprint", "find / -fprint0 /tmp/out"],
  ["fprint", "find / -fprintf /tmp/out '%p\\n'"],
  ["fprint", "find / -fls /tmp/out"],
  // a search feeding a destructive consumer
  ["xargs-rm", "find / -name '*.log' | xargs rm -rf"],
  ["xargs-rm", "find / -name '*.log' -print0 | xargs -0 rm -f"],
  ["xargs-rm", "find / -name x | xargs -I{} rm {}"],
  ["xargs-rm", "cd / && find . | xargs rm -rf"],
  ["xargs-rm", "find / -name x -print0 | xargs -0 rmdir"],
  // the root hidden in a `cd`, mutating
  ["cd-hidden", "cd / && find . -delete"],
  ["cd-hidden", "cd /tmp && find .. -delete"],
  ["cd-hidden", "cd / && find . -exec rm {} +"],
];

describe("SC6 — a mutating root search does not inherit the allowance", () => {
  for (const [group, command] of MUTATING_ROOT_SEARCHES) {
    it(`still denies [${group}] ${JSON.stringify(command)}`, () => {
      const hit = findDangerousPattern(command);
      assert.notEqual(
        hit,
        null,
        `expected a deny for ${command} (group=${group})`
      );
      assert.equal(isDangerousCommand(command), true);
    });
  }
});

/**
 * The fail-closed direction, which is what makes the roster an allowlist rather
 * than a list of known-bad words. Each of these is a predicate GNU findutils
 * either does not know at all, or knows as a mutating one: the search either
 * fails outright or does something the traversal allowance must never cover,
 * and in both cases the wall keeps its answer. A rule that asked "is any token
 * here on a list of mutating flags?" would ALLOW all of them, because none of
 * them is on that list.
 */
const UNRECOGNISED_OR_EFFECTFUL_TOKENS: ReadonlyArray<string> = [
  "find / -deletee x",
  "find / -delet x",
  "find / -del x",
  "find / -execu rm {} \\;",
  "find / -exe rm {} \\;",
  "find / -exect rm {} \\;",
  "find / -execd rm {} \\;",
  "find / -okdir rm {} \\;",
  "find / -fpri /tmp/out",
  "find / -fprin /tmp/out",
  "find / -fl /tmp/out",
  "find / -mkfif x",
  "find / -delete -print",
];

describe("SC6 — the allowance is fail-closed on every token the roster does not name", () => {
  for (const command of UNRECOGNISED_OR_EFFECTFUL_TOKENS) {
    it(`denies ${JSON.stringify(command)}`, () => {
      assert.notEqual(
        findDangerousPattern(command),
        null,
        `a token outside the read-only roster must withhold the allowance: ${command}`
      );
    });
  }
});

describe("SC6 — the allowance defers to every other wall", () => {
  it("a root search naming a protected path is still a confirmed sensitive-path deny", () => {
    // The traversal allowance is a finding-level exception on the root-find
    // id. It does not touch ADR-0131's confirmed sensitive-path arm, which
    // reads the same command and answers for the protected target.
    const command = "find / -name id_rsa -print";
    assert.equal(patternId(command), undefined, "no pattern-level hit");
    assert.equal(isDangerousCommand(command), false);
    // The sensitive wall is a separate classification, reached by the
    // permission hard-wall rather than by the pattern id.
    const out = checkPermission({
      def: bashDef(),
      input: { command },
      sources: createPermissionPolicy().sources,
      hardWalls: createPermissionPolicy().hardWalls,
      defaultByCategory: createPermissionPolicy().defaultByCategory,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.startsWith("[hard_wall] "), out.reason);
    assert.ok(out.reason.includes("sensitive path"), out.reason);
  });

  it("a root search writing to a protected path is still denied", () => {
    const out = checkPermission({
      def: bashDef(),
      input: { command: "find / -name x -fprint /etc/passwd" },
      sources: createPermissionPolicy().sources,
      hardWalls: createPermissionPolicy().hardWalls,
      defaultByCategory: createPermissionPolicy().defaultByCategory,
    });
    assert.equal(out.decision, "deny");
  });

  it("a root search mixed with an unrelated destructive command still denies", () => {
    // The allowance belongs to the `find` node; a second command in the same
    // shell is judged on its own. The id is not asserted, because the wall
    // legitimately reaches these from two directions — the destructive arm when
    // the `rm` comes first, the walk arm's consumer rule when the search feeds
    // it — and the contract SC6 states is only that the call does not proceed.
    for (const command of [
      "find / -maxdepth 1 && rm -rf /tmp/x",
      "rm -rf /tmp/x && find / -maxdepth 1",
    ]) {
      assert.notEqual(
        findDangerousPattern(command),
        null,
        `expected a deny for ${command}`
      );
      assert.equal(isDangerousCommand(command), true, command);
    }
  });
});

describe("SC6 — an admitted root search reaches ordinary permission handling", () => {
  it("default mode asks (category default for execute), not deny", () => {
    const p = createPermissionPolicy();
    const out = checkPermission({
      def: bashDef(),
      input: { command: "find / -maxdepth 1" },
      sources: p.sources,
      hardWalls: p.hardWalls,
      defaultByCategory: p.defaultByCategory,
    });
    assert.equal(out.decision, "ask");
    assert.ok(
      !out.reason.includes("hard_wall"),
      `an ordinary ask must not carry a hard_wall reason: ${out.reason}`
    );
  });

  it("a session grant that allows the read now reaches the inner executor", () => {
    // The old wall sat ABOVE the grant layer, so a permissive session could
    // not reach spawn. Now the grant is the thing that admits it, which is what
    // "proceeds through ordinary permission checks" means concretely.
    const session = createSessionGrants();
    session.add({
      id: "session-allow-all",
      match: () => true,
      decision: "allow",
      reason: "session allows everything",
    });
    const p = createPermissionPolicy({ session });
    const out = checkPermission({
      def: bashDef(),
      input: { command: "find / -maxdepth 1" },
      sources: p.sources,
      hardWalls: p.hardWalls,
      defaultByCategory: p.defaultByCategory,
    });
    assert.equal(out.decision, "allow");
  });

  it("full_auto allows a read-only root search", () => {
    const p = createPermissionPolicy({ mode: "full_auto" });
    const out = checkPermission({
      def: bashDef(),
      input: { command: "find / -maxdepth 1" },
      sources: p.sources,
      hardWalls: p.hardWalls,
      defaultByCategory: p.defaultByCategory,
      mode: p.mode,
    });
    assert.equal(out.decision, "allow");
  });

  it("full_auto still denies a mutating root search", () => {
    const p = createPermissionPolicy({ mode: "full_auto" });
    const out = checkPermission({
      def: bashDef(),
      input: { command: "find / -delete" },
      sources: p.sources,
      hardWalls: p.hardWalls,
      defaultByCategory: p.defaultByCategory,
      mode: p.mode,
    });
    assert.equal(out.decision, "deny");
  });

  it("a read-only CATEGORY does not change a mutating root search's deny", () => {
    const p = createPermissionPolicy({ mode: "full_auto" });
    const out = checkPermission({
      def: bashDef("read-only"),
      input: { command: "find / -maxdepth 5 -delete" },
      sources: p.sources,
      hardWalls: p.hardWalls,
      defaultByCategory: p.defaultByCategory,
      mode: p.mode,
    });
    assert.equal(out.decision, "deny");
  });
});

describe("SC6 — the executor chain reaches spawn for a read-only root search", () => {
  it("reaches inner under full_auto, exactly like a scoped walk", async () => {
    const calls: ToolCall[][] = [];
    const inner: Executor = Object.freeze({
      executeAll: async (
        batch: ReadonlyArray<ToolCall>
      ): Promise<ReadonlyArray<ToolExecutionResult>> => {
        calls.push([...batch]);
        return batch.map((c) => ({
          kind: "ok" as const,
          toolUseId: c.id,
          payload: [{ type: "text" as const, text: `executed:${c.name}` }],
        }));
      },
    });
    const def = bashDef();
    const runtime = createPermissionRuntime({
      inner,
      registry: Object.freeze({
        list: () => [def],
        get: (name: string) => (name === "bash" ? def : undefined),
      }),
      policy: createPermissionPolicy({ mode: "full_auto" }),
      askUser: async () => true,
    });

    const [readOnly] = await runtime.executor.executeAll([
      { id: "sc6-readonly", name: "bash", input: { command: "find / -maxdepth 1" } },
    ]);
    assert.equal(calls.length, 1, "a read-only root search must reach inner");
    assert.equal(readOnly!.kind, "ok");

    // The mutating twin never reaches it, under the same runtime and mode.
    const [mutating] = await runtime.executor.executeAll([
      { id: "sc6-mutating", name: "bash", input: { command: "find / -maxdepth 1 -delete" } },
    ]);
    assert.equal(calls.length, 1, "a mutating root search must not reach inner");
    assert.equal(mutating!.kind, "execution_failed");
    assert.match(
      (mutating as { message: string }).message,
      /\[permission_denied\]/
    );
  });
});

describe("SC6 — a root search has no deadline of its own", () => {
  // SC6's third clause. Asserted against the tool's own declaration rather
  // than by timing a walk: the claim is that nothing distinguishes a root
  // search from any other foreground call, so the place that could carry a
  // root-search-specific cap is the tool's tier and its resolved deadline.
  it("bash carries no ACI tier clock, so nothing can clip or add a root-search cap", () => {
    const tool = createBashTool("/tmp");
    assert.equal(tool.aci.timeoutTier, "unbounded");
    assert.equal(TIMEOUT_TIER_MS[tool.aci.timeoutTier], 0);
  });

  it("the default foreground deadline is the common 10 s, with no search-specific default", () => {
    assert.equal(DEFAULT_FOREGROUND_BASH_TIMEOUT_MS, 10_000);
  });

  it("the tool's description offers one timeout input, not a root-search one", () => {
    const tool = createBashTool("/tmp");
    assert.ok("timeout_ms" in tool.inputSchema.properties);
    const named = Object.keys(tool.inputSchema.properties).filter((key) =>
      /root|find|search|walk/i.test(key)
    );
    assert.deepEqual(named, [], "no root-search-specific input exists");
  });
});
