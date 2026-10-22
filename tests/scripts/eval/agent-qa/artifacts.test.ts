/**
 * Artifact lifecycle witnesses what only a real filesystem can prove.
 *
 * Everything here runs against a real temporary filesystem: no `node:fs` mock could
 * prove that O_EXCL refuses a second writer or that a torn file fails to parse.
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import assert from "node:assert/strict";

import { isEvalFailure, type EvalFailure } from "../../../../scripts/eval/agent-qa/failures.ts";
import {
  appendLineFsync,
  claimFile,
  readJsonArtifact,
  reserveDir,
  sha256File,
  verifyHashIndex,
  writeHashIndex,
  writeJsonOnce,
} from "../../../../scripts/eval/agent-qa/artifacts.ts";
import { HASH_INDEX_FILE } from "../../../../scripts/eval/agent-qa/types.ts";

const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const artifactsModule = new URL(
  "../../../../scripts/eval/agent-qa/artifacts.ts",
  import.meta.url
).href;
/** root ignores mode bits, so a permission fault has to be induced another way. */
const runsAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

const roots: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-agent-qa-artifacts-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function captureFailure(run: () => unknown): EvalFailure {
  try {
    run();
  } catch (error) {
    assert.ok(isEvalFailure(error), `expected a typed failure, got ${String(error)}`);
    return error;
  }
  return assert.fail("expected the call to throw a typed failure");
}

function entriesOf(dir: string): Record<string, string> {
  const artifact = readJsonArtifact(join(dir, HASH_INDEX_FILE));
  const index = artifact.value as { entries: Record<string, string> };
  return index.entries;
}

describe("writeJsonOnce", () => {
  it("returns the digest of exactly the bytes it wrote", () => {
    const path = join(makeDir(), "attempt.json");
    const digest = writeJsonOnce(path, { caseId: "task-01" });
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(digest, sha256File(path));
    assert.deepEqual(readJsonArtifact(path).value, { caseId: "task-01" });
  });

  it("refuses a second write and leaves the original bytes intact", () => {
    const path = join(makeDir(), "attempt.json");
    const digest = writeJsonOnce(path, { outcome: "passed" });
    const before = readFileSync(path, "utf8");

    const failure = captureFailure(() => writeJsonOnce(path, { outcome: "failed" }));

    assert.equal(failure.kind, "artifact-write");
    assert.equal(failure.phase, "artifact-write");
    assert.equal(failure.dispatchMayContinue, false);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(sha256File(path), digest);
  });

  it("reports a missing parent as an io-failure carrying the attempt identity", () => {
    const dir = makeDir();
    const failure = captureFailure(() =>
      writeJsonOnce(join(dir, "attempts", "attempt.json"), { a: 1 }, { attemptId: "a-1" })
    );
    assert.equal(failure.kind, "io-failure");
    assert.equal(failure.attemptId, "a-1");
    assert.equal(failure.dispatchMayContinue, false);
  });

  it("refuses a value that cannot cross JSON without opening a file", () => {
    const path = join(makeDir(), "attempt.json");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const failure = captureFailure(() => writeJsonOnce(path, cyclic));

    assert.equal(failure.kind, "artifact-write");
    assert.equal(existsSync(path), false, "a value that cannot serialize creates no artifact");
  });
});

describe("appendLineFsync", () => {
  it("appends whole JSONL records in order", () => {
    const path = join(makeDir(), "ledger.jsonl");
    appendLineFsync(path, { phase: "intent", attemptId: "a-1" });
    appendLineFsync(path, { phase: "settled", attemptId: "a-1" });

    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
    assert.deepEqual(
      lines.map((line) => JSON.parse(line) as unknown),
      [
        { phase: "intent", attemptId: "a-1" },
        { phase: "settled", attemptId: "a-1" },
      ]
    );
  });

  it("fails typed when the target cannot be appended", () => {
    const failure = captureFailure(() =>
      appendLineFsync(join(makeDir(), "absent", "ledger.jsonl"), { a: 1 })
    );
    assert.equal(failure.kind, "io-failure");
    assert.equal(failure.dispatchMayContinue, false);
  });
});

