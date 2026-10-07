/**
 * Configuration resolution: explicit parameters in, no machine defaults out.
 *
 * Why this matters (issue 1219 requirement 1): the #1212 scripts hardcoded
 * `/home/winner/eval-1189/dataset`, a specific bundle and node tarball, a
 * non-overridable `BUNDLE_GLIBCXX_FLOOR`, `AGENT_WALL=2700` and `GRADER_GRACE=600`, and
 * derived every path from `dirname(__file__)`. Nothing could be pointed at another
 * dataset, and a still-defaulted value silently read one operator's machine.
 *
 * Also required test 8 (half of it): empty and invalid manifest inputs must refuse, never
 * run silently.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

import {
  ConfigError,
  parseManifest,
  resolveConfig,
  slotKeyOf,
  validateConfigParams,
  validateManifest,
  type ConfigParams,
  type EvalManifest,
} from "../../../../scripts/eval/terminal-bench-2.1/config.ts";
import { cleanupTempRoots } from "./fixtures.ts";

afterAll(cleanupTempRoots);

function params(overrides: Partial<ConfigParams> = {}): ConfigParams {
  return {
    datasetRoot: "/srv/eval-1219/dataset",
    bundlePath: "/srv/eval-1219/bundle/iknow-bundle.tgz",
    nodeArchivePath: "/srv/eval-1219/prov/node.tar.gz",
    settingsPath: "/srv/eval-1219/settings.json",
    runRoot: "/srv/eval-1219/runs",
    agentWallSec: 2700,
    graderGraceSec: 600,
    bundleGlibcxxFloor: "GLIBCXX_3.4.31",
    tokenCeiling: { input: 4_000_000, output: 3_000_000 },
    ...overrides,
  };
}

function manifest(overrides: Partial<EvalManifest> = {}): EvalManifest {
  return {
    runId: "run-1219",
    datasetCommit: "7131e4375048a0e408a8fb404b5f499d726b695b",
    bundleSha256:
      "1525d540457b0cb5a68535890eb2960319fcb4a25126c62b51273954ac1b27e7",
    nodeArchiveSha256:
      "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    runnerVersion: "tb2.1-attempt/1",
    outputLayout: "trace/ logs/ process/ meta/",
    frozenBeforeAnyOutcome: true,
    slots: [
      {
        task: "db-wal-recovery",
        image: "python:3.11-slim",
        imageDigest: "sha256:aaa111",
        maxTurns: 40,
        arm: "pilot",
      },
    ],
    ...overrides,
  };
}

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...manifest(), ...overrides });
}

describe("explicit config parameters", () => {
  it("accepts a fully specified configuration", () => {
    assert.deepEqual(
      validateConfigParams(params()),
      [],
      "explicit params must validate"
    );
  });

  it("refuses the inherited machine-specific dataset default", () => {
    const problems = validateConfigParams(
      params({ datasetRoot: "/home/winner/eval-1189/dataset" })
    );

    assert.ok(
      problems.some((problem) => problem.includes("datasetRoot")),
      `expected a datasetRoot refusal; got: ${JSON.stringify(problems)}`
    );
  });

  it("refuses the inherited machine-specific node tarball default", () => {
    const problems = validateConfigParams(
      params({ nodeArchivePath: "/home/winner/eval-1212/prov/node.tar.gz" })
    );

    assert.ok(
      problems.some((problem) => problem.includes("nodeArchivePath")),
      `expected a nodeArchivePath refusal; got: ${JSON.stringify(problems)}`
    );
  });

  it("refuses an empty path rather than resolving to the process cwd", () => {
    const problems = validateConfigParams(params({ runRoot: "  " }));

    assert.ok(
      problems.some((problem) => problem.includes("runRoot")),
      `expected a runRoot refusal; got: ${JSON.stringify(problems)}`
    );
  });

  it("refuses a non-positive wall limit instead of defaulting it", () => {
    const problems = validateConfigParams(
      params({ agentWallSec: 0, graderGraceSec: -1 })
    );

    assert.equal(
      problems.length,
      2,
      `expected both limits refused; got: ${JSON.stringify(problems)}`
    );
  });

  it("refuses a bundle glibcxx floor that is not a ceiling value", () => {
    // #1212 hardcoded BUNDLE_GLIBCXX_FLOOR="3.4.31" with no way to override it at all.
    for (const floor of ["", "3.4.31", "GLIBCXX_x.y.z"]) {
      const problems = validateConfigParams(
        params({ bundleGlibcxxFloor: floor })
      );
      assert.ok(
        problems.some((problem) => problem.includes("bundleGlibcxxFloor")),
        `expected floor=${JSON.stringify(floor)} refused; got: ${JSON.stringify(problems)}`
      );
    }
  });

  it("accepts an explicitly provided bundle glibcxx floor", () => {
    assert.deepEqual(
      validateConfigParams(params({ bundleGlibcxxFloor: "GLIBCXX_3.4.30" })),
      [],
      "an explicit floor must be honoured rather than hardcoded"
    );
  });

  it("refuses a missing token ceiling", () => {
    const problems = validateConfigParams(
      params({
        tokenCeiling: undefined as unknown as ConfigParams["tokenCeiling"],
      })
    );

    assert.ok(
      problems.some((problem) => problem.includes("tokenCeiling")),
      `expected a tokenCeiling refusal; got: ${JSON.stringify(problems)}`
    );
  });
});

describe("manifest validation (required test 8)", () => {
  it("accepts a well-formed manifest", () => {
    assert.deepEqual(
      validateManifest(manifest()),
      [],
      "a complete manifest must validate"
    );
  });

  it("refuses a manifest with an empty slot list", () => {
    const problems = validateManifest(manifest({ slots: [] }));

    assert.ok(
      problems.some((problem) => problem.includes("slots")),
      `expected an empty-slots refusal; got: ${JSON.stringify(problems)}`
    );
  });

  it("refuses a manifest whose slots are not an array", () => {
    const problems = validateManifest({
      ...manifest(),
      slots: "db-wal-recovery",
    });

    assert.ok(
      problems.some((problem) => problem.includes("slots")),
      `expected a slots-shape refusal; got: ${JSON.stringify(problems)}`
    );
  });

  it("refuses a slot with a blank task name", () => {
    const problems = validateManifest(
      manifest({
        slots: [
          {
            task: "",
            image: "i",
            imageDigest: "d",
            maxTurns: 40,
            arm: "pilot",
          },
        ],
      })
    );

    assert.ok(
      problems.some((problem) => problem.includes("slots[0].task")),
      `expected a slot task refusal; got: ${JSON.stringify(problems)}`
    );
  });

  it("refuses a slot whose maxTurns is not a positive integer", () => {
    for (const maxTurns of [0, -40, 40.5]) {
      const problems = validateManifest(
        manifest({
          slots: [
            {
              task: "t",
              image: "i",
              imageDigest: "d",
              maxTurns: maxTurns as number,
              arm: "pilot",
            },
          ],
        })
      );
      assert.ok(
        problems.some((problem) => problem.includes("maxTurns")),
        `expected maxTurns=${String(maxTurns)} refused; got: ${JSON.stringify(problems)}`
      );
    }
  });

  it("refuses a manifest that was not frozen before any outcome existed", () => {
    const problems = validateManifest(
      manifest({ frozenBeforeAnyOutcome: false })
    );

    assert.ok(
      problems.some((problem) => problem.includes("frozenBeforeAnyOutcome")),
      `expected a freeze refusal; got: ${JSON.stringify(problems)}`
    );
  });

  it("refuses a manifest missing a pinned identity field", () => {
    const problems = validateManifest({ ...manifest(), bundleSha256: "" });

    assert.ok(
      problems.some((problem) => problem.includes("bundleSha256")),
      `expected a bundleSha256 refusal; got: ${JSON.stringify(problems)}`
    );
  });

  it("refuses a manifest that is not an object", () => {
    for (const value of [null, "run", 42]) {
      assert.deepEqual(
        validateManifest(value),
        ["manifest must be an object"],
        `expected ${JSON.stringify(value)} refused as a non-object`
      );
    }
  });

  it("throws ConfigError on malformed manifest JSON", () => {
    assert.throws(
      () => parseManifest("{ not json"),
      (error: unknown) => error instanceof ConfigError,
      "malformed JSON must throw ConfigError"
    );
  });

  it("names the parse failure in the ConfigError message", () => {
    assert.throws(
      () => parseManifest("{ not json"),
      /not valid JSON/,
      "the thrown error must say the manifest was not valid JSON"
    );
  });

  it("throws ConfigError listing every manifest problem", () => {
    assert.throws(
      () => parseManifest(manifestJson({ slots: [], runId: "" })),
      /manifest\.runId[\s\S]*manifest\.slots/,
      "the thrown error must list both problems"
    );
  });

  it("parses a valid manifest document", () => {
    const parsed = parseManifest(manifestJson());

    assert.equal(
      parsed.slots.length,
      1,
      "a valid manifest must parse its slot list"
    );
  });
});

describe("manifest slot fields are path segments, never path expressions", () => {
  /**
   * `task` and `arm` are joined into real paths: `taskDir` is
   * `join(datasetRoot, "tasks", slot.task)` and the attempt directory is
   * `join(runRoot, slot.slotKey)` where `slotKeyOf` builds `task:arm:maxTurns`. A
   * `../..` in either one escapes the run root and then becomes a bind-mount source.
   */
  const REJECTED: ReadonlyArray<readonly [string, string]> = [
    ["traversal", "../../../../tmp/escaped"],
    ["bare parent reference", ".."],
    ["absolute path", "/etc/passwd"],
    ["backslash separator", "..\\escaped"],
    ["colon-bearing", "db-wal:recovery"],
    ["leading dash", "-rf"],
  ];

  for (const [label, task] of REJECTED) {
    it(`refuses a ${label} task name and names the field and the value`, () => {
      const problems = validateManifest(
        manifest({
          slots: [
            {
              task,
              image: "python:3.11-slim",
              imageDigest: "sha256:aaa111",
              maxTurns: 40,
              arm: "arm40",
            },
          ],
        })
      );

      assert.ok(
        problems.some(
          (problem) =>
            problem.includes("manifest.slots[0].task") &&
            problem.includes(JSON.stringify(task))
        ),
        `expected slots[0].task=${JSON.stringify(task)} refused and quoted; got: ${JSON.stringify(
          problems
        )}`
      );
    });
  }

  it("refuses the same shapes in the arm field, which shares the slot key", () => {
    const problems = validateManifest(
      manifest({
        slots: [
          {
            task: "db-wal-recovery",
            image: "python:3.11-slim",
            imageDigest: "sha256:aaa111",
            maxTurns: 40,
            arm: "../../escape",
          },
        ],
      })
    );

    assert.ok(
      problems.some(
        (problem) =>
          problem.includes("manifest.slots[0].arm") &&
          problem.includes(JSON.stringify("../../escape"))
      ),
      `expected an arm refusal; got: ${JSON.stringify(problems)}`
    );
  });

  it("still refuses an empty task, quoting the field and the value", () => {
    const problems = validateManifest(
      manifest({
        slots: [
          {
            task: "",
            image: "python:3.11-slim",
            imageDigest: "sha256:aaa111",
            maxTurns: 40,
            arm: "arm40",
          },
        ],
      })
    );

    assert.ok(
      problems.some(
        (problem) =>
          problem.includes("manifest.slots[0].task") &&
          problem.includes(JSON.stringify(""))
      ),
      `expected an empty-task refusal naming the value; got: ${JSON.stringify(problems)}`
    );
  });

  it("accepts the real dataset's task, arm and OCI reference shapes", () => {
    // The control: `image`/`imageDigest` legitimately contain `/` and `:` and must stay
    // valid, and a real task name is a bare slug.
    assert.deepEqual(
      validateManifest(
        manifest({
          slots: [
            {
              task: "adaptive-rejection-sampler",
              image: "alexgshaw/adaptive-rejection-sampler:20251031",
              imageDigest: "sha256:aaa111",
              maxTurns: 40,
              arm: "arm40",
            },
          ],
        })
      ),
      [],
      "a real slot must still validate"
    );
  });

  it("pins WHY the rule exists: a traversal task escapes the run root", () => {
    const escaped = join(
      "/srv/eval-1219/runs",
      slotKeyOf({
        task: "../../../../tmp/escaped",
        image: "python:3.11-slim",
        imageDigest: "sha256:aaa111",
        maxTurns: 40,
        arm: "arm40",
      })
    );

    assert.equal(
      escaped.startsWith("/srv/eval-1219/runs/"),
      false,
      `the slot key must not be able to leave the run root; it resolved to ${escaped}`
    );
  });
});

