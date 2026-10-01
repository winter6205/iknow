/**
 * Hard-wall: the root `find` walk — what it still denies, and what it no
 * longer does.
 *
 * CONTEXT **hard-wall** (ADR-0068) is the un-overridable spawn-time intent
 * filter, and the 2026-09-14 incident that shaped it ran `find /` for ~232 s
 * until the host cancelled. That incident is why this wall exists, and it is
 * also the reason the wall cannot simply keep denying every root walk: the cost
 * of the deny was a whole class of legitimate, read-only searches that could
 * not run at all, and the cost of allowing them is not a new hole if the walk
 * is bounded — which it now is.
 *
 * What this file pins, under `specs/hard-wall-denial-alignment.md` SC6
 * ("Root read-only search") and Assumption 4 "Root search":
 *
 *   1. A MUTATING root search is still denied before spawn, and no grant, no
 *      `full_auto` and no read-only category can turn it into an executed
 *      walk. `-delete`, `-exec` / `-execdir` / `-ok` / `-okdir`, the
 *      file-producing `-fprint` family, and a root search feeding an `rm` are
 *      decisions about the tree, not searches, and they are what this wall is
 *      for.
 *   2. A READ-ONLY root search is not denied for being rooted at `/`. It
 *      reaches the same ordinary permission checks every other command does,
 *      and once admitted it runs under the SAME Bash execution deadline as
 *      every other foreground call (ADR-0134: 10 s by default, a validated
 *      `timeout_ms` otherwise, enforced in the process plane). There is no
 *      root-search-specific limit — SC6's third clause, asserted directly
 *      against the tool's own declaration in
 *      `root-find-readonly-allowance.test.ts`.
 *
 * So the 232 s incident is now bounded by the runtime deadline rather than by
 * a blanket deny: a walk that overruns is terminated through the same bounded
 * TERM/grace/KILL route as any other expiring command, and reports as a
 * per-call `execution_failed` / `message: "timeout"`. Scoping the tree remains
 * the reader's job — this file still pins that `find .` and `find /tmp` were
 * never this wall to begin with, and the wall must not become a blanket `find`
 * ban in the other direction either. The read-only root search's own matrix
 * (every root spelling, every operator, every arity) lives in
 * `root-find-readonly-allowance.test.ts`; this file is the deny surface and the
 * reason strings.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  findDangerousPattern,
  isDangerousCommand,
} from "../../../src/harness/permission/hard-walls.js";
import { parseForSecurity } from "../../../src/harness/permission/shell-parse.js";
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

/**
 * Commands the wall MUST deny: filesystem-root searches that MUTATE.
 *
 * Every row is a root walk carrying a predicate the read-only roster does not
 * name, or feeding a destructive consumer. The read-only spelling of each shape
 * (`find /`, `cd / && find .`, …) is deliberately NOT here: SC6 removed its
 * deny, and `root-find-readonly-allowance.test.ts` is where those are pinned as
 * reaching ordinary permissions.
 *
 * The root SPELLINGS themselves are unchanged and still worth pinning here, so
 * each group below keeps a mutating predicate and the rows still measure that
 * the wall finds the root no matter how `/` is written or hidden in a `cd`.
 */
