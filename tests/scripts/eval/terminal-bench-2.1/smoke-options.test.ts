/**
 * The smoke's argument parsing, over the input classes that decide whether a run can start
 * at all. Issue 1219 requires malformed input to fail "without a silent success".
 *
 * The class that had no test and no guard: a VALUE that is itself a flag. `--out --tasks`
 * parsed without throwing and yielded `out = "--tasks"`, so the smoke went on to mkdir and
 * write its whole report under a literal `--tasks` directory in the operator's CWD — a run
 * that looks successful, publishes its evidence in the wrong place, and leaves that
 * directory behind. `--dataset --bundle /b` was worse in a different way: it consumed the
 * next flag as the dataset path and then blamed `/b` for being unreadable, so the message
 * pointed at the wrong token.
 *
 * Malformed input is the smoke's own refusal surface, so these are the tests that say a bad
 * command line cannot start a run quietly.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  optionsFrom,
  parseArgs,
} from "../../../../scripts/eval/terminal-bench-2.1/smoke-options.ts";

const REQUIRED = [
  "--dataset",
  "/dataset",
  "--bundle",
  "/bundle.tgz",
  "--node-archive",
  "/node-dist.tar.gz",
];

function parse(...extra: ReadonlyArray<string>) {
  return optionsFrom(parseArgs([...REQUIRED, ...extra]));
}

function messageOf(body: () => unknown): string {
  try {
    body();
    return "";
  } catch (error) {
    return String((error as Error).message);
  }
}

describe("the normal command line still parses", () => {
  it("accepts the documented flags and keeps the runbook's defaults", () => {
    const options = parse("--out", "/out");

    assert.equal(options.datasetRoot, "/dataset");
    assert.equal(options.bundlePath, "/bundle.tgz");
    assert.equal(options.nodeArchivePath, "/node-dist.tar.gz");
    assert.equal(options.outRoot, "/out");
    assert.deepEqual(
      options.tasks,
      [],
      "no --tasks means the smoke picks its own defaults"
    );
    assert.equal(
      options.glibcxxFloor,
      "GLIBCXX_3.4.31",
      "the floor is a documented default"
    );
    assert.equal(
      options.probeEveryImage,
      true,
      "probing is on unless it is switched off"
    );
    assert.equal(
      options.nodeSha256,
      null,
      "an unpinned archive is measured, not assumed"
    );
  });

  it("keeps the valueless switch valueless", () => {
    const options = parse("--out", "/out", "--skip-image-probe");

    assert.equal(
      options.probeEveryImage,
      false,
      "--skip-image-probe must survive the flag-as-value guard without needing a value"
    );
  });

  it("splits a task list and drops empty entries", () => {
    const options = parse(
      "--out",
      "/out",
      "--tasks",
      "db-wal-recovery, , password-recovery"
    );

    assert.deepEqual(options.tasks, ["db-wal-recovery", "password-recovery"]);
  });
});

describe("a flag in a value position is a refusal, not a value", () => {
  it("refuses --out followed by a flag, naming the flag that lost its value", () => {
    const message = messageOf(() =>
      optionsFrom(parseArgs([...REQUIRED, "--out", "--tasks"]))
    );

    assert.notEqual(
      message,
      "",
      `--out --tasks must not parse; the smoke would then write everything under a literal --tasks directory; got: ${message}`
    );
    assert.match(
      message,
      /--out/,
      `the message must name the flag whose value is missing, not the token it swallowed; got: ${message}`
    );
  });

  it("refuses --dataset followed by a flag", () => {
    const message = messageOf(() =>
      optionsFrom(
        parseArgs([
          "--dataset",
          "--bundle",
          "/b",
          "--node-archive",
          "/n",
          "--out",
          "/out",
        ])
      )
    );

    assert.notEqual(
      message,
      "",
      "a flag in the value position must refuse, or the next token is silently consumed"
    );
    assert.match(
      message,
      /--dataset/,
      `the blame belongs to the flag that lost its value, not to /b; got: ${message}`
    );
    assert.doesNotMatch(
      message,
      /\/b/,
      `the real path token was valid; naming it sends the operator to the wrong place; got: ${message}`
    );
  });

  it("refuses a single-dash-looking value only for the real flag spellings it knows", () => {
    const message = messageOf(() => parse("--out", "--nope"));

    assert.match(
      message,
      /--out/,
      `an unknown flag in a value slot is still a missing value; got: ${message}`
    );
  });
});

describe("--out must name a path docker can mount", () => {
  it("refuses an empty --out", () => {
    const message = messageOf(() => parse("--out", "   "));

    assert.match(
      message,
      /--out/,
      `an empty out root would write into the operator's CWD; got: ${message}`
    );
  });

  it("refuses a colon-bearing --out", () => {
    const message = messageOf(() => parse("--out", "/out/run:arm40:40"));

    assert.notEqual(
      message,
      "",
      "docker parses a -v source as HOST:CONTAINER[:ro] and refuses more than two colons, so this path cannot be mounted as given"
    );
    assert.match(
      message,
      /--out/,
      `the message must name the flag to fix; got: ${message}`
    );
    assert.match(
      message,
      /colon/i,
      `the message must say WHY a colon is refused, or it reads as a mystery; got: ${message}`
    );
  });

  it("refuses a colon-bearing --out even when every other flag is valid", () => {
    const message = messageOf(() =>
      parse("--out", "/out/a:b", "--tasks", "db-wal-recovery")
    );

    assert.match(message, /--out/, `got: ${message}`);
  });
});

describe("numeric and digest flags refuse their bad classes", () => {
  it("refuses a zero, negative or non-numeric wall", () => {
    for (const bad of ["0", "-1", "abc", "1e", ""]) {
      const message = messageOf(() =>
        parse("--out", "/out", "--grader-wall-sec", bad)
      );

      assert.match(
        message,
        /--grader-wall-sec must be a positive number/,
        `wall=${JSON.stringify(bad)} must be refused with the flag named; got: ${message}`
      );
    }
  });

  it("refuses a malformed node or bundle digest", () => {
    for (const [flag, bad] of [
      ["--node-sha", "abc"],
      ["--node-sha", "A".repeat(64)],
      ["--bundle-sha", `${"a".repeat(63)}`],
    ] as const) {
      const message = messageOf(() => parse("--out", "/out", flag, bad));

      assert.match(
        message,
        /64 lowercase hex/,
        `${flag} ${JSON.stringify(bad)} must be refused; got: ${message}`
      );
    }
  });

  it("accepts a well-formed digest", () => {
    const options = parse("--out", "/out", "--node-sha", "a".repeat(64));

    assert.equal(options.nodeSha256, "a".repeat(64));
  });
});

describe("unknown and value-less flags still refuse", () => {
  it("refuses an unknown flag", () => {
    const message = messageOf(() => parse("--out", "/out", "--turbo", "1"));

    assert.match(message, /--turbo/, `got: ${message}`);
  });

  it("refuses a required flag with no token after it", () => {
    const message = messageOf(() =>
      optionsFrom(parseArgs(["--dataset", "/dataset", "--bundle", "/b"]))
    );

    assert.match(
      message,
      /--node-archive/,
      `the absent required flag must be named; got: ${message}`
    );
  });

  it("refuses a bare --out with nothing after it", () => {
    const message = messageOf(() =>
      optionsFrom(parseArgs([...REQUIRED, "--out"]))
    );

    assert.notEqual(
      message,
      "",
      "a trailing value-taking flag has no value; got: a silent parse"
    );
  });
});
