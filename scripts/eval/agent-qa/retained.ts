/**
 * The one reader of a retained attempt directory.
 *
 * The lifecycle that writes these bytes and the reporter that rebuilds a run from them both
 * ask here, so "this slot started and never settled" is one derived fact with one signature:
 * an intent record and no hash index, because the index is the last write of a settled
 * attempt. A directory that froze an index and then lost the record it indexed says the
 * opposite — the retained bytes contradict themselves — and is refused, never relabeled as
 * an interruption.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { readJsonArtifact, verifyHashIndex } from "./artifacts.ts";
import { ArtifactFailure, isEvalFailure } from "./failures.ts";
import {
  ATTEMPT_FILE,
  ATTEMPTS_DIR,
  HASH_INDEX_FILE,
  INTENT_FILE,
  REQUIRED_ARTIFACTS,
  type AttemptRecord,
  type EvidenceCoverage,
} from "./types.ts";

export function attemptDirOf(root: string, attemptId: string): string {
  return join(root, ATTEMPTS_DIR, attemptId);
}

/** Which of the named artifacts still resolve. A read fault is unreadable, never absent-and-fine. */
export function coverageOf(dir: string, names: readonly string[]): EvidenceCoverage {
  const readable = names.filter((name) => resolves(join(dir, name)));
  if (readable.length === names.length) return "complete";
  // EXIT: a named required artifact did not resolve — coverage is a lifecycle fact,
  // never a trace-completeness claim; retained bytes stay as they are.
  return readable.length === 0 ? "missing" : "partial";
}

/**
 * Whether one named artifact resolves to a value. The swallowed set is exactly the typed
 * faults a read can raise — `missing-reference`, `io-failure`, `artifact-corrupt`,
 * `stale-digest` — which coverage counts as "did not resolve" without naming which; a
 * throw outside that set is a reader bug, not a coverage fact, so it is not folded away.
 */
function resolves(path: string): boolean {
  try {
    readJsonArtifact(path);
    return true;
  } catch (error) {
    // EXIT: the artifact is uncounted and the count continues over the remaining names;
    // nothing is written or cleaned here, and the caller's dispatch is unaffected.
    if (isEvalFailure(error)) return false;
    throw error;
  }
}

/**
 * A fresh read of the retained attempt. Nothing here re-dispatches or rewrites: the partial
 * bytes are what actually happened, and they are the evidence an interruption is reported on.
 */
export function reconstructAttempt(root: string, attemptId: string): AttemptRecord {
  const dir = attemptDirOf(root, attemptId);
  const settled = join(dir, ATTEMPT_FILE);
  let artifact: unknown;
  try {
    artifact = readJsonArtifact(settled).value;
  } catch (error) {
    if (error instanceof ArtifactFailure && error.kind === "missing-reference") {
      if (existsSync(join(dir, HASH_INDEX_FILE))) {
        // EXIT: the manifest survived while the record it indexes did not, so this directory
        // claims a settlement it cannot show; nothing is rewritten and no verdict is derived.
        throw new ArtifactFailure(
          "missing-reference",
          "artifact-read",
          `${settled} is absent while ${HASH_INDEX_FILE} still indexes it`,
          attemptId
        );
      }
      const intent = readJsonArtifact(join(dir, INTENT_FILE))
        .value as AttemptRecord;
      // EXIT: intent exists, settlement never did — the attempt is interrupted, its
      // partial evidence retained, and nothing here is re-dispatched.
      return {
        ...intent,
        phase: "abandoned",
        outcome: "undetermined",
        validity: "interrupted",
        coverage: coverageOf(dir, REQUIRED_ARTIFACTS),
        cleanup: { status: "unconfirmed", owned: ["attempt-directory"] },
      };
    }
    // EXIT: attempt.json is unreadable or corrupt — a corrupt settlement is never
    // reinterpreted as interrupted; nothing is rewritten.
    throw error;
  }
  // The index is checked only when the directory froze one, and before the record is
  // trusted: a stale digest is a rejected read, not a re-derivation. A directory that
  // carries no manifest makes no verification claim, so nothing here invents one.
  if (existsSync(join(dir, HASH_INDEX_FILE))) verifyHashIndex(dir);
  return artifact as AttemptRecord;
}