const DENIED: ReadonlyArray<string> = [
  "find / -delete",
  "find / -maxdepth 3 -delete",
  "find / -maxdepth 1 -delete",
  "find / -name x -delete",
  "find / -type f -print -delete",
  "find  / -delete",
  // a trailing space is still the same root operand
  "find / -delete",
  'find "/" -delete',
  "find '/' -delete",
  "find // -delete",
  "find / -maxdepth 3 -name '*.ts' -delete",
  "find /tmp/.. -maxdepth 2 -delete",
  "find /./ -name x -delete",
  "find /../ -maxdepth 1 -delete",
  "find -L / -maxdepth 2 -delete",
  "find -- / -maxdepth 1 -delete",
  "find -O2 / -maxdepth 1 -delete",
  "find -D tree / -maxdepth 1 -delete",
  // wrapper prefixes forward the same argv
  "sudo find / -maxdepth 2 -delete",
  "env -i find / -maxdepth 1 -delete",
  "nohup find / -maxdepth 1 -delete",
  // a wrapper's value-taking flag eats its value, so the wrapped command word
  // is still located (value-blind scanning would land on `root` / `HOME` / the
  // duration and let the walk through)
  "sudo -u root find / -maxdepth 3 -delete",
  "sudo --user root find / -maxdepth 3 -delete",
  "sudo -uroot find / -maxdepth 3 -delete",
  "env -u HOME find / -maxdepth 3 -delete",
  "env --unset HOME find / -maxdepth 3 -delete",
  "timeout -s KILL 5 find / -maxdepth 3 -delete",
  "nice -n 5 find / -maxdepth 3 -delete",
  "stdbuf -o L find / -maxdepth 3 -delete",
  "setsid find / -maxdepth 3 -delete",
  // xargs forwards its argument run the same way
  "xargs find / -maxdepth 3 -delete",
  // a quoted command word is the same command to bash
  '"find" / -maxdepth 3 -delete',
  "'find' / -maxdepth 3 -delete",
  // relative operands resolve against the cd-folded cwd, not literal equality:
  // `cd /tmp && find ..` is `find /`
  "cd / && find ./.. -delete && ls",
  "cd / && find ../ -delete && ls",
  "cd / && find ../. -delete",
  "cd /tmp && find .. -delete",
  "cd / && find ./. -delete",
  // a one-level directory's parent IS the root
  "cd /home && find .. -delete",
  "cd /usr && find .. -delete",
  // a glob rooted at / is the same whole-machine walk after expansion
  "find /* -delete",
  "find /? -delete",
  // cwd-relative form with the root hidden in the cd
  "cd / && find . -delete",
  "cd /; find . -delete",
  "cd / && find -maxdepth 2 -delete",
  'cd "/" && find . -delete',
  "cd /tmp/.. && find . -delete",
  "cd / && find . -name x -delete",
  // `cd`'s own options do not change the destination
  "cd -- / && find . -delete",
  "cd -P / && find . -delete",
  // a chained cd back out of a non-root dir: `..` from /tmp is /
  "cd /tmp && cd .. && find . -delete",
  "cd /tmp && cd ./.. && find . -delete",
  // `cd -` swaps OLDPWD back in: the third cd returns to the root
  "cd / && cd /tmp && cd - && find . -delete",
  // bare find with no path operand when the cwd IS the root
  "cd / && find -delete",
  "cd / && find -name x -delete",
  // subsequent line: a newline splits statements like `;`
  "echo go\ncd / && find . -delete",
  // SC-S3-2's owned append. The backslash is stripped by the scan fold, so the
  // command word reads as `find` and its operand as the root. Before T21 this
  // deny came from the splitter's token run; on the parsed path it must come
  // from the SAME fold driven by the tree — the escaped word reaches `argv` as
  // one `WordFact`, `wordSource` unescapes it, and `commandAt` sees a bare
  // `find /`. Both shapes of it, in both carriers:
  "f\\ind / -delete",
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
    // The command is a MUTATING root walk: SC6 removed the deny for the
    // read-only ones, and the id and this exact string are what survives for
    // the ones the wall still owns.
    const out = checkPermission({
      def: bash,
      input: { command: "find / -maxdepth 3 -delete" },
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
    // The claim is about LAYER ORDER, not about a particular command: the
    // hard-wall deny is computed before the session layer is consulted. A
    // mutating root walk is the probe, because a read-only one no longer has a
    // wall to override and would make this assert nothing about ordering.
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
      input: { command: "find / -delete" },
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
      input: { command: "cd / && find . -delete" },
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
      input: { command: "find / -maxdepth 5 -delete" },
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
      // A MUTATING root walk: the probe is the spawn-adjacent inner executor
      // never being reached, and a read-only root walk now reaches it by
      // design (`root-find-readonly-allowance.test.ts` pins that side).
      { id: "t4-find", name: "bash", input: { command: "find / -maxdepth 3 -delete" } },
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

/* SC-S4-6: the former splitter-semantics block is retired with the splitter's
 * export. The two claims it pinned — an escaped `\;` stays inside ONE command,
 * and a bare newline is not a boundary that un-joins commands for this wall —
 * are re-pinned here on the parse, not on segment strings. */
describe("hard-wall: root find — command-node equivalence for escaped separators and newlines", () => {
  it("keeps an escaped \\; literal inside one command node", () => {
    const parsed = parseForSecurity("find . -exec ls {} \\;");
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    // One command, its last argv word still carrying the literal `\;` —
    // the escape never fabricates a sequence boundary.
    assert.equal(parsed.commands.length, 1);
    assert.deepEqual(
      parsed.commands[0]?.argv.map((word) => word.text),
      ["find", ".", "-exec", "ls", "{}", "\\;"]
    );
    assert.equal(
      parsed.operators.filter((op) => op.kind === "sequence").length,
      0
    );
    // Same reading for the backslash-escaped command word: one node, and the
    // destructive scan still sees the whole thing.
    const escaped = parseForSecurity("r\\m -rf /");
    assert.equal(escaped.kind, "ok");
    if (escaped.kind !== "ok") return;
    assert.equal(escaped.commands.length, 1);
    assert.equal(escaped.commands[0]?.argv[0]?.text, "r\\m");
    assert.equal(findDangerousPattern("r\\m -rf /")?.id, "destructive-rm");
  });

  it("does not un-join commands at a bare newline (the one-segment reading survives as facts)", () => {
    const parsed = parseForSecurity("cd /\nfind .");
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    // The newline is recorded as a bare line break, never as an operator
    // token, and both commands stay in ONE parse — one shell, so the earlier
    // `cd /` still sets the cwd the later `find .` walks.
    assert.equal(parsed.commands.length, 2);
    assert.equal(parsed.operators.length, 0);
    assert.deepEqual([...parsed.bareNewlineOffsets], [4]);
    // The wall's answer for that reading: the root-find fold fires across the
    // newline, exactly as it did when the fold read one segment. The command
    // carries a mutating predicate so the row still measures the fold; SC6
    // removed the deny for the read-only spelling of the same shape.
    assert.equal(findDangerousPattern("cd /\nfind . -delete")?.id, "root-find-walk");
    assert.ok(isDangerousCommand("cd /\nfind . -delete"));
  });
});
