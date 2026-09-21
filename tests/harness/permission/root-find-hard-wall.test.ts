/**
 * Hard-wall: root `find` walks are denied before spawn.
 *
 * Invariant pinned here: a `find` whose search root denotes the filesystem
 * root never reaches the bash handler — no grant, no `full_auto`, and no
 * isolation-read classification can turn it into an executed walk. CONTEXT
 * **hard-wall** (ADR-0068) is the un-overridable spawn-time intent filter;
 * in the default global FS posture the fence has no bound on a whole-machine
 * read walk, and the 2026-09-14 incident ran `find /` for ~232 s until the
 * host cancelled.
 *
 * The inverse is pinned with the same strength: `find .` / `find <root>/…`
 * relative walks and `find /tmp …` are NOT this wall — scoping the tree is
 * the reader's job, and the wall must not become a blanket `find` ban.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  findDangerousPattern,
  isDangerousCommand,
  splitShellSegments,
} from "../../../src/harness/permission/hard-walls.js";
import {
  checkPermission,
  createPermissionPolicy,
} from "../../../src/harness/permission/policy.js";
import { createSessionGrants } from "../../../src/harness/permission/session-grants.js";
import { createPermissionRuntime } from "../../../src/harness/permission/permission-executor.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.js";

/* The wall's deny surface for bash commands: the pattern id is what the
 * model-visible reason carries (SC3), so assert on it, not on a bool. */
function patternId(command: string): string | undefined {
  return findDangerousPattern(command)?.id;
}

/** Commands the wall MUST deny: filesystem-root search roots. */
const DENIED: ReadonlyArray<string> = [
  "find /",
  "find / -maxdepth 3",
  "find / -maxdepth 1",
  "find / -name x",
  "find / -type f -print",
  "find  /",
  "find / ",
  'find "/"',
  "find '/'",
  "find //",
  "find / -maxdepth 3 -name '*.ts'",
  "find /tmp/.. -maxdepth 2",
  "find /./ -name x",
  "find /../ -maxdepth 1",
  "find -L / -maxdepth 2",
  "find -- / -maxdepth 1",
  "find -O2 / -maxdepth 1",
  "find -D tree / -maxdepth 1",
  // wrapper prefixes forward the same argv
  "sudo find / -maxdepth 2",
  "env -i find / -maxdepth 1",
  "nohup find / -maxdepth 1",
  // a wrapper's value-taking flag eats its value, so the wrapped command word
  // is still located (value-blind scanning would land on `root` / `HOME` / the
  // duration and let the walk through)
  "sudo -u root find / -maxdepth 3",
  "sudo --user root find / -maxdepth 3",
  "sudo -uroot find / -maxdepth 3",
  "env -u HOME find / -maxdepth 3",
  "env --unset HOME find / -maxdepth 3",
  "timeout -s KILL 5 find / -maxdepth 3",
  "nice -n 5 find / -maxdepth 3",
  "stdbuf -o L find / -maxdepth 3",
  "setsid find / -maxdepth 3",
  // xargs forwards its argument run the same way
  "xargs find / -maxdepth 3",
  // a quoted command word is the same command to bash
  '"find" / -maxdepth 3',
  "'find' / -maxdepth 3",
  // relative operands resolve against the cd-folded cwd, not literal equality:
  // `cd /tmp && find ..` is `find /`
  "cd / && find ./.. && ls",
  "cd / && find ../ && ls",
  "cd / && find ../.",
  "cd /tmp && find ..",
  "cd / && find ./.",
  // a one-level directory's parent IS the root
  "cd /home && find ..",
  "cd /usr && find ..",
  // a glob rooted at / is the same whole-machine walk after expansion
  "find /*",
  "find /?",
  // cwd-relative form with the root hidden in the cd
  "cd / && find .",
  "cd /; find .",
  "cd / && find -maxdepth 2",
  'cd "/" && find .',
  "cd /tmp/.. && find .",
  "cd / && find . -name x",
  // `cd`'s own options do not change the destination
  "cd -- / && find .",
  "cd -P / && find .",
  // a chained cd back out of a non-root dir: `..` from /tmp is /
  "cd /tmp && cd .. && find .",
  "cd /tmp && cd ./.. && find .",
  // `cd -` swaps OLDPWD back in: the third cd returns to the root
  "cd / && cd /tmp && cd - && find .",
  // bare find with no path operand when the cwd IS the root
  "cd / && find",
  "cd / && find -name x",
  // subsequent line: a newline splits statements like `;`
  "echo go\ncd / && find .",
];

