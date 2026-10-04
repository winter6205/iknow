/**
 * Trace-permitted immutable body primitive.
 *
 * The write side; the reference contract itself (`TRACE_BODY_REPRESENTATION`,
 * `TraceBodyRef`, the two gates) is owned by the neutral
 * `src/shared/trace-body-contract.ts` so traceserver can enforce the same
 * gates without importing harness/.
 *
 * The session-local pool physically hosts both masked trace evidence and raw
 * native recovery state, so a reference must carry the authority to read it:
 * `representation` names the transform that produced the bytes, and the sha is
 * the address of those *transformed* bytes. What the reader therefore enforces
 * is a DECLARED-representation gate — a ref whose declared tag is a different,
 * non-trace representation is refused, and the sha gate confines every read to
 * the pool (lowercase 64-hex, so no traversal). Substituting different bytes at
 * an address that already declares the trace tag is out of this contract's
 * scope: the tag lives in the trace row, not in the pool, so a writer that
 * lies about the representation is a trusted-component bug, not something this
 * read path can detect.
 *
 * Masking runs before content addressing on purpose: the address must identify
 * the retained body only, so a trace pool can never be walked back to a secret
 * by brute-forcing candidate preimages.
 *
 * Write-if-missing (`flag: "wx"`): identical masked bodies share one file, and
 * `EEXIST` is the reuse signal rather than a fault. Every other write failure
 * throws so the caller's trace-health path can count it — no retry, no inline
 * substitute, because a reference without a complete retained body is not
 * evidence.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BLOBS_DIR_NAME } from "../../shared/session-tree-names.js";
import {
  TRACE_BODY_REPRESENTATION,
  type TraceBodyRef,
} from "../../shared/trace-body-contract.js";

export {
  TRACE_BODY_REPRESENTATION,
  isTraceBodyRepresentation,
  isTraceBodySha,
} from "../../shared/trace-body-contract.js";
export type { TraceBodyRef } from "../../shared/trace-body-contract.js";

/** The package's single reuse-signal test: only `EEXIST` means "already there". */
function isAlreadyPresentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

/**
 * The one storage primitive of the body pool: mask → content-address →
 * write-if-missing → `{sha, bytes}`. Every trace body of every channel goes
 * through here, so masking-before-addressing, one-address-per-distinct-masked-
 * body and one-file-per-address are properties of this function rather than of
 * each call site.
 *
 * The `mkdirSync` stays outside the reuse branch on purpose: an occupied
 * `blobs/` path is a real fault and must reach the caller's trace-health count
 * instead of being read as a body that is already present.
 */
export function storeMaskedBody(
  poolDir: string,
  text: string,
  mask: (text: string) => string
): { sha: string; bytes: number } {
  const masked = mask(text);
  const sha = createHash("sha256").update(masked, "utf8").digest("hex");
  const blobsDir = join(poolDir, BLOBS_DIR_NAME);
  mkdirSync(blobsDir, { recursive: true });
  try {
    writeFileSync(join(blobsDir, sha), masked, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (!isAlreadyPresentError(error)) throw error;
  }
  return { sha, bytes: Buffer.byteLength(masked, "utf8") };
}

/** Mask → serialize → store; returns the ref. */
export function writeTraceBody(
  poolDir: string,
  value: unknown,
  mask: (text: string) => string
): TraceBodyRef {
  // `?? "null"`: JSON.stringify drops undefined, and a body must never be
  // unaddressable (matches the existing blob-reference path in jsonl.ts).
  const serialized = JSON.stringify(value) ?? "null";
  return {
    ...storeMaskedBody(poolDir, serialized, mask),
    representation: TRACE_BODY_REPRESENTATION,
  };
}