describe("readJsonArtifact", () => {
  it("separates an absent artifact from an unreadable one", () => {
    const dir = makeDir();
    const absent = captureFailure(() => readJsonArtifact(join(dir, "attempt.json")));
    assert.equal(absent.kind, "missing-reference");

    if (runsAsRoot) {
      // EXIT: root ignores mode bits; EISDIR is used as the non-ENOENT fault instead.
      const asDirectory = join(dir, "trace.json");
      mkdirSync(asDirectory);
      const unreadable = captureFailure(() => readJsonArtifact(asDirectory));
      assert.equal(unreadable.kind, "io-failure");
      assert.notEqual(unreadable.kind, absent.kind);
      return;
    }
    const path = join(dir, "locked.json");
    writeJsonOnce(path, { a: 1 });
    chmodSync(path, 0o000);
    try {
      const unreadable = captureFailure(() => readJsonArtifact(path));
      assert.equal(unreadable.kind, "io-failure");
      assert.notEqual(unreadable.kind, absent.kind);
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it("calls truncated bytes artifact-corrupt", () => {
    const dir = makeDir();
    const path = join(dir, "attempt.json");
    writeJsonOnce(path, { outcome: "passed", usage: { wallMs: 12 } });
    const body = readFileSync(path, "utf8");
    writeFileSync(path, body.slice(0, Math.floor(body.length / 2)));

    const failure = captureFailure(() => readJsonArtifact(path));

    assert.equal(failure.kind, "artifact-corrupt");
    assert.equal(failure.phase, "artifact-read");
    assert.equal(failure.dispatchMayContinue, false);
  });

  it("calls a mismatched expected digest stale-digest", () => {
    const dir = makeDir();
    const path = join(dir, "outcome.json");
    writeJsonOnce(path, { outcome: "passed" });
    const frozen = sha256File(path);
    // The test tampers through plain writeFileSync on purpose: the fault under witness
    // is a reader facing bytes that are no longer the ones it froze.
    writeFileSync(path, '{"outcome":"failed"}\n');

    const failure = captureFailure(() => readJsonArtifact(path, frozen));

    assert.equal(failure.kind, "stale-digest");
    assert.notEqual(failure.kind, "artifact-corrupt");
  });

  it("returns the digest of a matching artifact", () => {
    const dir = makeDir();
    const path = join(dir, "outcome.json");
    const digest = writeJsonOnce(path, { outcome: "passed" });
    assert.deepEqual(readJsonArtifact(path, digest), {
      value: { outcome: "passed" },
      digest,
    });
  });
});

describe("hash index", () => {
  it("indexes nested artifacts, never itself, and verifies clean", () => {
    const dir = makeDir();
    writeJsonOnce(join(dir, "attempt.json"), { a: 1 });
    mkdirSync(join(dir, "trace"));
    appendLineFsync(join(dir, "trace", "trace.jsonl"), { step: 1 });

    const indexDigest = writeHashIndex(dir);

    assert.equal(indexDigest, sha256File(join(dir, HASH_INDEX_FILE)));
    verifyHashIndex(dir);
    assert.deepEqual(Object.keys(entriesOf(dir)).sort(), [
      "attempt.json",
      "trace/trace.jsonl",
    ]);
  });

  it("detects a modified artifact", () => {
    const dir = makeDir();
    const path = join(dir, "attempt.json");
    writeJsonOnce(path, { outcome: "passed" });
    writeHashIndex(dir);
    writeFileSync(path, '{"outcome":"failed"}\n');

    const failure = captureFailure(() => verifyHashIndex(dir));

    assert.equal(failure.kind, "artifact-corrupt");
    assert.match(failure.diagnostic, /attempt\.json/);
  });

  it("detects a deleted artifact as a missing reference", () => {
    const dir = makeDir();
    const path = join(dir, "attempt.json");
    writeJsonOnce(path, { outcome: "passed" });
    writeHashIndex(dir);
    rmSync(path);

    const failure = captureFailure(() => verifyHashIndex(dir));

    assert.equal(failure.kind, "missing-reference");
    assert.notEqual(failure.kind, "artifact-corrupt");
  });

  it("detects a file created after the index, then re-indexes without self-contradiction", () => {
    const dir = makeDir();
    writeJsonOnce(join(dir, "attempt.json"), { a: 1 });
    const firstIndex = writeHashIndex(dir);
    writeFileSync(join(dir, "late.json"), "{}\n");

    const failure = captureFailure(() => verifyHashIndex(dir));
    assert.equal(failure.kind, "artifact-corrupt");
    assert.match(failure.diagnostic, /late\.json/);

    // Re-indexing is allowed because the index is a derived manifest, not evidence.
    const secondIndex = writeHashIndex(dir);
    assert.notEqual(secondIndex, firstIndex);
    verifyHashIndex(dir);
    assert.ok(!(HASH_INDEX_FILE in entriesOf(dir)), "the index must never list itself");
  });

  it("refuses an index it cannot interpret", () => {
    const dir = makeDir();
    writeJsonOnce(join(dir, "attempt.json"), { a: 1 });
    writeHashIndex(dir);
    writeFileSync(join(dir, HASH_INDEX_FILE), '{"indexVersion":1}\n');

    const failure = captureFailure(() => verifyHashIndex(dir));

    assert.equal(failure.kind, "artifact-corrupt");
  });

  it("refuses to index bytes outside the artifact root through a symlink", () => {
    const outsideDir = makeDir();
    const outside = join(outsideDir, "outside.json");
    writeJsonOnce(outside, { note: "SENTINEL-CONTENT" });

    const writeDir = makeDir();
    symlinkSync(outside, join(writeDir, "leak.json"));
    const writeFault = captureFailure(() => writeHashIndex(writeDir));
    assert.equal(writeFault.kind, "artifact-corrupt");
    assert.equal(writeFault.phase, "artifact-write");

    const dir = makeDir();
    writeJsonOnce(join(dir, "attempt.json"), { a: 1 });
    writeHashIndex(dir);
    symlinkSync(outside, join(dir, "late-leak.json"));

    const verifyFault = captureFailure(() => verifyHashIndex(dir));

    assert.equal(verifyFault.kind, "artifact-corrupt");
    assert.equal(verifyFault.phase, "artifact-read");
    assert.ok(
      !verifyFault.diagnostic.includes("SENTINEL-CONTENT"),
      "a refused symlink must not leak the bytes it pointed at"
    );
  });
});

describe("reserveDir", () => {
  it("reserves once and refuses a second reservation of the same path", () => {
    const dir = makeDir();
    const attemptDir = join(dir, "attempt-1");
    reserveDir(attemptDir, "a-1");

    const failure = captureFailure(() => reserveDir(attemptDir, "a-2"));

    assert.equal(failure.kind, "contended-claim");
    assert.equal(failure.attemptId, "a-2");
    assert.equal(failure.dispatchMayContinue, false);
  });

  it("refuses to invent a missing parent instead of reserving non-recursively", () => {
    const failure = captureFailure(() =>
      reserveDir(join(makeDir(), "attempts", "a-1"), "a-1")
    );
    assert.equal(failure.kind, "io-failure");
  });
});

interface ClaimResult {
  readonly code: number;
  readonly outcome: string;
}

/** Real parallel claimants: two OS processes, one kernel-decided winner. */
function claimInProcess(
  claimPath: string,
  holder: string,
  attemptId: string
): Promise<ClaimResult> {
  const script =
    `import(${JSON.stringify(artifactsModule)}).then((m) => {` +
    "m.claimFile(process.argv[1], process.argv[2], process.argv[3]);" +
    'process.stdout.write("won");' +
    "}).catch(() => { process.stdout.write(\"lost\"); process.exitCode = 1; });";
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", tsxLoader, "-e", script, claimPath, holder, attemptId],
      (error, stdout) => {
        resolve({ code: error ? Number(error.code ?? 1) : 0, outcome: stdout.trim() });
      }
    );
  });
}

