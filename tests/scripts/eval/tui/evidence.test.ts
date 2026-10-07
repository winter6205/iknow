/**
 * Contract tests for `scripts/eval/tui/evidence.ts` (#1219 §4).
 *
 * WHY: the historical report counted attempts (`stimuli_sent`) and not
 * outcomes, and its hash index listed ITSELF with a stale digest (the recorded
 * sha was 256 B behind the real file, because the walk ran before the file was
 * written). Every number below is derived from a retained artifact on disk —
 * there is no hardcoded count anywhere in the module under test, and a report
 * that cannot name its observation window is not accepted here.
 */
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildIndex,
  deriveCounters,
  separateRuns,
  verifyIndex,
  writeIndexAtomic,
  type ArtifactRefs,
} from "../../../../scripts/eval/tui/evidence.ts";
import {
  appendAssistant,
  appendNativeState,
  appendUser,
  initStore,
  storePath,
  writeRssCsv,
  writeSnapshots,
  type FixtureLocation,
  type RssRow,
} from "./fixture.ts";

const roots: string[] = [];

function makeRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `iknow-evidence-${name}-`));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const INDEX_NAME = "evidence-index.txt";
const VERDICT_FILE = "check-report.json";

/** The historical run3 shape: 66 data rows, 64 distinct t_rel (two sampled
 *  twice by the RSS timer and the snapshot timer landing on the same tick). */
function rssRows(count: number, dupes: number): RssRow[] {
  const unique: RssRow[] = [];
  for (let i = 0; i < count - dupes; i++) {
    unique.push({
      tRelS: Math.round((60 * (i + 1)) / 10) / 10,
      iso: `2026-10-06T20:${String(10 + Math.floor(i / 60)).padStart(2, "0")}:00.000`,
      pid: 65491,
      vmrssKb: 190000 + i * 1000,
      alive: 1,
    });
  }
  // A duplicate lands ADJACENT to its source, which is the real shape: the RSS
  // timer and the snapshot timer sampled the same tick and both wrote a row.
  const rows: RssRow[] = [];
  unique.forEach((row, i) => {
    rows.push(row);
    if (i < dupes) rows.push({ ...row });
  });
  return rows;
}

function makeRefs(
  root: string,
  over: Partial<ArtifactRefs> = {}
): ArtifactRefs {
  const loc: FixtureLocation = {
    dataDir: join(root, "data"),
    cwd: join(root, "repo"),
    conversationId: "conv-1",
  };
  initStore(loc, "seed");
  const baselineOffset = readFileSync(storePath(loc)).length;
  appendUser({ loc, index: 1, parent: "e0", text: "S1" });
  appendNativeState({
    loc,
    anchorEventId: "e1",
    boundary: "input",
    messageCount: 2,
    createdAt: "2026-10-06T12:00:57.196Z",
  });
  appendAssistant({ loc, index: 2, parent: "e1", text: "ack" });
  appendNativeState({
    loc,
    anchorEventId: "e2",
    boundary: "terminal",
    messageCount: 3,
    createdAt: "2026-10-06T12:01:02.926Z",
  });

  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeRssCsv(runDir, rssRows(66, 2));
  writeSnapshots(join(runDir, "snapshots"), 12);
  const retainedStore = join(runDir, "store.jsonl");
  writeFileSync(retainedStore, readFileSync(storePath(loc), "utf8"), "utf8");
  writeFileSync(
    join(runDir, "baseline.json"),
    JSON.stringify({
      conversationId: loc.conversationId,
      byteOffset: baselineOffset,
      eventIds: ["e0"],
    }),
    "utf8"
  );
  return {
    runDir,
    runKind: "measured",
    rssCsv: join(runDir, "rss.csv"),
    snapshotsDir: join(runDir, "snapshots"),
    storeJsonl: retainedStore,
    baselineJson: join(runDir, "baseline.json"),
    window: {
      startedIso: "2026-10-06T20:00:32.537Z",
      endedIso: "2026-10-06T20:56:02.815Z",
    },
    ...over,
  };
}

