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
  isPlaceholder,
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

describe("placeholder identity values", () => {
  it("treats the historical machine-specific literals as placeholders", () => {
    for (const value of [
      "/home/winner/eval-1189/dataset",
      "/home/winner/eval-1212/prov/node.tar.gz",
      "/home/winner/.iknow/settings.json",
      "",
      "   ",
    ]) {
      assert.ok(
        isPlaceholder(value),
        `expected ${JSON.stringify(value)} to be recognized as a placeholder`
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
