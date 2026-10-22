/**
 * Run-identity binding and staleness comparison (issue 1219 requirement 1).
 *
 * Why this matters: the superseded #1212 `preflight.env` / `wiring.env` records carried
 * no run identity at all, so a stale `EXCLUDE:oracle-or-grader` record was indistinguishable
 * from a fresh one and was silently chosen over the newer successful retry. These tests
 * pin the fix: a record is bound to an explicit identity, and any mismatched field
 * REJECTS the record regardless of its verdict string.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  compareIdentities,
  findPlaceholderFields,
  HISTORICAL_DEFAULT_LITERALS,
  IDENTITY_FIELDS,
  isInheritedDefaultLiteral,
  isPlaceholder,
  isUnresolvedPathTemplate,
  type RunIdentity,
} from "../../../../scripts/eval/terminal-bench-2.1/identities.ts";
import { identityFor, PASSING_GRADER_LOG } from "./fixtures.ts";

/** A preflight record is identity + measurement + verdict; the verdict is a field. */
interface GateRecord {
  identity: RunIdentity;
  verdict: string;
}

function gateRecord(
  overrides: Partial<RunIdentity>,
  verdict = "OK:oracle-passes-grader"
): GateRecord {
  return { identity: identityFor(overrides), verdict };
}

describe("run identity binding", () => {
  it("accepts a record whose identity matches the manifest exactly", () => {
    const expected = identityFor();
    const comparison = compareIdentities(expected, gateRecord({}).identity);

    assert.deepEqual(
      comparison.mismatches,
      [],
      "expected no mismatched identity fields"
    );
    assert.equal(
      comparison.fresh,
      true,
      "an exact identity match must read as fresh"
    );
  });

  it("rejects an OK record when the dataset commit drifted", () => {
    const expected = identityFor();
    const stale = gateRecord({
      datasetCommit: "0000000000000000000000000000000000000000",
    });

    const comparison = compareIdentities(expected, stale.identity);

    assert.ok(
      comparison.mismatches.includes("datasetCommit"),
      `expected datasetCommit mismatch; got: ${JSON.stringify(comparison.mismatches)}`
    );
    assert.equal(
      comparison.fresh,
      false,
      "a drifted dataset commit must not read as fresh"
    );
    assert.equal(
      stale.verdict.startsWith("OK:"),
      true,
      "fixture precondition: the rejected record still carries an OK verdict string"
    );
  });

  it("rejects an OK record when the image digest drifted", () => {
    const comparison = compareIdentities(
      identityFor(),
      gateRecord({ imageDigest: "sha256:bbb222" }).identity
    );

    assert.ok(
      comparison.mismatches.includes("imageDigest"),
      `expected imageDigest mismatch; got: ${JSON.stringify(comparison.mismatches)}`
    );
    assert.equal(
      comparison.fresh,
      false,
      "a drifted image digest must not read as fresh"
    );
  });

  it("rejects an OK record when the bundle sha drifted", () => {
    const comparison = compareIdentities(
      identityFor(),
      gateRecord({ bundleSha256: "f".repeat(64) }).identity
    );

    assert.ok(
      comparison.mismatches.includes("bundleSha256"),
      `expected bundleSha256 mismatch; got: ${JSON.stringify(comparison.mismatches)}`
    );
    assert.equal(
      comparison.fresh,
      false,
      "a drifted bundle sha must not read as fresh"
    );
  });

  it("rejects an OK record when the node archive sha drifted", () => {
    const comparison = compareIdentities(
      identityFor(),
      gateRecord({ nodeArchiveSha256: "e".repeat(64) }).identity
    );

    assert.ok(
      comparison.mismatches.includes("nodeArchiveSha256"),
      `expected nodeArchiveSha256 mismatch; got: ${JSON.stringify(comparison.mismatches)}`
    );
  });

  it("rejects a record produced by a different run id", () => {
    const comparison = compareIdentities(
      identityFor(),
      gateRecord({ runId: "run-1212" }).identity
    );

    assert.ok(
      comparison.mismatches.includes("runId"),
      `expected runId mismatch; got: ${JSON.stringify(comparison.mismatches)}`
    );
  });

  it("reports every mismatched field at once rather than only the first", () => {
    const comparison = compareIdentities(
      identityFor(),
      identityFor({
        datasetCommit: "a".repeat(40),
        imageDigest: "sha256:ccc333",
      })
    );

    assert.deepEqual(
      [...comparison.mismatches].sort(),
      ["datasetCommit", "imageDigest"],
      `expected both drifted fields; got: ${JSON.stringify(comparison.mismatches)}`
    );
  });

  it("treats a record missing an identity field as stale, not as a match", () => {
    const partial = {
      ...identityFor(),
      bundleSha256: undefined,
    } as unknown as RunIdentity;

    const comparison = compareIdentities(identityFor(), partial);

    assert.ok(
      comparison.mismatches.includes("bundleSha256"),
      `expected absent bundleSha256 to count as a mismatch; got: ${JSON.stringify(comparison.mismatches)}`
    );
    assert.equal(
      comparison.fresh,
      false,
      "an absent identity field must not read as fresh"
    );
  });
});