describe("deriveCounters — every number comes from a retained artifact", () => {
  it("derives RSS rows, unique timestamps, snapshots, accepted stimuli and the store census", () => {
    const refs = makeRefs(makeRoot("counters"));
    const counters = deriveCounters(refs);

    assert.equal(
      counters.rss.rows,
      66,
      `expected the 66 retained data rows; got: ${counters.rss.rows}`
    );
    assert.equal(
      counters.rss.uniqueTrel,
      64,
      `66 rows carried 64 distinct t_rel; got: ${counters.rss.uniqueTrel}`
    );
    assert.equal(counters.rss.duplicateRows, 2);
    assert.equal(counters.rss.nonMonotonic, false);
    assert.equal(counters.snapshots, 12);
    assert.equal(
      counters.acceptedStimuli,
      1,
      "one real user message after the baseline offset"
    );
    assert.equal(
      counters.settledStimuli,
      1,
      "one terminal boundary after the baseline offset"
    );
    assert.equal(
      counters.storeCensus.message,
      3,
      "the seeded e0 plus the accepted user message and its reply"
    );
    assert.equal(
      counters.storeCensus.head,
      3,
      "one trailing head per message, as the store writes it"
    );
    assert.equal(counters.storeCensus.native_state, 2);
    assert.equal(counters.storeCensus.session, 1);
    assert.equal(counters.window.startedIso, "2026-10-06T20:00:32.537Z");
  });

  it("does not count host-injected records as accepted stimuli", () => {
    const root = makeRoot("hostinjected");
    const refs = makeRefs(root);
    const loc: FixtureLocation = {
      dataDir: join(root, "data"),
      cwd: join(root, "repo"),
      conversationId: "conv-1",
    };
    appendUser({
      loc,
      index: 3,
      parent: "e2",
      text: "echo",
      hostInjected: true,
    });
    appendNativeState({
      loc,
      anchorEventId: "e3",
      boundary: "tool_batch",
      messageCount: 4,
      createdAt: "2026-10-06T12:01:10.000Z",
    });
    const store = join(refs.runDir, "store.jsonl");
    writeFileSync(store, readFileSync(storePath(loc), "utf8"), "utf8");

    assert.equal(
      deriveCounters(refs).acceptedStimuli,
      1,
      "the host-injected echo is not a stimulus"
    );
  });

  it("reports a non-monotonic RSS timeline honestly instead of hiding it", () => {
    const root = makeRoot("nonmono");
    const refs = makeRefs(root, {});
    // Three rows whose last t_rel goes BACKWARDS relative to its predecessor.
    writeRssCsv(
      refs.runDir,
      rssRows(3, 0).map((r, i) => (i === 2 ? { ...r, tRelS: 0.9 } : r))
    );
    const counters = deriveCounters(refs);

    assert.equal(counters.rss.rows, 3);
    assert.equal(
      counters.rss.nonMonotonic,
      true,
      `a t_rel that goes backwards must be reported; got: ${JSON.stringify(counters.rss)}`
    );
  });

  it("refuses to derive counters from a missing artifact instead of reporting zero", () => {
    const refs = makeRefs(makeRoot("missing"));
    const broken: ArtifactRefs = {
      ...refs,
      rssCsv: join(refs.runDir, "absent.csv"),
    };

    assert.throws(
      () => deriveCounters(broken),
      /rss/i,
      "a missing retained artifact must fail loudly; a silent zero is indistinguishable from a real measurement of zero"
    );
  });

  it("states the observation window for every run it counts", () => {
    const root = makeRoot("window");
    const refs = makeRefs(root);
    const resumeRefs: ArtifactRefs = { ...refs, runKind: "resume" };

    assert.equal(
      deriveCounters(refs).window.startedIso,
      "2026-10-06T20:00:32.537Z"
    );
    assert.equal(deriveCounters(resumeRefs).runKind, "resume");
  });
});

