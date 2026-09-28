import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createProtectedTargetInventory,
  type ProtectedTargetEntry,
} from "../../../src/harness/sandbox/protected-targets.js";
import {
  commandContainsSensitivePath,
  hardWalls,
} from "../../../src/harness/permission/hard-walls.js";

// The fence's resolved-path roster (protected-targets.ts seeds) and the hard
// wall's command-text roster (hard-walls.ts SENSITIVE_PATH_FRAGMENTS) are two
// hand-maintained lists. protected-targets.test.ts pins fragment -> seed; this
// file pins the reverse completeness direction, which is the one that carries
// the escalation risk: a seed mounted read-only by the fence but not
// text-guarded by the hard wall is a write the hard wall stops refusing
// pre-execution, with no other test failing.
//
// Seeds are read from the production inventory rather than restated here, so
// adding a seed enrolls it in this check automatically. Fixture home is
// mkdtemp-only; no operator home, credential, or system file is read or written.

const HOME = mkdtempSync(join(tmpdir(), "protected-target-parity-home-"));

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

const sensitivePathWall = hardWalls().find(
  (rule) => rule.id === "hard-wall:sensitive-path"
);
assert.ok(sensitivePathWall, "hard-wall:sensitive-path must exist");
const sensitivePathRule: NonNullable<typeof sensitivePathWall> =
  sensitivePathWall;

function deniedByHardWall(path: string): boolean {
  return sensitivePathRule.match({ tool: "write", input: { path } });
}

/**
 * The path the fence's write block would actually be asked about for one seed:
 * a file inside a subtree (a backup target is a file, never the directory
 * itself), the path itself for an exact seed, and a name that satisfies the
 * seed's own pattern for a name family. Derived from the production rule so a
 * new seed shape cannot silently produce an empty representative list.
 */
function writeTargetRepresentative(entry: ProtectedTargetEntry): string {
  const rule = entry.rule;
  switch (rule.kind) {
    case "subtree":
      return join(rule.path, "agent-backup.tar");
    case "exact":
      return rule.path;
    case "name": {
      const basename =
        rule.pattern.shape === "basename"
          ? rule.pattern.basename
          : rule.pattern.shape === "stem"
            ? rule.pattern.stem
            : `agent-backup${rule.pattern.extension}`;
      return join(rule.root, basename);
    }
  }
}

/** Stable, human-checkable identity for a seed, used by the exemption map. */
function seedKey(entry: ProtectedTargetEntry): string {
  return `${entry.targetClass}:${entry.rule.kind}:${
    entry.rule.kind === "name"
      ? JSON.stringify(entry.rule.pattern)
      : entry.rule.path
  }`;
}

/**
 * Seeds the fence protects with no hard-wall fragment behind them. Each entry
 * is a deliberate scope decision, not an oversight: an unlisted seed fails the
 * parity test, so removing a seed or granting it a fragment forces this map to
 * be reconciled rather than left to rot.
 */
const FRAGMENT_LESS_SEEDS = new Map<string, string>([
  [
    "system_readonly_tree:subtree:/etc",
    "system tree: bwrap re-binds /etc read-only unconditionally (baseArgs, both fs-isolation modes), so a write never lands; the two identity files under it that carry credential value (/etc/passwd, /etc/shadow) are separate exact seeds and ARE text-guarded",
  ],
  [
    "system_readonly_tree:subtree:/usr",
    "system tree: unconditionally ro-bound by baseArgs; the roster's text arms are credential-shaped, not a per-binary allowlist",
  ],
  [
    "system_readonly_tree:subtree:/bin",
    "system tree: unconditionally ro-bound by baseArgs",
  ],
  [
    "system_readonly_tree:subtree:/lib",
    "system tree: unconditionally ro-bound by baseArgs",
  ],
  [
    "system_readonly_tree:subtree:/lib64",
    "system tree: unconditionally ro-bound by baseArgs",
  ],
  [
    "system_readonly_tree:subtree:/opt",
    "system tree: optional host ro-prefix, ro-bound when present; absent hosts never mount it",
  ],
  [
    "system_readonly_tree:subtree:/snap",
    "system tree: optional host ro-prefix, ro-bound when present; absent hosts never mount it",
  ],
]);

/**
 * The parity rule as one pure function so the negative test exercises the very
 * same check the positive test does, rather than a restatement of it.
 * Returns one message per unbacked seed.
 */
function parityFailures(
  entries: readonly ProtectedTargetEntry[],
  exemptions: ReadonlyMap<string, string>
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const key = seedKey(entry);
    if (exemptions.has(key)) continue;
    const target = writeTargetRepresentative(entry);
    if (!deniedByHardWall(target)) {
      out.push(
        `${key} — fence protects ${target} but hard-wall:sensitive-path does not deny it; add a SENSITIVE_PATH_FRAGMENTS arm or a justified exemption`
      );
    }
  }
  return out;
}

