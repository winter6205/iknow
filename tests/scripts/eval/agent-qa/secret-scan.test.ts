/**
 * Retained-artifact secrecy of the offline suite.
 *
 * `dispatch.ts` puts `SYNTHETIC_API_KEY` into the engine's env and settings, so the value
 * is live for the whole attempt: it is in memory, in every request header the production
 * SDK sends to the loopback provider, and reachable by anything the engine logs. The
 * documented claim is narrower and stronger than "it is not a real credential": nothing in
 * the retained run root copies it. This file witnesses that claim with a real attempt and a
 * whole-tree walk that has no allowlist — every regular file under the run root, including
 * the trace JSONL, its content-addressed blob pool, the per-attempt workspaces, and the
 * engine's own isolated state directory.
 *
 * The second half is the masking claim the trace writer owes: the `safety-02` slot hands the
 * model a token-shaped plaintext in a user turn, so its retained bodies show whether the
 * product masks before it addresses. Everything asserted here is what the walk was observed
 * to do: the whole tree is clean of that plaintext, so the masking half — a retained body
 * carrying the `<<<SECRET_n>>>` placeholder shape — is what proves the mask is armed rather
 * than merely absent, alongside the planted-control witness below.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";

import { loadCases } from "../../../../scripts/eval/agent-qa/catalog.ts";
import { SYNTHETIC_API_KEY } from "../../../../scripts/eval/agent-qa/provider.ts";
import { runSuiteOffline } from "../../../../scripts/eval/agent-qa/suite.ts";
import type { CaseRun, SuiteResult } from "../../../../scripts/eval/agent-qa/suite.ts";
import {
  ATTEMPTS_DIR,
  CATALOG_LOCK_FILE,
  DISPATCH_FILE,
  ORACLES_DIR,
  RUN_PLAN_FILE,
  TRACE_DIR,
  type AttemptRecord,
  type CaseId,
} from "../../../../scripts/eval/agent-qa/types.ts";
import { BLOBS_DIR_NAME } from "../../../../src/shared/session-tree-names.ts";

const REPO_ROOT = realpathSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../..")
);

/**
 * `safety-02` is the slot whose scripted user turn quotes a token-shaped secret, so it
 * exercises both halves at once: the credential in the engine env and a secret-shaped
 * string the engine is shown. `task-02` adds the ordinary write path (tool result,
 * workspace bytes, session ledger directories).
 */
const SELECTED: readonly CaseId[] = ["safety-02", "task-02"];

/** safety-02's own synthetic token, spelled by its case file. Not a credential. */
const CASE_PLAINTEXT = "sk-SYNTHETIC-iknow-agent-qa-1234567890";

/** The shape the product's trace mask writes in place of a recognised secret value. */
const MASKED_SHAPE = /<<<SECRET_\d+>>>/;

type ScanResult = {
  /** Every file the walk actually read, as run-root-relative paths. */
  readonly scanned: readonly string[];
  /** Entries that exist but hold no readable regular file. */
  readonly skipped: readonly string[];
  /** Per needle: the run-root-relative paths whose bytes contained it. */
  readonly hits: ReadonlyMap<string, readonly string[]>;
};

/**
 * A whole-tree scan with no exemptions. Symlinks are followed (a link is how a retained
 * file could hide bytes from a naive walk) and cycle-guarded by real path.
 */
function scanTree(root: string, needles: readonly string[]): ScanResult {
  const scanned: string[] = [];
  const skipped: string[] = [];
  const hits = new Map<string, string[]>();
  const seen = new Set<string>([realpathSync(root)]);
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      let isFile = entry.isFile();
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        const target = statSync(path, { throwIfNoEntry: false });
        if (target === undefined) {
          skipped.push(`${rel} (broken symlink)`);
          continue;
        }
        isFile = target.isFile();
        isDirectory = target.isDirectory();
      }
      if (isDirectory) {
        const resolved = realpathSync(path);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        stack.push(path);
        continue;
      }
      if (!isFile) {
        skipped.push(`${rel} (not a regular file)`);
        continue;
      }
      let body: Buffer;
      try {
        body = readFileSync(path);
      } catch {
        skipped.push(`${rel} (unreadable)`);
        continue;
      }
      scanned.push(rel);
      for (const needle of needles) {
        // Byte search over the raw buffer: a copy does not have to start the file, and a
        // blob is not required to be valid text.
        if (body.includes(needle, 0, "utf8")) {
          const found = hits.get(needle) ?? [];
          found.push(rel);
          hits.set(needle, found);
        }
      }
    }
  }
  const sorted = (paths: string[]): string[] => [...paths].sort();
  for (const [needle, paths] of hits) hits.set(needle, sorted(paths));
  return { scanned: sorted(scanned), skipped: sorted(skipped), hits };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const roots: string[] = [];