/** Commands the wall must NOT deny: same shape, non-root walk root. */
const ALLOWED: ReadonlyArray<string> = [
  "find .",
  "find ..",
  "find . -name x",
  "find ./src -name '*.ts'",
  "find src -maxdepth 2",
  "find -maxdepth 2 ./src",
  "find /tmp",
  "find /tmp -maxdepth 2",
  "find /tmp -maxdepth 2 -name x",
  "find /home",
  "find /usr/share -maxdepth 1",
  "sudo find /tmp -maxdepth 1",
  "sudo -u root find /tmp -maxdepth 1",
  "env -u HOME find /usr/share -maxdepth 1",
  // a `cd /` that precedes no find is out of this wall's scope
  "cd / && ls",
  "cd / && head -1 /etc/hostname",
  // the wall must not leak into other commands
  "echo find /",
  "cat find",
  "which find",
  // GNU find rejects options-first spellings with "paths must precede
  // expression" before walking anything, so they are not this walk. Proven
  // against the real binary (findutils 4.10.0): `find -maxdepth 1 /tmp`
  // exits 1 with `paths must precede expression`.
  "find -maxdepth 1 /",
  "find -maxdepth 2 /tmp",
];

/**
 * Commands that must not be denied *by this wall* — a non-root `cd` (or an
 * unreadable one) leaves the walk out of this wall's scope, whatever the
 * other layers decide. Asserting `!== "root-find-walk"` pins the boundary
 * this wall owns without claiming the command is executable.
 */
const NOT_THE_WALK_WALL: ReadonlyArray<string> = [
  // `cd` to a non-root prefix must not arm the walk wall
  "cd /tmp && find .",
  "cd /usr/share && find .",
  "cd ~ && find .",
  "cd && find .",
  // bare find after a non-root cd (walks the non-root cwd)
  "cd /tmp && find",
  // a chained cd that leaves the root: the LAST cd decides the cwd
  "cd / && cd /tmp && find .",
  "cd / && cd /tmp && find",
  // an unreadable destination (`~` expands to an unknown path) must not make
  // the fold claim the root
  "cd / && cd ~ && find .",
  "cd / && cd $HOME && find .",
];

describe("hard-wall: root find — denied cases", () => {
  for (const command of DENIED) {
    it(`denies ${JSON.stringify(command)}`, () => {
      const hit = findDangerousPattern(command);
      assert.notEqual(hit, null, `expected a hit for ${command}`);
      assert.equal(hit!.id, "root-find-walk");
      assert.ok(
        hit!.pattern.length > 0,
        "hit must carry a non-empty pattern (SC3)"
      );
      assert.equal(isDangerousCommand(command), true);
    });
  }
});

describe("hard-wall: root find — allowed cases (no blanket find ban)", () => {
  for (const command of ALLOWED) {
    it(`does not deny ${JSON.stringify(command)}`, () => {
      assert.equal(
        patternId(command),
        undefined,
        `unexpected hit for ${command}: ${JSON.stringify(findDangerousPattern(command))}`
      );
    });
  }
});

describe("hard-wall: root find — non-root cd never arms this wall", () => {
  for (const command of NOT_THE_WALK_WALL) {
    it(`is not the walk wall for ${JSON.stringify(command)}`, () => {
      assert.notEqual(
        patternId(command),
        "root-find-walk",
        `unexpected walk hit for ${command}`
      );
    });
  }
});