const inventory = createProtectedTargetInventory({ home: HOME, scanRoot: HOME });

describe("roster parity — every fence seed has a hard-wall fragment behind it", () => {
  it("finds no fence seed whose write the hard wall would not refuse", () => {
    const failures = parityFailures(inventory.entries, FRAGMENT_LESS_SEEDS);
    assert.deepEqual(
      failures,
      [],
      `fence seeds with no hard-wall fragment:\n${failures.join("\n")}`
    );
  });

  it("covers every seed shape the fence can hold, so a new shape cannot skip the check", () => {
    const kinds = new Set(inventory.entries.map((e) => e.rule.kind));
    assert.deepEqual(
      [...kinds].sort(),
      ["exact", "name", "subtree"],
      "the seed roster must exercise every rule shape this check reasons about"
    );
    for (const entry of inventory.entries) {
      assert.notEqual(
        writeTargetRepresentative(entry).trim(),
        "",
        `${seedKey(entry)} produced a blank write-target representative`
      );
    }
  });

  it("keeps the command-text arm in agreement with the path-bearing arm", () => {
    // The fence protects resolved paths, so the path-bearing predicate is the
    // authority above; the execute-tool arm runs the same roster over command
    // text and is the one a `cp x >> ~/.ssh/id_rsa` redirect goes through.
    // Divergence between the two consumers is a silent re-opening too.
    const unbacked = inventory.entries.filter(
      (entry) =>
        !FRAGMENT_LESS_SEEDS.has(seedKey(entry)) &&
        !commandContainsSensitivePath(
          `cp /tmp/a ${writeTargetRepresentative(entry)}`
        )
    );
    assert.deepEqual(
      unbacked.map(seedKey),
      [],
      "command-text arm refuses a redirect the path-bearing arm refuses"
    );
  });

  it("rejects a seed with no fragment, proving the parity rule can fail", () => {
    // Negative self-check of parityFailures itself: a synthetic seed shaped
    // exactly like a real credential subtree but absent from both rosters.
    // If this ever passes, the positive test above proves nothing.
    const synthetic = createProtectedTargetInventory({
      home: HOME,
      scanRoot: HOME,
      extraTargets: [
        {
          path: join(HOME, ".azure"),
          targetClass: "cloud_credential",
          arm: "credential",
        },
      ],
    });
    const realFailures = parityFailures(inventory.entries, FRAGMENT_LESS_SEEDS);
    assert.deepEqual(realFailures, [], "fixture: real roster is clean");

    const syntheticFailures = parityFailures(
      synthetic.entries,
      FRAGMENT_LESS_SEEDS
    );
    assert.ok(
      syntheticFailures.length > 0,
      "a seed absent from SENSITIVE_PATH_FRAGMENTS must be reported"
    );
    assert.ok(
      syntheticFailures.some((f) => f.includes(".azure")),
      `the report must name the offending seed, got: ${syntheticFailures.join("; ")}`
    );
    assert.equal(
      deniedByHardWall(join(HOME, ".azure", "agent-backup.tar")),
      false,
      "fixture sanity: the synthetic seed genuinely has no fragment behind it"
    );
  });
});

describe("roster parity — the exemption map stays honest", () => {
  it("names every exemption in this file's seed set — no orphan entries", () => {
    const live = new Set(inventory.entries.map(seedKey));
    const orphans = [...FRAGMENT_LESS_SEEDS.keys()].filter((k) => !live.has(k));
    assert.deepEqual(
      orphans,
      [],
      `exemptions for seeds that no longer exist (remove or re-reconcile): ${orphans.join(", ")}`
    );
  });

  it("carries a non-empty justification for every exemption", () => {
    for (const [key, reason] of FRAGMENT_LESS_SEEDS) {
      assert.ok(
        reason.trim().length > 20,
        `exemption ${key} must state why it is safe, not just that it exists`
      );
    }
  });

  it("refuses to keep an exemption for a seed that has since gained a fragment", () => {
    // An exemption is a record of an absence; once the fragment lands, the
    // exemption must be deleted so the seed is guarded by the rule, not by a
    // stale waiver that would also mask a future regression.
    const accidentallyCovered = [...FRAGMENT_LESS_SEEDS.entries()].filter(
      ([key]) => {
        const entry = inventory.entries.find((e) => seedKey(e) === key);
        return (
          entry !== undefined &&
          deniedByHardWall(writeTargetRepresentative(entry))
        );
      }
    );
    assert.deepEqual(
      accidentallyCovered.map(([key]) => key),
      [],
      "these exemptions are now covered by a fragment; delete them"
    );
  });
});