describe("claimFile", () => {
  it("records the holder and refuses a second claim on the same path", () => {
    const path = join(makeDir(), ".claim");
    claimFile(path, "attempt-a", "a-1");
    assert.equal(readFileSync(path, "utf8").trim(), "attempt-a");

    const failure = captureFailure(() => claimFile(path, "attempt-b", "a-2"));

    assert.equal(failure.kind, "duplicate-claim");
    assert.equal(failure.attemptId, "a-2");
    assert.equal(readFileSync(path, "utf8").trim(), "attempt-a");
  });

  it("lets exactly one of two concurrent claimants win", async () => {
    const dir = makeDir();
    const path = join(dir, ".claim");

    const [first, second] = await Promise.all([
      claimInProcess(path, "holder-a", "attempt-a"),
      claimInProcess(path, "holder-b", "attempt-b"),
    ]);

    assert.equal(
      [first.outcome, second.outcome].filter((o) => o === "won").length,
      1
    );
    assert.equal([first.code, second.code].filter((c) => c === 0).length, 1);
    const holder = readFileSync(path, "utf8").trim();
    assert.ok(holder === "holder-a" || holder === "holder-b");
    assert.equal(holder, first.outcome === "won" ? "holder-a" : "holder-b");
  });

  it("reports an uncreatable claim path as an io-failure", () => {
    const failure = captureFailure(() =>
      claimFile(join(makeDir(), "absent", ".claim"), "holder-a", "attempt-a")
    );
    assert.equal(failure.kind, "io-failure");
    assert.equal(failure.phase, "claim");
  });
});
