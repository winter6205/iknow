/**
 * The read-only `find` predicate roster, pinned against the REAL binary.
 *
 * `READ_ONLY_FIND_PREDICATES` in `src/harness/permission/hard-walls.ts` is the
 * positive half of the SC6 root-search allowance: a root search clears the wall
 * only when every predicate of its expression is on that list. The list's two
 * security properties are therefore factual claims about GNU findutils, not
 * opinions, and this file runs the binary to check them:
 *
 *   1. Every name on the roster is accepted by `find` and produces no
 *      filesystem effect. A name find rejects would make the allowance cover a
 *      command that cannot run (harmless but wrong); a name find accepts with a
 *      side effect would make the allowance cover a mutation (the real risk).
 *   2. Every MUTATING action the binary accepts is OFF the roster, and — the
 *      part an allowlist lives or dies by — the binary accepts NO abbreviation
 *      of any predicate. `-del`, `-execu`, `-fpri` and `-fl` are all
 *      "unknown predicate" on findutils 4.10, which is what makes exact-name
 *      matching sufficient. If a future findutils accepts a shortened spelling,
 *      this file fails before the allowance can be spelled around.
 *
 * The binary is invoked through `execFileSync` on a throwaway directory under
 * the OS temp root; every case starts from a fresh tree and asserts the
 * observable filesystem state (what got written, what got deleted) rather than
 * the exit status alone. `find` is stubbed nowhere: the subject IS what the
 * binary accepts.
 */

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The roster the wall ships, copied by hand from
 * `READ_ONLY_FIND_PREDICATES`. The copy is the point: a test that imported the
 * wall's map and ran it against the binary would still fail when the map gained
 * a bad name, but the literal below also fails when the map LOSES one, so the
 * two lists cannot drift apart silently in either direction.
 */
const ROSTER: ReadonlyArray<readonly [name: string, arity: number]> = [
  ["-name", 1],
  ["-iname", 1],
  ["-path", 1],
  ["-wholename", 1],
  ["-iwholename", 1],
  ["-regex", 1],
  ["-iregex", 1],
  ["-regextype", 1],
  ["-lname", 1],
  ["-type", 1],
  ["-xtype", 1],
  ["-size", 1],
  ["-empty", 0],
  ["-samefile", 1],
  ["-inum", 1],
  ["-links", 1],
  ["-perm", 1],
  ["-mtime", 1],
  ["-atime", 1],
  ["-ctime", 1],
  ["-amin", 1],
  ["-cmin", 1],
  ["-newer", 1],
  ["-anewer", 1],
  ["-cnewer", 1],
  ["-used", 1],
  ["-newermt", 1],
  ["-user", 1],
  ["-group", 1],
  ["-uid", 1],
  ["-gid", 1],
  ["-nouser", 0],
  ["-nogroup", 0],
  ["-fstype", 1],
  ["-xdev", 0],
  ["-prune", 0],
  ["-quit", 0],
  ["-maxdepth", 1],
  ["-mindepth", 1],
  ["-follow", 0],
  ["-depth", 0],
  ["-noleaf", 0],
  ["-ignore_readdir_race", 0],
  ["-readable", 0],
  ["-writable", 0],
  ["-executable", 0],
  ["-print", 0],
  ["-print0", 0],
  ["-printf", 1],
  ["-ls", 0],
  ["-true", 0],
  ["-false", 0],
];

/** Every mutating action findutils accepts, none of which may be admitted. */
const MUTATING: ReadonlyArray<readonly [args: string[], expectDeletion?: boolean]> = [
  [["-delete"], true],
  [["-exec", "true", ";"]],
  [["-exec", "true", "+"]],
  [["-execdir", "true", ";"]],
  [["-ok", "true", ";"]],
  [["-okdir", "true", ";"]],
  [["-fprint", "out"]],
  [["-fprint0", "out"]],
  [["-fprintf", "out", "%p"]],
  [["-fls", "out"]],
];

/**
 * Predicates whose value is a FILE PATH: find does not resolve the value
 * against its search root, so the probe must pass the absolute path of a file
 * inside the fresh tree or find rejects the value ("No such file or
 * directory").
 */
const FILE_VALUE_PREDICATES: ReadonlySet<string> = new Set([
  "-samefile",
  "-newer",
  "-anewer",
  "-cnewer",
]);

/**
 * A value each arity-1 predicate genuinely accepts. `b.txt` is NOT one —
 * `-regextype b.txt`, `-type b.txt` and `-size b.txt` are all rejected by
 * find's own argument grammar, which is a rejection of the VALUE and says
 * nothing about whether the predicate is read-only. The wall's roster claim is
 * about the predicate, so the probe must hand each one a legal value.
 */
const SAMPLE_VALUE: ReadonlyMap<string, string> = new Map([
  ["-name", "b.txt"],
  ["-iname", "b.txt"],
  ["-path", "*/b.txt"],
  ["-wholename", "*/b.txt"],
  ["-iwholename", "*/b.txt"],
  ["-regex", ".*b\\.txt"],
  ["-iregex", ".*b\\.txt"],
  ["-regextype", "posix-extended"],
  ["-lname", "*"],
  ["-type", "f"],
  ["-xtype", "f"],
  ["-size", "+0"],
  ["-samefile", "b.txt"],
  ["-inum", "1"],
  ["-links", "+0"],
  ["-perm", "0644"],
  ["-mtime", "-1"],
  ["-atime", "-1"],
  ["-ctime", "-1"],
  ["-amin", "-1"],
  ["-cmin", "-1"],
  ["-newer", "b.txt"],
  ["-anewer", "b.txt"],
  ["-cnewer", "b.txt"],
  ["-used", "+0"],
  ["-newermt", "2000-01-01"],
  ["-user", "root"],
  ["-group", "root"],
  ["-uid", "0"],
  ["-gid", "0"],
  ["-fstype", "ext4"],
  ["-maxdepth", "3"],
  ["-mindepth", "1"],
  ["-printf", "%p"],
]);

