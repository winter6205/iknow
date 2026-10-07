/**
 * The curl-gap search must not become a `docker pull`.
 *
 * Why this file exists: the smoke's stated limitation is that the dataset's images are
 * deliberately NOT pulled locally. `probeImageTools` runs `docker run --rm <tag> …`, and
 * `docker run` on a tag the daemon does not have PULLS it — so a candidate search that
 * iterates every task spends unbounded network and disk (one 60s probe per task) on images
 * the same report then publishes as `imageLocal: null` / `GATE:image-missing`. The report
 * contradicts its own evidence, and the pull happens whether or not an ABSENT image is ever
 * found: the loop only stops at the first ABSENT, so the cost is bounded by the dataset size,
 * never by the question being asked.
 *
 * The gate is the same one `imageGlibcxx` already uses: probe an image only when it is
 * already present locally AND probing was not switched off. A non-local image is then
 * reported `GATE:image-missing` by the preflight sweep, which is the honest description of an
 * image this run never pulled.
 *
 * Driven through the real `selectCurlGapImage` with a fake `ExecFn`, so the assertion is about
 * the argv the daemon would receive and not about a private helper.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import type { ExecFn } from "../../../../scripts/eval/terminal-bench-2.1/docker.ts";
import { selectCurlGapImage } from "../../../../scripts/eval/terminal-bench-2.1/smoke-oracle.ts";
import { curlGapNotFound } from "../../../../scripts/eval/terminal-bench-2.1/smoke-oracle.ts";
import type { RunnerPort } from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";
import { probeCurlGap } from "../../../../scripts/eval/terminal-bench-2.1/smoke.ts";
import type {
  SmokeContext,
  SmokeOptions,
  TaskFacts,
} from "../../../../scripts/eval/terminal-bench-2.1/smoke-types.ts";

const LOCAL = "example/local:1";
const REMOTE = "example/remote:1";
/** curl absent, tar present: the shape a real curl-gap image reports. */
const GAP_PROBE = "ABSENT | /usr/bin/tar\n";

/** A port that refuses any container work, so a test can only observe the probe path. */
const NO_CONTAINERS: RunnerPort = {
  version: "tb2.1-docker/test",
  provision: async () => {
    throw new Error("no container work belongs in this test");
  },
  dispatch: async () => {
    throw new Error("no dispatch belongs in this test");
  },
  grade: async () => {
    throw new Error("no grader belongs in this test");
  },
  reap: async () => {},
};

function options(overrides: Partial<SmokeOptions> = {}): SmokeOptions {
  return {
    datasetRoot: "/dataset",
    bundlePath: "/bundle.tgz",
    nodeArchivePath: "/node.tar.gz",
    outRoot: "/out",
    tasks: [],
    nodeSha256: null,
    bundleSha256: null,
    glibcxxFloor: "GLIBCXX_3.4.31",
    graderWallSec: 1800,
    graderGraceSec: 600,
    probeEveryImage: true,
    ...overrides,
  };
}

function facts(
  task: string,
  image: string,
  imageLocal: boolean | null
): TaskFacts {
  return {
    task,
    image,
    verifierTimeoutSec: 300,
    graderPresent: true,
    imageLocal,
    glibcxxMeasured: imageLocal === true ? "GLIBCXX_3.4.33" : "NOT_PROBED",
    problems: [],
  };
}

/** The fake `ExecFn`, plus the record of every `docker run` the search actually issued. */
function probeExec(): {
  readonly exec: ExecFn;
  readonly probes: ReadonlyArray<string>;
} {
  const probes: string[] = [];
  const exec: ExecFn = async (_file, args) => {
    // `docker run --rm <image> bash -c …`: the image is the token right after `--rm`.
    if (args[0] === "run") probes.push(args[2] ?? "");
    return { stdout: GAP_PROBE, stderr: "", code: 0 };
  };
  return { exec, probes };
}

function contextWith(
  exec: ExecFn,
  overrides: Partial<SmokeOptions> = {}
): SmokeContext {
  return {
    options: options(overrides),
    exec,
    runner: NO_CONTAINERS,
    ledger: { count: 0 },
    nodeSha: "a".repeat(64),
    bundleSha: "b".repeat(64),
    settingsPath: "/out/meta/smoke-settings.json",
    toolProbes: new Map<string, string>(),
  };
}