describe("resolved config", () => {
  it("derives a per-slot run identity from the manifest", () => {
    const config = resolveConfig(params(), manifest());
    const identity = config.identityFor(config.manifest.slots[0]!);

    assert.equal(
      identity.task,
      "db-wal-recovery",
      "identity must carry the slot task"
    );
    assert.equal(
      identity.imageDigest,
      "sha256:aaa111",
      "identity must carry the slot image digest"
    );
    assert.equal(
      identity.runnerVersion,
      "tb2.1-attempt/1",
      "identity must carry the manifest runner version"
    );
  });

  it("gives both arms of one task the same identity, so the ledger must key on the slot", () => {
    const paired = manifest({
      slots: [
        {
          task: "db-wal-recovery",
          image: "python:3.11-slim",
          imageDigest: "sha256:aaa111",
          maxTurns: 40,
          arm: "arm40",
        },
        {
          task: "db-wal-recovery",
          image: "python:3.11-slim",
          imageDigest: "sha256:aaa111",
          maxTurns: 80,
          arm: "arm80",
        },
      ],
    });
    const config = resolveConfig(params(), paired);
    const [first, second] = paired.slots.map((slot) =>
      config.identityFor(slot)
    );

    assert.deepEqual(
      first,
      second,
      "both arms ran the same instrument, so their identities must be identical"
    );
    assert.equal(
      paired.slots[0]!.maxTurns !== paired.slots[1]!.maxTurns,
      true,
      "the arms are distinguished by maxTurns, not by a different instrument identity"
    );
  });

  it("refuses to resolve when a parameter is still a placeholder", () => {
    assert.throws(
      () => resolveConfig(params({ bundlePath: "" }), manifest()),
      (error: unknown) => error instanceof ConfigError,
      "a placeholder parameter must refuse resolution"
    );
  });

  it("refuses to resolve when the manifest has no slots", () => {
    assert.throws(
      () => resolveConfig(params(), manifest({ slots: [] })),
      (error: unknown) => error instanceof ConfigError,
      "an empty slot list must refuse resolution"
    );
  });

  it("reports both parameter and manifest problems together", () => {
    assert.throws(
      () => resolveConfig(params({ runRoot: "" }), manifest({ slots: [] })),
      /runRoot[\s\S]*slots/,
      "the refusal must list every problem, not just the first"
    );
  });

  it("keeps settings out of the resolved config except as a path to hash", () => {
    const config = resolveConfig(params(), manifest());

    assert.equal(
      config.params.settingsPath,
      "/srv/eval-1219/settings.json",
      "only the path is retained; contents are hashed at dispatch time, never embedded"
    );
  });
});