/**
 * The four literals the #1212 scripts hardcoded. They are REAL, EXISTING artifacts on the
 * evaluation host, and `cli.ts` makes each one a MANDATORY explicit flag — so equality with
 * one of them is not evidence that anything was left unset.
 */
const FROZEN_LITERALS: ReadonlyArray<string> = [
  "/home/winner/eval-1189/dataset",
  "/home/winner/eval-1189/bundle/iknow-bundle-9fa88f57.tgz",
  "/home/winner/eval-1212/prov/node.tar.gz",
  "/home/winner/.iknow/settings.json",
];

/**
 * Every substitution or marker form `isPlaceholder` defines as unresolved. Each one is a
 * template nothing in this pipeline expands, so it can only ever have reached the runner as
 * literal garbage.
 */
const UNRESOLVED_TEMPLATES: ReadonlyArray<readonly [string, string]> = [
  ["braced shell variable", "/srv/eval/${DATASET_ROOT}"],
  ["bare shell variable", "/srv/eval/$DATASET_ROOT/dataset"],
  ["shell variable mid-path", "/srv/eval/node$ARCH.tar.gz"],
  ["mustache slot", "/srv/eval/{{datasetRoot}}/tasks"],
  ["handlebars slot with a dash", "/srv/eval/{{bundle-path}}.tgz"],
  ["TODO segment", "/srv/eval/TODO/dataset"],
  ["FIXME segment", "/srv/eval/FIXME/bundle.tgz"],
  ["CHANGEME segment", "/srv/eval/CHANGEME"],
  ["TBD segment", "/srv/eval/runs/TBD"],
  ["XXX segment", "/srv/eval/XXX/settings.json"],
];

/** The frozen #1221 protocol's own `outputLayout`: a LAYOUT TEMPLATE, not a path. */
const FROZEN_OUTPUT_LAYOUT = "tb2.1-slot-v1/<task>:<arm>:<maxTurns>";