describe("the curl-gap search never pulls an image", () => {
  it("skips an image the daemon does not already have, and probes the local one", async () => {
    const { exec, probes } = probeExec();
    const gap = await selectCurlGapImage(contextWith(exec), [
      facts("remote-task", REMOTE, null),
      facts("local-task", LOCAL, true),
    ]);

    assert.equal(
      gap?.task,
      "local-task",
      `only a locally present image may be probed; got: ${gap?.task ?? "null"}`
    );
    assert.deepEqual(
      probes,
      [LOCAL],
      `docker run on a missing tag PULLS it, so a non-local candidate must never be probed; probed: ${JSON.stringify(probes)}`
    );
  });

  it("probes nothing at all when image probing is switched off", async () => {
    const { exec, probes } = probeExec();
    const gap = await selectCurlGapImage(
      contextWith(exec, { probeEveryImage: false }),
      [facts("local-task", LOCAL, true)]
    );

    assert.equal(
      gap,
      null,
      "--skip-image-probe means this run measures no image, so no gap image may be claimed"
    );
    assert.deepEqual(
      probes,
      [],
      `the switch must reach the curl-gap search too, exactly as it reaches imageGlibcxx; probed: ${JSON.stringify(probes)}`
    );
  });

  it("returns null, and probes nothing, when no image is present locally", async () => {
    const { exec, probes } = probeExec();
    const gap = await selectCurlGapImage(contextWith(exec), [
      facts("remote-a", REMOTE, null),
      facts("remote-b", REMOTE, null),
    ]);

    assert.equal(gap, null, "no local image means no gap image was found");
    assert.deepEqual(
      probes,
      [],
      `an all-remote dataset must cost zero probes; probed: ${JSON.stringify(probes)}`
    );
  });
});

/**
 * A gap image that was never found must not publish a sweep that never ran. The old detail
 * was the literal "every probed image ships curl", which describes a run that probed
 * something — and after the candidate gate above, a `--skip-image-probe` run and an
 * all-remote dataset both probe NOTHING while still having to report why.
 */
describe("the not-found reason names the state that produced it", () => {
  it("says nothing was probed when image probing is switched off", () => {
    const { exec } = probeExec();
    const detail = curlGapNotFound(
      contextWith(exec, { probeEveryImage: false }),
      [facts("local-task", LOCAL, true)]
    );

    assert.match(
      detail,
      /--skip-image-probe/,
      `the operator must learn why the gap evidence is empty; got: ${detail}`
    );
    assert.doesNotMatch(
      detail,
      /every .* ships curl/,
      `a run that probed nothing must not claim a sweep; got: ${detail}`
    );
  });

  it("says nothing was probed when no image is present locally", () => {
    const { exec } = probeExec();
    const detail = curlGapNotFound(contextWith(exec), [
      facts("remote-a", REMOTE, null),
    ]);

    assert.match(
      detail,
      /nothing was probed/,
      `an unprobed dataset must be described as unprobed; got: ${detail}`
    );
    assert.doesNotMatch(
      detail,
      /every .* ships curl/,
      `no image was probed, so no sweep can be reported; got: ${detail}`
    );
  });

  it("reports how many images really were probed when local ones all ship curl", () => {
    const { exec } = probeExec();
    const detail = curlGapNotFound(contextWith(exec), [
      facts("local-a", LOCAL, true),
      facts("local-b", LOCAL, true),
      facts("remote", REMOTE, null),
    ]);

    assert.match(
      detail,
      /2 image\(s\) probed/,
      `the count is the only thing that makes this sentence a measurement; got: ${detail}`
    );
  });
});

/**
 * The helper above is only worth anything if the RUN publishes it. This drives the
 * orchestrator's own curl-gap step, because a hard-coded "every probed image ships curl"
 * sitting one layer up is the same defect wearing a different hat: the report would claim a
 * sweep that the candidate gate deliberately skipped.
 */
describe("the run publishes the reason it found no gap image", () => {
  it("carries the honest reason into the report evidence on a --skip-image-probe run", async () => {
    const { exec } = probeExec();
    const evidence = await probeCurlGap(
      contextWith(exec, { probeEveryImage: false }),
      [facts("local-task", LOCAL, true)],
      []
    );

    assert.equal(
      evidence.via,
      "not-found",
      "no image was probed, so no gap image was found"
    );
    assert.match(
      evidence.detail,
      /--skip-image-probe/,
      `the published evidence must say why it is empty; got: ${evidence.detail}`
    );
    assert.doesNotMatch(
      evidence.detail,
      /every .* ships curl/,
      `the report may not claim a probe sweep the run skipped; got: ${evidence.detail}`
    );
  });

  it("says nothing was probed when the dataset has no local image", async () => {
    const { exec, probes } = probeExec();
    const evidence = await probeCurlGap(
      contextWith(exec),
      [facts("remote", REMOTE, null)],
      []
    );

    assert.equal(
      evidence.passed,
      false,
      "an unmeasured gap image is not a provisioned one"
    );
    assert.deepEqual(probes, [], "and it costs no probe to say so");
    assert.match(
      evidence.detail,
      /nothing was probed/,
      `an all-remote dataset must be described as unprobed; got: ${evidence.detail}`
    );
  });
});