describe("hard-wall: root find — reason is typed and model-visible", () => {
  const policy = createPermissionPolicy();
  const bash = Object.freeze({
    name: "bash",
    description: "test bash",
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: Object.freeze({
      category: "execute" as const,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "build" as const,
    }),
  }) as AciToolDef;

  it("deny reason carries [hard_wall] + the root-find-walk id", () => {
    const out = checkPermission({
      def: bash,
      input: { command: "find / -maxdepth 3" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.startsWith("[hard_wall] "), out.reason);
    assert.ok(out.reason.includes("root-find-walk"), out.reason);
    assert.ok(out.reason.includes("find"), out.reason);
  });

  it("a permissive session grant cannot override the wall", () => {
    const session = createSessionGrants();
    session.add({
      id: "session-allow-all",
      match: () => true,
      decision: "allow",
      reason: "session allows everything",
    });
    const p = createPermissionPolicy({ session });
    const out = checkPermission({
      def: bash,
      input: { command: "find /" },
      sources: p.sources,
      hardWalls: p.hardWalls,
      defaultByCategory: p.defaultByCategory,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("root-find-walk"), out.reason);
  });

  it("full_auto cannot override the wall", () => {
    const p = createPermissionPolicy({ mode: "full_auto" });
    const out = checkPermission({
      def: bash,
      input: { command: "cd / && find ." },
      sources: p.sources,
      hardWalls: p.hardWalls,
      defaultByCategory: p.defaultByCategory,
      mode: p.mode,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("root-find-walk"), out.reason);
  });

  it("read-only category + full_auto still denies (mode never relaxes a wall)", () => {
    const readOnlyBash = Object.freeze({
      ...bash,
      aci: Object.freeze({ ...bash.aci, category: "read-only" as const }),
    }) as AciToolDef;
    const p = createPermissionPolicy({ mode: "full_auto" });
    const out = checkPermission({
      def: readOnlyBash,
      input: { command: "find / -maxdepth 5" },
      sources: p.sources,
      hardWalls: p.hardWalls,
      defaultByCategory: p.defaultByCategory,
      mode: p.mode,
    });
    assert.equal(out.decision, "deny");
  });
});

describe("hard-wall: root find — executor chain never reaches spawn", () => {
  // End-to-end over the real permission runtime (the same one
  // createAciExecutor wires at src/harness/aci/aci-executor.ts:129): the
  // spawn-adjacent inner executor must see zero calls, so no bash process is
  // started even though the runtime was built for a mode that would
  // otherwise auto-allow.
  it("denies before inner under full_auto (no bash spawn)", async () => {
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
    const bashDef = Object.freeze({
      name: "bash",
      description: "test bash",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async () => "ok",
      aci: Object.freeze({
        category: "execute" as const,
        isConcurrencySafe: false,
        interruptBehavior: "cancel" as const,
        timeoutTier: "build" as const,
      }),
    }) as AciToolDef;
    const runtime = createPermissionRuntime({
      inner,
      registry: Object.freeze({
        list: () => [bashDef],
        get: (name: string) => (name === "bash" ? bashDef : undefined),
      }),
      policy: createPermissionPolicy({ mode: "full_auto" }),
      askUser: async () => true,
    });

    const [result] = await runtime.executor.executeAll([
      { id: "t4-find", name: "bash", input: { command: "find / -maxdepth 3" } },
    ]);

    assert.equal(calls.length, 0, "bash inner must not be reached");
    assert.equal(result!.kind, "execution_failed");
    assert.match(
      (result as { message: string }).message,
      /\[permission_denied\]/
    );
    assert.match((result as { message: string }).message, /root-find-walk/);

    // Positive control: the same runtime DOES reach inner for a scoped walk,
    // so the zero-call assertion above pins the wall and not a broken chain.
    const [ok] = await runtime.executor.executeAll([
      {
        id: "t4-scoped",
        name: "bash",
        input: { command: "find ./src -name x" },
      },
    ]);
    assert.equal(calls.length, 1, "scoped find must reach inner");
    assert.equal(ok!.kind, "ok");
  });
});

describe("hard-wall: root find — splitShellSegments semantics unchanged", () => {
  // A peer (isolation worktree gate) consumes this splitter; the root-find
  // wall must not have moved its boundaries.
  it("still splits on ; / && / || / | and keeps escaped separators literal", () => {
    assert.deepEqual(splitShellSegments("cd / && find ."), ["cd /", "find ."]);
    assert.deepEqual(splitShellSegments("cd /; find ."), ["cd /", "find ."]);
    assert.deepEqual(splitShellSegments("a | b"), ["a", "b"]);
    assert.deepEqual(splitShellSegments("r\\m -rf /"), ["r\\m -rf /"]);
  });

  it("does not split on newlines (per-line fold owns that boundary)", () => {
    assert.deepEqual(splitShellSegments("cd /\nfind ."), ["cd /\nfind ."]);
  });
});
