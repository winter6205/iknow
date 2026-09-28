/**
 * T2 — name-pattern materialization (specs/effect-boundary-protection.md
 * "Name patterns: materialization at each fence assembly", issue #1155).
 *
 * A name rule (`*.pem`, `id_rsa`, `.env*`, ...) has no bind path, so before
 * this layer the roster's suffix/basename arms classified membership and
 * protected NOTHING at the kernel layer. Materialization resolves them to the
 * concrete matches present under the declared root AT ONE ASSEMBLY and turns
 * each match that has no ancestor coverage into a real physical target.
 *
 * Covered here:
 *   - home-scope resolution: matches under the inventory's home materialize,
 *     a same-named file outside it does not (external protection is an
 *     explicit concrete target's job);
 *   - membership is not coverage, in BOTH directions: `~/.ssh/id_rsa` is a
 *     legitimate member whose protection comes from the `.ssh` ancestor
 *     subtree and gains no bind of its own, while `~/project/server.pem` with
 *     no covering ancestor DOES get one;
 *   - the six typed fail-closed classes: traversal error, symlink cycle,
 *     symlink escape, disappearance, replacement/TOCTOU, and
 *     depth/entry limit exhaustion — each a `ToolExecutionError` naming the
 *     class, never a crash and never a silently weaker fence;
 *   - a later-created file is covered at the NEXT assembly, not grandfathered.
 *
 * Fixture discipline: every home is an mkdtemp scratch root created per case;
 * the operator's real home, `~/.ssh`, `~/.aws`, `~/.gnupg` and every real
 * credential are never read, written, or copied, and no fixture value is a
 * real credential.
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import {
  assertMaterializedTargetsUnchanged,
  createProtectedTargetInventory,
  materializeProtectedTargets,
} from "../../../src/harness/sandbox/protected-targets.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

const scratch: string[] = [];
function scratchHome(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return home;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function inventoryOf(home: string) {
  return createProtectedTargetInventory({ home, scanRoot: home });
}

function targetPaths(home: string): string[] {
  return materializeProtectedTargets(inventoryOf(home)).targets.map((t) => t.path);
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

describe("materialization — a present home name match becomes a physical target", () => {
  it("materializes one match per pattern shape under the inventory home", () => {
    const home = scratchHome("t2-mat-home-");
    mkdirSync(join(home, "certs"), { recursive: true });
    mkdirSync(join(home, "secrets"), { recursive: true });
    writeFileSync(join(home, "certs", "server.pem"), "fixture\n");
    writeFileSync(join(home, "secrets", "tls.key"), "fixture\n");
    writeFileSync(join(home, "bundle.p12"), "fixture\n");
    writeFileSync(join(home, ".env"), "fixture\n");
    writeFileSync(join(home, ".env.production"), "fixture\n");

    const result = materializeProtectedTargets(inventoryOf(home));
    const byPath = new Map(result.targets.map((t) => [t.path, t.targetClass]));
    assert.equal(byPath.get(join(home, "certs", "server.pem")), "tls_key_material");
    assert.equal(byPath.get(join(home, "secrets", "tls.key")), "tls_key_material");
    assert.equal(byPath.get(join(home, "bundle.p12")), "tls_key_material");
    assert.equal(byPath.get(join(home, ".env")), "dotenv_file");
    assert.equal(byPath.get(join(home, ".env.production")), "dotenv_file");
  });

  it("scopes to the inventory's resolved home, not to a same-named path outside it", () => {
    const root = mkdtempSync(join(tmpdir(), "t2-mat-scope-"));
    scratch.push(root);
    const home = join(root, "home");
    const outside = join(root, "outside");
    mkdirSync(home, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(home, "inside.pem"), "fixture\n");
    writeFileSync(join(outside, "outside.pem"), "fixture\n");

    const paths = targetPaths(home);
    assert.deepEqual(paths, [join(home, "inside.pem")]);
    // A protected location outside home needs an explicit concrete target;
    // the pattern arm never reaches across the root on its own.
    assert.ok(!paths.some((p) => p.startsWith(outside)));
  });

  it("honors an explicit external concrete target exactly as before", () => {
    const root = mkdtempSync(join(tmpdir(), "t2-mat-external-"));
    scratch.push(root);
    const home = join(root, "home");
    const external = join(root, "operator", "secrets");
    mkdirSync(home, { recursive: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "backup.pem"), "fixture\n");
    writeFileSync(join(home, "local.pem"), "fixture\n");

    const inventory = createProtectedTargetInventory({
      home,
      scanRoot: home,
      extraTargets: [
        { targetClass: "operator_backup", arm: "credential", path: external },
      ],
    });
    const result = materializeProtectedTargets(inventory);
    // The external subtree is bound as a concrete entry in its own right, and
    // the name arms never reach across the home root to it — so the only
    // materialized target is the in-scope match.
    assert.deepEqual(result.targets.map((t) => t.path), [join(home, "local.pem")]);
    assert.deepEqual(result.coveredByAncestor, []);
    assert.ok(
      inventory.isProtected(join(external, "backup.pem")),
      "the explicit concrete target keeps covering its subtree"
    );
  });

  it("covers a file created after the previous assembly at the next one", () => {
    const home = scratchHome("t2-mat-next-");
    assert.deepEqual(targetPaths(home), [], "zero matches on a bare home");

    const late = join(home, "late.pem");
    writeFileSync(late, "fixture\n");
    assert.deepEqual(targetPaths(home), [late]);
  });
});

describe("materialization — membership is not coverage (both directions)", () => {
  it("a match already behind an ancestor subtree gets no bind of its own", () => {
    const home = scratchHome("t2-mat-ancestor-");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_rsa"), "fixture\n");

    const result = materializeProtectedTargets(inventoryOf(home));
    // `~/.ssh/id_rsa` IS a member of the id_rsa name arm …
    assert.ok(
      inventoryOf(home).isProtected(join(home, ".ssh", "id_rsa")),
      "membership is a classification and still holds"
    );
    // … but its physical protection is the `.ssh` ancestor's read-only
    // subtree, so materialization adds no bind and does not count it twice.
    assert.deepEqual(result.targets, []);
    assert.deepEqual(result.coveredByAncestor.map((t) => t.path), [
      join(home, ".ssh", "id_rsa"),
    ]);
  });

  it("a match with no covering ancestor does get real physical protection", () => {
    const home = scratchHome("t2-mat-no-ancestor-");
    mkdirSync(join(home, "project"), { recursive: true });
    const match = join(home, "project", "server.pem");
    writeFileSync(match, "fixture\n");
    writeFileSync(join(home, "project", "notes.txt"), "fixture\n");

    assert.deepEqual(targetPaths(home), [match]);
    // And the sibling is untouched: protection is scoped to the match, not the
    // directory it happens to sit in.
    const classes = new Set(
      materializeProtectedTargets(inventoryOf(home)).targets.map((t) => t.targetClass)
    );
    assert.ok(classes.has("tls_key_material"));
  });
});

describe("materialization — typed fail-closed outcomes", () => {
  it("refuses on a traversal error rather than protecting only what it reached", () => {
    const home = scratchHome("t2-mat-eacces-");
    const locked = join(home, "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "hidden.pem"), "fixture\n");
    writeFileSync(join(home, "visible.pem"), "fixture\n");
    chmodSync(locked, 0o000);
    try {
      assert.throws(
        () => readdirSync(locked),
        (error: unknown) => errorCodeOf(error) === "EACCES",
        "precondition: the subtree really is unreadable (root bypasses mode bits)"
      );
      assert.throws(
        () => materializeProtectedTargets(inventoryOf(home)),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /materialization.*could not enumerate/.test(String(error)),
        "an unenumerable subtree is a typed refusal, not a partial enumeration"
      );
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("refuses a symlink that resolves outside the declared root", () => {
    const root = mkdtempSync(join(tmpdir(), "t2-mat-escape-"));
    scratch.push(root);
    const home = join(root, "home");
    const outside = join(root, "outside");
    mkdirSync(home, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "elsewhere.pem"), "fixture\n");
    symlinkSync(join(outside, "elsewhere.pem"), join(home, "linked.pem"));

    assert.throws(
      () => materializeProtectedTargets(inventoryOf(home)),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /materialization.*escapes the declared root/.test(String(error)),
      "an escaping match is a typed refusal, never clamped back inside"
    );
  });

  it("refuses a symlink cycle rather than cutting it off by a heuristic", () => {
    const home = scratchHome("t2-mat-cycle-");
    const a = join(home, "cycle-a.pem");
    const b = join(home, "cycle-b.pem");
    symlinkSync(b, a);
    symlinkSync(a, b);

    assert.throws(
      () => materializeProtectedTargets(inventoryOf(home)),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /materialization/.test(String(error)),
      "a cycle cannot be resolved to a bindable object: refuse"
    );
  });

  it("refuses at the identity re-check when a target vanishes after enumeration", () => {
    // This is `assertMaterializedTargetsUnchanged`'s refusal (fail-closed
    // class 5), NOT the warn-and-continue direction — the target was enumerated
    // and the caller was already told it is protected, so a later disappearance
    // is an unauthorized change to the bind plan. The warn direction is the
    // DISAPPEARANCE-BEFORE-BIND case, pinned separately below under its own
    // name.
    const home = scratchHome("t2-mat-vanished-");
    const match = join(home, "server.pem");
    writeFileSync(match, "fixture\n");
    const sibling = join(home, "other.key");
    writeFileSync(sibling, "fixture\n");

    const inventory = inventoryOf(home);
    const result = materializeProtectedTargets(inventory);
    assert.deepEqual(result.targets.map((t) => t.path).sort(), [match, sibling].sort());

    rmSync(match);
    assert.throws(
      () => assertMaterializedTargetsUnchanged(result),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /replaced or vanished between enumeration and bind/.test(String(error))
    );
  });

  it("reports a match that disappeared BEFORE the bind as a typed vanished warning, and every sibling still binds", () => {
    // The warn-and-continue direction (fail-closed class 4). A broken symlink
    // is the deterministic reproduction of the race: the directory walk
    // enumerates it as a `*.pem` match, then `realpathSync` raises ENOENT
    // because its target is gone. That ENOENT arm used to `continue` one line
    // above the `vanished` push, so the array was unreachable and the typed
    // warning could never fire.
    const home = scratchHome("t2-mat-gone-");
    const sibling = join(home, "sibling.pem");
    writeFileSync(sibling, "fixture\n");
    symlinkSync(join(home, "gone-target.pem"), join(home, "broken.pem"));

    const result = materializeProtectedTargets(inventoryOf(home));
    assert.deepEqual(
      result.vanished.map((t) => t.path),
      [join(home, "broken.pem")],
      "the disappearance is reported, never silently dropped"
    );
    assert.deepEqual(
      result.targets.map((t) => t.path),
      [sibling],
      "every present sibling still becomes an effective physical target"
    );
    assert.deepEqual(result.identities.length, result.targets.length);
    // Absent means no bytes to protect, so this is a warn — NOT a refusal.
    assert.doesNotThrow(() => assertMaterializedTargetsUnchanged(result));
  });

  it("refuses a bind source swapped for a different object (TOCTOU)", () => {
    const home = scratchHome("t2-mat-toctou-");
    const match = join(home, "server.pem");
    const replacement = join(home, "replacement.tmp");
    writeFileSync(match, "fixture\n");
    writeFileSync(replacement, "fixture\n");

    const result = materializeProtectedTargets(inventoryOf(home));
    assert.equal(result.targets.length, 1);

    // Same path, different object: a pathname that merely spells correctly is
    // not what protection is scoped to.
    rmSync(match);
    renameSync(replacement, match);
    assert.throws(
      () => assertMaterializedTargetsUnchanged(result),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /replaced or vanished between enumeration and bind/.test(String(error))
    );
  });

  it("refuses when the enumeration bound is exhausted, emitting nothing for the rest", () => {
    const home = scratchHome("t2-mat-limit-");
    mkdirSync(join(home, "many"), { recursive: true });
    for (let i = 0; i < 20; i += 1) {
      writeFileSync(join(home, "many", `f${i}.pem`), "fixture\n");
    }
    assert.equal(
      materializeProtectedTargets(inventoryOf(home)).targets.length,
      20,
      "the same tree materializes under the production bound"
    );

    assert.throws(
      () =>
        materializeProtectedTargets(inventoryOf(home), {
          maxWalkDepth: 64,
          maxEntries: 5,
        }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /materialization exceeded the enumeration bound of 5 entries/.test(
          String(error)
        ),
      "limit exhaustion is a typed refusal naming the limit"
    );
  });

  it("refuses when the walk-depth bound is exhausted", () => {
    const home = scratchHome("t2-mat-depth-");
    let dir = home;
    for (let i = 0; i < 6; i += 1) {
      dir = join(dir, `d${i}`);
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(dir, "deep.pem"), "fixture\n");

    assert.throws(
      () =>
        materializeProtectedTargets(inventoryOf(home), {
          maxWalkDepth: 2,
          maxEntries: 100_000,
        }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /materialization exceeded the walk-depth bound of 2/.test(String(error))
    );
  });
});