describe("placeholder identity values", () => {
  // CONVERTED (issue 1219). The replaced test asserted the four historical literals were
  // placeholders and therefore that an explicitly supplied artifact could never resolve.
  // That made the CLI unusable: `cli.ts` REQUIRES these four values as flags and calls
  // `resolveConfig` before the run root, Docker wiring or any dispatch, so the frozen
  // #1221 run could only ever exit 1 with four "still a placeholder" lines.
  // Replaced by the opposite contract, which is strictly stronger: the literal must be
  // ACCEPTED, and every genuinely unresolved template must still be REFUSED.
  it("accepts the historical machine-specific literals as explicit real values", () => {
    for (const value of FROZEN_LITERALS) {
      assert.equal(
        isPlaceholder(value),
        false,
        `issue 1219: ${JSON.stringify(value)} is an explicitly supplied, existing artifact ` +
          "and must not be refused merely for matching a historical default literal"
      );
    }
  });

  it("still refuses an absent, blank, whitespace-only or non-string value", () => {
    for (const value of [undefined, null, 42, {}, [], "", "   ", "\t\n "]) {
      assert.ok(
        isPlaceholder(value),
        `expected ${JSON.stringify(value) ?? "undefined"} to be refused as a placeholder`
      );
    }
  });

  it("refuses every unresolved-template form the definition names", () => {
    for (const [label, value] of UNRESOLVED_TEMPLATES) {
      assert.ok(
        isPlaceholder(value),
        `expected the ${label} form to be refused; got accepted: ${JSON.stringify(value)}`
      );
    }
  });

  it("does not treat a real explicit path as a placeholder", () => {
    assert.equal(
      isPlaceholder("/srv/eval/dataset"),
      false,
      "an explicit path is a real value"
    );
    assert.equal(
      isPlaceholder("7131e4375048a0e408a8fb404b5f499d726b695b"),
      false,
      "a commit sha is real"
    );
  });

  it("does not treat a path merely containing the letters of a marker as a template", () => {
    // The control for the segment rule: matching is on a WHOLE segment, so a real
    // directory named after the plural is not mistaken for a `TODO` marker.
    for (const value of [
      "/srv/eval/todos/dataset",
      "/srv/eval/tbdx/bundle.tgz",
      "/srv/eval/fixmes",
      "/srv/eval/xxx.tar.gz",
    ]) {
      assert.equal(
        isPlaceholder(value),
        false,
        `${JSON.stringify(value)} is a real path, not a marker segment`
      );
    }
  });

  it("accepts the frozen #1221 outputLayout template as an identity value", () => {
    // Requirement 5: identity fields must not be broken by the placeholder contract. The
    // frozen protocol manifest carries a layout TEMPLATE with angle brackets, which is why
    // angle brackets are a PATH rule (`isUnresolvedPathTemplate`) and not an identity one.
    assert.equal(
      isPlaceholder(FROZEN_OUTPUT_LAYOUT),
      false,
      "an outputLayout layout template is a real, frozen identity value"
    );
    assert.deepEqual(
      findPlaceholderFields(
        identityFor({ outputLayout: FROZEN_OUTPUT_LAYOUT })
      ),
      [],
      "no field of the frozen #1221 identity may read as a placeholder"
    );
  });

  it("keeps historical-default detection separate from placeholder validity", () => {
    // Requirement 4: the distinction is represented explicitly and does NOT block config.
    assert.deepEqual(
      [...HISTORICAL_DEFAULT_LITERALS].sort(),
      [...FROZEN_LITERALS].sort(),
      "the diagnostic set must still name exactly the four #1189/#1212 defaults"
    );
    for (const value of FROZEN_LITERALS) {
      assert.equal(
        isInheritedDefaultLiteral(value),
        true,
        `${JSON.stringify(value)} must remain detectable as an inherited default`
      );
      assert.equal(
        isPlaceholder(value),
        false,
        "detecting an inherited default must not make the value a placeholder"
      );
    }
    assert.equal(
      isInheritedDefaultLiteral("/srv/eval-1219/dataset"),
      false,
      "an unrelated real path is not an inherited default"
    );
  });

  it("lists every placeholder field on a partly-defaulted identity", () => {
    const fields = findPlaceholderFields({
      ...identityFor(),
      bundleSha256: "",
      nodeArchiveSha256:
        "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    });

    assert.deepEqual(
      fields,
      ["bundleSha256"],
      `expected only bundleSha256; got: ${JSON.stringify(fields)}`
    );
  });

  // Requirement 5, explicit: every identity field must still refuse a blank value, and a
  // fully populated identity must refuse nothing. Driven off `IDENTITY_FIELDS` rather than
  // a hand-written list so a newly added field cannot escape this guarantee.
  for (const field of IDENTITY_FIELDS) {
    it(`still refuses a blank ${field} on an otherwise complete identity`, () => {
      const blanked = { ...identityFor(), [field]: "   " } as RunIdentity;

      assert.deepEqual(
        findPlaceholderFields(blanked),
        [field],
        `a whitespace-only ${field} must be listed, and nothing else`
      );

      const omitted = {
        ...identityFor(),
        [field]: undefined,
      } as unknown as RunIdentity;
      assert.deepEqual(
        findPlaceholderFields(omitted),
        [field],
        `an omitted ${field} must be listed, and nothing else`
      );
    });
  }

  it("accepts a fully populated identity with no placeholder field at all", () => {
    assert.deepEqual(
      findPlaceholderFields(identityFor()),
      [],
      "a complete identity must report nothing to fix"
    );
  });

  it("reports an unexpanded template field as a placeholder too", () => {
    assert.deepEqual(
      findPlaceholderFields(identityFor({ runId: "${RUN_ID}" })),
      ["runId"],
      "an unexpanded variable is exactly the placeholder this module exists to refuse"
    );
  });
});

describe("path templates are refused where a layout template is not", () => {
  it("refuses an angle-bracket placeholder in a path", () => {
    for (const value of [
      "<path>",
      "/srv/<dataset-root>",
      "/srv/eval/eval-1189/<bundle>.tgz",
      "/srv/eval/{{datasetRoot}}",
    ]) {
      assert.ok(
        isUnresolvedPathTemplate(value),
        `expected the path template ${JSON.stringify(value)} to be refused`
      );
    }
  });

  it("still refuses every non-string and blank path", () => {
    for (const value of [undefined, null, 7, "", "  "]) {
      assert.ok(
        isUnresolvedPathTemplate(value),
        `expected ${JSON.stringify(value) ?? "undefined"} to be refused as a path`
      );
    }
  });

  it("accepts a real path, including the four frozen literals", () => {
    for (const value of ["/srv/eval-1219/dataset", ...FROZEN_LITERALS]) {
      assert.equal(
        isUnresolvedPathTemplate(value),
        false,
        `${JSON.stringify(value)} is a real explicit path`
      );
    }
  });
});

describe("preflight record selection by explicit run identity", () => {
  // Selection lives in preflight.ts; the identity half is covered here so a reader can
  // see why a stale record is refused before the selection policy is even reached.
  it("keeps a stale record distinguishable from a fresh OK record for the same task", () => {
    const fresh = compareIdentities(identityFor(), identityFor());
    const stale = compareIdentities(
      identityFor(),
      identityFor({ datasetCommit: "b".repeat(40) })
    );

    assert.equal(fresh.fresh, true, "same-identity record is fresh");
    assert.equal(
      stale.fresh,
      false,
      "drifted record is stale despite the same task"
    );
  });
});

describe("fixture sanity", () => {
  it("keeps the passing grader log free of network-failure markers", () => {
    assert.match(
      PASSING_GRADER_LOG,
      /7 passed/,
      "fixture must carry a real result line"
    );
    assert.doesNotMatch(
      PASSING_GRADER_LOG,
      /Failed to connect|network timeout/,
      "fixture must not carry a network marker"
    );
  });
});