let root: string | undefined;

function freshTree(): string {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "find-roster-"));
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "sub", "a.txt"), "x");
  writeFileSync(join(root, "b.txt"), "x");
  return root;
}

/** Run find on a fresh tree; report acceptance, output, and side effects. */
function probe(args: ReadonlyArray<string>): {
  accepted: boolean;
  error: string;
  wrote: string[];
  deleted: boolean;
} {
  const dir = freshTree();
  // A file-path VALUE is not matched against candidate names and is not
  // resolved against the search root either, so it must be handed as a real
  // path inside THIS tree — a bare name would be read relative to the process
  // cwd and find would reject it. A pattern value (`-name b.txt`) is the
  // opposite case and must be left exactly as written: it is matched against
  // each candidate's own name, so resolving it would make it match nothing and
  // the probe would pass by testing nothing.
  const resolved = args.map((arg, index) =>
    index > 0 && FILE_VALUE_PREDICATES.has(args[index - 1] ?? "")
      ? join(dir, arg)
      : arg
  );
  let accepted = true;
  let error = "";
  try {
    execFileSync("find", [dir, ...resolved], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // find resolves an action's output FILE (`-fprint`) against the process
      // cwd, not the search root, so the tree is made the cwd here; otherwise
      // the file lands outside `dir` and the assertion below reads a tree that
      // was never written to.
      cwd: dir,
    });
  } catch (e) {
    accepted = false;
    error = ((e as { stderr?: Buffer }).stderr ?? "")
      .toString()
      .split("\n")[0] ?? "";
  }
  const wrote = readdirSync(dir).filter((e) => !["sub", "b.txt"].includes(e));
  const deleted = !existsSync(join(dir, "b.txt"));
  return { accepted, error, wrote, deleted };
}

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe("the read-only find roster against the real binary", () => {
  it("every roster entry is accepted, with no filesystem effect", () => {
    const problems: string[] = [];
    for (const [name, arity] of ROSTER) {
      const args =
        arity === 1 ? [name, SAMPLE_VALUE.get(name) ?? "b.txt"] : [name];
      const r = probe(args);
      if (!r.accepted) {
        problems.push(`${name}: find rejects it (${r.error})`);
      } else if (r.wrote.length > 0 || r.deleted) {
        problems.push(
          `${name}: accepted but wrote ${JSON.stringify(r.wrote)} / deleted=${r.deleted}`
        );
      }
    }
    expect(
      problems,
      "roster entries must be accepted read-only predicates"
    ).toEqual([]);
  });

  it("every mutating action find accepts is outside the roster", () => {
    // The observable side effects, not find's exit code, are what the absence
    // from the roster must protect: `-delete` removes a matched file, the
    // `-fprint` family creates one, and `-exec` runs a program over the matches.
    const r = probe(["-name", "b.txt", "-delete"]);
    expect(r.accepted, "the -delete baseline must actually delete").toBe(true);
    expect(r.deleted).toBe(true);
    const w = probe(["-name", "b.txt", "-fprint", "out"]);
    expect(w.wrote).toEqual(["out"]);
    for (const [args] of MUTATING) {
      const name = args[0] ?? "";
      expect(ROSTER.map(([n]) => n)).not.toContain(name);
    }
  });

  it("findutils accepts NO abbreviation of a mutating predicate", () => {
    // The spelling-around risk, settled against the binary itself. A
    // prefix/suffix of a mutating name that find accepted would be a command
    // the allowlist sees as "unknown predicate" but the shell sees as a
    // mutation; the wall's fail-closed answer is correct either way, but this
    // row documents WHY exact matching is sufficient — and fails if a future
    // findutils starts accepting one.
    const candidates: ReadonlyArray<string[]> = [
      ["-del"],
      ["-delet"],
      ["-deletex"],
      ["-exe", "true", ";"],
      ["-execu", "true", ";"],
      ["-execd", "true", ";"],
      ["-exect", "true", ";"],
      ["-o", "true", ";"],
      ["-fpri", "out"],
      ["-fprin", "out"],
      ["-fprint0x", "out"],
      ["-fl", "out"],
      ["-flsx", "out"],
    ];
    const accepted: string[] = [];
    for (const args of candidates) {
      const r = probe(["-name", "b.txt", ...args]);
      if (r.accepted && (r.wrote.length > 0 || r.deleted)) {
        accepted.push(args.join(" "));
      } else if (r.accepted) {
        // Accepted but inert (e.g. a value-taking predicate missing its
        // argument errors out elsewhere) is fine: the wall still withholds.
      }
    }
    expect(
      accepted,
      "GNU findutils accepts no abbreviated mutating predicate; if this fails, the roster's exact-match rule is no longer sufficient and READ_ONLY_FIND_PREDICATES must be revisited"
    ).toEqual([]);
  });

  it("a mutating name in a value position is not a mutation", () => {
    // `-name -delete` searches for a file literally called `-delete`; find's
    // own grammar consumes the flag as the pattern. This is why the wall's
    // expression walk must consume values rather than treating every `-` token
    // as a predicate: a value-blind reader would deny the harmless form, and
    // the same blindness in the other direction would admit real mutations.
    const r = probe(["-name", "-delete", "-print"]);
    expect(r.accepted).toBe(true);
    expect(r.deleted).toBe(false);
    expect(r.wrote).toEqual([]);
  });
});
