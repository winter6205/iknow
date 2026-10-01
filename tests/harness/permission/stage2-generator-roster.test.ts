/**
 * The generator's read-only `find` roster, pinned to the wall's.
 *
 * `scripts/stage2-floor-differential-generate.ts` grades the Stage 2 floor
 * ledger, and class 4 ("expected-relaxation") is the class it awards to the
 * read-only root search the wall stopped denying. To award it, the generator
 * re-derives for itself which `find` expressions are read-only — deliberately
 * WITHOUT importing the wall's `READ_ONLY_FIND_PREDICATES`, because a grader
 * that asked the rule under test whether the command is exempt would be grading
 * its own homework, and a wall that quietly widened would widen the licence
 * with it (`isReadOnlyRootSearchCommand`'s own docstring).
 *
 * That independence is only worth anything while the two rosters agree. The
 * generator's roster is a superset, it prices a command the wall still denies
 * as class 4, and the ledger then records "this relaxation was licensed" for a
 * transition that did not happen. The gate is not weakened today — a superset
 * makes it strict — but the day the wall drops one of the extra names, the
 * generator grades that row `4` instead of `open`, silently, and the licence
 * outlives the fact that justified it.
 *
 * So this file pins the direction as a SET property, not by sampling:
 *
 *   1. Every name in the generator's roster is in the wall's roster, with the
 *      same arity. No generator-only name, and no arity disagreement on a name
 *      both list. A name the wall never heard of is exactly the shape that
 *      prices a still-denied command as an authorized relaxation.
 *   2. Every name in the generator's roster is one the LIVE wall does not deny
 *      in a root search — the direction the whole gate rests on, checked
 *      against `findDangerousPattern` rather than against a second copy of the
 *      map. This is the assertion that fails on the superseded draft.
 *   3. The gate reads the other way too: a predicate the generator does not
 *      name, however read-only it looks, is priced `open`. `-larger` and
 *      `-smaller` are the planted falsifiers — BSD extensions that GNU
 *      findutils 4.10 does not accept at all, and that the wall therefore
 *      denies. They are the two names a too-loose roster actually contained,
 *      and they stand here as the standing proof that an unrostered predicate
 *      withholds the licence.
 *
 * The rosters are read out of the two source files rather than imported: both
 * are module-private by design (`READ_ONLY_EXPRESSION_TOKENS` is a script
 * constant, `READ_ONLY_FIND_PREDICATES` is deliberately not on the wall's
 * export list), and extracting the literal text keeps this file from becoming
 * another import path through which the two could be compared to themselves.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findDangerousPattern } from "../../../src/harness/permission/hard-walls.js";
import {
  classifyPattern,
  type Oracle,
} from "../../../scripts/stage2-floor-differential-generate.ts";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);

const WALL_SOURCE = join(repoRoot, "src", "harness", "permission", "hard-walls.ts");
const GENERATOR_SOURCE = join(
  repoRoot,
  "scripts",
  "stage2-floor-differential-generate.ts"
);

/** The `root-find-walk` hit the pre-state wall gave a root `find`. */
const ROOT_FIND_BASE = { id: "root-find-walk", pattern: "find" } as const;

/**
 * The `["-name", 1]` pairs of one roster literal, in source order. A name
 * spelled outside that shape is not read, so a roster rewritten into another
 * form fails here loudly instead of being silently scored as empty.
 */
function rosterLiterals(source: string, constName: string): Map<string, number> {
  const decl = source.indexOf(`const ${constName}`);
  expect(decl, `${constName} must still be a named const`).toBeGreaterThan(-1);
  const open = source.indexOf("new Map([", decl);
  expect(open, `${constName} must still be a Map literal`).toBeGreaterThan(-1);
  const close = source.indexOf("]);", open);
  expect(close, `${constName}'s literal must still be closed`).toBeGreaterThan(-1);
  const body = source.slice(open + "new Map([".length, close);
  const roster = new Map<string, number>();
  for (const match of body.matchAll(/\["(-[^"]+)",\s*(\d)\]/g)) {
    roster.set(match[1] as string, Number(match[2]));
  }
  return roster;
}

const wallRoster = rosterLiterals(
  readFileSync(WALL_SOURCE, "utf8"),
  "READ_ONLY_FIND_PREDICATES"
);
const generatorRoster = rosterLiterals(
  readFileSync(GENERATOR_SOURCE, "utf8"),
  "READ_ONLY_EXPRESSION_TOKENS"
);

/** A `find` root search whose whole expression is the one predicate. */
function rootSearchOf(name: string, arity: number): string {
  return arity === 0 ? `find / ${name} -print` : `find / ${name} x -print`;
}

describe("the generator's read-only roster cannot be looser than the wall's", () => {
  it("reads both rosters, so a rewritten literal fails rather than scoring empty", () => {
    // A set comparison over an empty set passes, which would make assertions
    // (1) and (2) below vacuous. Pin the shape they operate on first.
    expect(wallRoster.size).toBeGreaterThan(40);
    expect(generatorRoster.size).toBeGreaterThan(40);
  });

  it("carries no name the wall's roster does not, and agrees on every arity", () => {
    const generatorOnly: string[] = [];
    const arityMismatches: string[] = [];
    for (const [name, arity] of generatorRoster) {
      const wallArity = wallRoster.get(name);
      if (wallArity === undefined) generatorOnly.push(name);
      else if (wallArity !== arity) {
        arityMismatches.push(`${name}: generator ${arity} vs wall ${wallArity}`);
      }
    }
    expect(
      generatorOnly,
      "the generator prices a predicate the wall still denies as class 4; drop it, or widen the wall deliberately and re-run the wall's own roster test"
    ).toEqual([]);
    expect(
      arityMismatches,
      "a predicate's arity decides whether its value is consumed or read as another predicate; the two readers must agree"
    ).toEqual([]);
  });

  it("names nothing the live wall denies in a root search", () => {
    // The direction, against production code rather than a second copy of the
    // map: for every name the generator would call read-only, the wall must
    // actually let the command through. A single disagreement is enough — this
    // is the assertion the two BSD extensions failed.
    const deniedByWall: string[] = [];
    for (const [name, arity] of generatorRoster) {
      if (findDangerousPattern(rootSearchOf(name, arity)) !== null) {
        deniedByWall.push(name);
      }
    }
    expect(
      deniedByWall,
      "the generator would license these as class-4 relaxations while the wall still denies them"
    ).toEqual([]);
  });

  it("withholds class 4 from a predicate its roster does not name", () => {
    // The planted falsifiers. `-larger` / `-smaller` are BSD extensions GNU
    // findutils 4.10 does not accept ("Unknown argument"), so there is no
    // command for the wall to read as read-only traversal and the deny stands;
    // the generator must reach the same answer without asking the wall.
    const oracle: Oracle = {
      pattern: () => ROOT_FIND_BASE,
      sensitive: () => false,
    };
    for (const name of ["-larger", "-smaller"]) {
      const command = `find / ${name} 1M -print`;
      expect(findDangerousPattern(command), command).not.toBeNull();
      const priced = classifyPattern(command, ROOT_FIND_BASE, null, oracle);
      expect(priced.label, command).toBe("open");
      expect(priced.class, command).toBeUndefined();
    }
  });
});