describe("separateRuns — resume and preflight samples are never pooled", () => {
  it("keeps the measured run distinct from a resume run", () => {
    const measured = deriveCounters(makeRefs(makeRoot("measured")));
    const resume = deriveCounters(
      makeRefs(makeRoot("resume"), { runKind: "resume" })
    );
    const split = separateRuns([resume, measured]);

    assert.equal(split.measured?.runKind, "measured");
    assert.deepEqual(
      split.others.map((c) => c.runKind),
      ["resume"]
    );
    assert.equal(
      split.measured?.rss.rows,
      measured.rss.rows,
      "the measured run's counters must not absorb resume samples"
    );
    assert.ok(
      split.others.every((c) => c.runKind !== "measured"),
      "only one entry may claim the measured role"
    );
  });

  it("reports a missing measured run rather than defaulting to one", () => {
    const resume = deriveCounters(
      makeRefs(makeRoot("onlyresume"), { runKind: "resume" })
    );

    assert.equal(separateRuns([resume]).measured, null);
  });
});

describe("hash index — payload only, atomic, verified on readback", () => {
  it("excludes the index itself and every temporary index file from the payload list", () => {
    const root = makeRoot("index");
    const dir = join(root, "artifacts");
    mkdirSync(join(dir, "run3"), { recursive: true });
    writeFileSync(join(dir, "run3", "rss.csv"), "t_rel_s\n60.0\n", "utf8");
    writeFileSync(join(dir, INDEX_NAME), "stale\n", "utf8");
    writeFileSync(join(dir, `${INDEX_NAME}.tmp`), "partial\n", "utf8");
    writeFileSync(join(dir, "index.json.tmp"), "{}\n", "utf8");

    const { entries } = buildIndex(dir, { indexName: INDEX_NAME });
    const paths = entries.map((e) => e.relPath);

    assert.ok(
      paths.includes("run3/rss.csv"),
      `payloads must include the run data; got: ${JSON.stringify(paths)}`
    );
    assert.equal(
      paths.some((p) => p.endsWith(".tmp")),
      false,
      `a temp index must never be hashed as a payload; got: ${JSON.stringify(paths)}`
    );
    assert.equal(
      paths.includes(INDEX_NAME),
      false,
      `the index must never list itself; got: ${JSON.stringify(paths)}`
    );
  });

  it("holds back a verdict file at ANY depth, so re-running a label cannot stale the index", () => {
    const root = makeRoot("verdict");
    const dir = join(root, "artifacts");
    mkdirSync(join(dir, "run3"), { recursive: true });
    writeFileSync(join(dir, "run3", "rss.csv"), "t_rel_s\n60.0\n", "utf8");
    // `run.ts` walks the ARTIFACTS root while the verdict is written into the
    // run's own subdirectory, so an exclude name that only ever matched the
    // root-relative path could never exclude it — the index then hashed the
    // PREVIOUS verdict, which `run.ts` overwrites moments later.
    const verdict = join(dir, "run3", VERDICT_FILE);
    writeFileSync(verdict, '{"verdict":"unusable"}\n', "utf8");

    const { entries } = buildIndex(dir, {
      indexName: INDEX_NAME,
      exclude: [VERDICT_FILE],
    });
    writeIndexAtomic(dir, entries, { indexName: INDEX_NAME });

    const paths = entries.map((e) => e.relPath);
    assert.ok(
      paths.includes("run3/rss.csv"),
      `payloads must include the run data; got: ${JSON.stringify(paths)}`
    );
    assert.equal(
      paths.some((p) => p.endsWith(VERDICT_FILE)),
      false,
      `a verdict file must never be a payload, at any depth; got: ${JSON.stringify(paths)}`
    );

    // The stale digest itself: the next run into the same directory rewrites
    // the verdict AFTER the index is written. Verification must not depend on
    // a file the index deliberately does not cover.
    writeFileSync(verdict, '{"verdict":"usable"}\n', "utf8");
    const result = verifyIndex(dir, { indexName: INDEX_NAME });

    assert.equal(
      result.ok,
      true,
      `a rewritten verdict must not fail the payload index; got: ${JSON.stringify(result.mismatches)}`
    );
    assert.equal(result.entries.length, 1);
  });

  it("writes atomically after the payloads are finalized and leaves no temp file", () => {
    const root = makeRoot("atomic");
    const dir = join(root, "artifacts");
    mkdirSync(join(dir, "run3"), { recursive: true });
    writeFileSync(join(dir, "run3", "events.jsonl"), "{}\n", "utf8");
    const { entries } = buildIndex(dir, { indexName: INDEX_NAME });

    const written = writeIndexAtomic(dir, entries, { indexName: INDEX_NAME });

    assert.ok(existsSync(written.path), "the index must exist after the write");
    assert.ok(
      !existsSync(`${written.path}.tmp`),
      `no temp file may survive; got: ${JSON.stringify(readdirSync(dir))}`
    );
    const body = readFileSync(written.path, "utf8");
    assert.ok(
      body.includes("run3/events.jsonl"),
      `the index must carry the payloads; got: ${body}`
    );
  });

  it("verifies digest and size on readback", () => {
    const root = makeRoot("verify");
    const dir = join(root, "artifacts");
    mkdirSync(join(dir, "run3"), { recursive: true });
    writeFileSync(
      join(dir, "run3", "rss.csv"),
      "t_rel_s,vmrss_kb\n60.0,192480\n",
      "utf8"
    );
    const { entries } = buildIndex(dir, { indexName: INDEX_NAME });
    writeIndexAtomic(dir, entries, { indexName: INDEX_NAME });

    const ok = verifyIndex(dir, { indexName: INDEX_NAME });
    assert.equal(
      ok.ok,
      true,
      `a fresh index must verify; got: ${JSON.stringify(ok)}`
    );
    assert.equal(ok.entries.length, 1);
    const payload = readFileSync(join(dir, "run3", "rss.csv"));
    assert.equal(
      ok.entries[0]?.sha256,
      createHash("sha256").update(payload).digest("hex")
    );
    assert.equal(ok.entries[0]?.sizeBytes, payload.length);
  });

  it("reports a payload mutated after the index was written", () => {
    const root = makeRoot("mutated");
    const dir = join(root, "artifacts");
    mkdirSync(join(dir, "run3"), { recursive: true });
    const payload = join(dir, "run3", "rss.csv");
    writeFileSync(payload, "t_rel_s\n60.0\n", "utf8");
    const { entries } = buildIndex(dir, { indexName: INDEX_NAME });
    writeIndexAtomic(dir, entries, { indexName: INDEX_NAME });
    writeFileSync(payload, "t_rel_s\n60.0\n61.0\n", "utf8");

    const result = verifyIndex(dir, { indexName: INDEX_NAME });

    assert.equal(result.ok, false, "a mutated payload must fail verification");
    assert.equal(
      result.mismatches.length,
      2,
      `a mutated payload trips BOTH the digest and the size check; got: ${JSON.stringify(result.mismatches)}`
    );
    assert.ok(
      result.mismatches.every((m) => m.includes("run3/rss.csv")),
      `every mismatch must name the payload; got: ${JSON.stringify(result.mismatches)}`
    );
  });

  it("reports a missing index as a failure, not as an empty verified set", () => {
    const dir = makeRoot("noindex");

    const result = verifyIndex(dir, { indexName: INDEX_NAME });

    assert.equal(result.ok, false);
    assert.ok(
      result.mismatches.some((m) => /index/.test(m)),
      `expected a complaint about the missing index; got: ${JSON.stringify(result.mismatches)}`
    );
  });
});