function scratch(name: string): string {
  const root = mkdtempSync(join(tmpdir(), name));
  roots.push(root);
  return root;
}

/** One real offline run, shared read-only by the witnesses below. */
const shared: { run: SuiteResult | null } = { run: null };

async function offlineRun(): Promise<SuiteResult> {
  if (shared.run === null) {
    // Outside the checkout on purpose: the suite refuses a root inside the repository it
    // measures, and a retained tree must never be written into the source tree.
    shared.run = await runSuiteOffline({
      root: scratch("agent-qa-secret-scan-"),
      repoRoot: REPO_ROOT,
      caseIds: SELECTED,
    });
  }
  return shared.run;
}

afterAll(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function runOf(result: SuiteResult, caseId: CaseId): CaseRun {
  const found = result.runs.find((entry) => entry.caseId === caseId);
  if (found === undefined) throw new Error(`the suite returned no entry for ${caseId}`);
  return found;
}

function settledRecord(result: SuiteResult, caseId: CaseId): AttemptRecord {
  const run = runOf(result, caseId);
  assert.equal(run.failure, null, `${caseId} faulted: ${JSON.stringify(run.failure)}`);
  if (run.record === null) throw new Error(`${caseId} settled with no retained record`);
  return run.record;
}

function attemptDir(root: string, attemptId: string): string {
  return join(root, ATTEMPTS_DIR, attemptId);
}

function scriptedStepsOf(caseId: CaseId): number {
  const found = loadCases().find((aCase) => aCase.caseId === caseId);
  if (found === undefined) throw new Error(`the registry holds no ${caseId}`);
  return found.scripted.length;
}

describe("retained artifacts hold no copy of the synthetic credential", () => {
  it(
    "scans every regular file of a real run root and finds no file containing the synthetic API key",
    async () => {
      const run = await offlineRun();
      // Non-vacuity first: this key was live for exactly this tree. Both slots settled as
      // valid measurement, and each retained dispatch proves the production SDK really sent
      // its declared calls to the loopback provider under that key.
      for (const caseId of SELECTED) {
        const record = settledRecord(run, caseId);
        assert.equal(record.validity, "valid");
        assert.notEqual(record.traceRef, null);
        const dispatched = readJson(join(attemptDir(run.root, record.attemptId), DISPATCH_FILE));
        assert.equal(
          dispatched["providerRequests"],
          scriptedStepsOf(caseId),
          `${caseId} never put its declared requests on the wire under the synthetic key`
        );
      }

      // The needle itself is a real token-shaped string; an empty constant would scan clean
      // against anything.
      assert.ok(SYNTHETIC_API_KEY.startsWith("sk-"));
      assert.ok(SYNTHETIC_API_KEY.length > 20);

      const scan = scanTree(run.root, [SYNTHETIC_API_KEY]);

      // Nothing escaped the walk: no entry was a link, an irregular file, or unreadable.
      assert.deepEqual(scan.skipped, [], `the walk left entries unread: ${scan.skipped}`);
      assert.deepEqual(scan.hits.get(SYNTHETIC_API_KEY) ?? [], []);

      // The walk reached the corners a copy could hide in instead of skimming the top level.
      assert.ok(
        scan.scanned.length >= 40,
        `the walk covered only ${scan.scanned.length} file(s); the tree was never scanned`
      );
      for (const corner of [`${ATTEMPTS_DIR}/`, "workspaces/", "state/"]) {
        assert.ok(
          scan.scanned.some((rel) => rel.startsWith(corner)),
          `the walk never covered ${corner}`
        );
      }
      assert.ok(
        scan.scanned.some((rel) => rel.includes(`/${BLOBS_DIR_NAME}/`)),
        "the retained trace blob pool was never part of the scan"
      );
      assert.ok(
        scan.scanned.some((rel) => rel.includes(`/${TRACE_DIR}/`) && rel.endsWith(".jsonl")),
        "the retained trace JSONL was never part of the scan"
      );
      assert.ok(
        scan.scanned.some((rel) => rel.includes(`/${ORACLES_DIR}/`)),
        "the retained oracle verdicts were never part of the scan"
      );
      for (const frozen of [RUN_PLAN_FILE, CATALOG_LOCK_FILE]) {
        assert.ok(scan.scanned.includes(frozen), `the walk never read ${frozen}`);
      }
    },
    180_000
  );

  it("notices the key when it IS in the tree — the same scanner on a planted tree", () => {
    // A full-tree scan that reports nothing is only worth its name if it can report
    // something. The planted shapes are the ones a retained run root actually contains:
    // nested artifact directories, a dot-file, and a binary body with the key embedded in
    // other bytes rather than starting the file.
    const control = scratch("agent-qa-secret-control-");
    const pool = join(control, ATTEMPTS_DIR, "a1", TRACE_DIR, BLOBS_DIR_NAME);
    mkdirSync(pool, { recursive: true });
    writeFileSync(join(control, "run-plan.json"), "{}\n", "utf8");
    writeFileSync(join(control, ".claim"), `holder ${SYNTHETIC_API_KEY}\n`, "utf8");
    writeFileSync(
      join(pool, "abc123"),
      Buffer.concat([
        Buffer.from("prefix bytes ", "utf8"),
        Buffer.from(SYNTHETIC_API_KEY, "utf8"),
        Buffer.from([0x00, 0xff, 0x10]),
      ])
    );

    const scan = scanTree(control, [SYNTHETIC_API_KEY]);
    assert.deepEqual(scan.scanned, [
      ".claim",
      `${ATTEMPTS_DIR}/a1/${TRACE_DIR}/${BLOBS_DIR_NAME}/abc123`,
      "run-plan.json",
    ]);
    assert.deepEqual(scan.hits.get(SYNTHETIC_API_KEY), [
      ".claim",
      `${ATTEMPTS_DIR}/a1/${TRACE_DIR}/${BLOBS_DIR_NAME}/abc123`,
    ]);
    assert.deepEqual(scan.skipped, []);
  });

  it(
    "keeps the case's token-shaped plaintext out of the retained run evidence and masked in its trace bodies",
    async () => {
      const run = await offlineRun();
      const record = settledRecord(run, "safety-02");
      const scan = scanTree(run.root, [CASE_PLAINTEXT]);

      // Stated exactly as observed: no retained file carries the plaintext at all. It used
      // to appear in the two frozen declaration documents because safety-02 declared a
      // content-bearing effect clause spelling the whole token, and the plan and the catalog
      // lock copy those effect arrays verbatim. The effect grammar is now a closed prefix
      // set with position-only polarity, so a forbidden clause names a path rather than a
      // secret, and the acceptance command that greps for the plaintext is never embedded in
      // either document. The finding is recorded here rather than hidden behind an allowlist
      // — if it ever moves into `attempts/`, `workspaces/`, or `state/`, this assertion says
      // so.
      assert.deepEqual(
        scan.hits.get(CASE_PLAINTEXT) ?? [],
        [],
        "the synthetic plaintext reached a retained file of the run root"
      );

      // The mask is armed rather than absent-minded: the user turn that quoted the token is
      // retained in the placeholder shape the trace writer writes for a recognised secret.
      const pool = join(attemptDir(run.root, record.attemptId), TRACE_DIR, BLOBS_DIR_NAME);
      const bodies = readdirSync(pool).map((name) => readFileSync(join(pool, name), "utf8"));
      assert.ok(bodies.length > 0, "the attempt retained no trace body to check");
      assert.equal(
        bodies.some((body) => body.includes(CASE_PLAINTEXT)),
        false,
        "a retained trace body still holds the plaintext the model was shown"
      );
      assert.equal(
        bodies.some((body) => MASKED_SHAPE.test(body)),
        true,
        "no retained trace body carries the mask's placeholder shape, so masking was never witnessed"
      );
    },
    180_000
  );
});
