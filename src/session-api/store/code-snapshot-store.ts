/**
 * Content-addressed preimage blob store for one session folder (ADR-0036).
 *
 * The session's `code-snapshots/` directory holds raw byte blobs named by
 * their sha256 hex. Capture is write-if-missing (`flag:"wx"`): two identical
 * byte-contents collapse to one blob, so a repeated capture returns the same
 * sha without rewriting. The read side (`readCodeSnapshot`) is consumed by the
 * rewind/restore layer; it throws a typed `{ kind:"code_snapshot_missing" }`
 * rather than a bare ENOENT so the caller can distinguish "blob absent" from a
 * real IO fault (the typed-error catch contract in code-quality.md).
 *
 * Pure filesystem IO over an already-resolved `sessionFolder`; path derivation
 * from a conversationId stays in session-store.ts so this module cannot be fed
 * an unsanitized segment.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CODE_SNAPSHOTS_DIR_NAME } from "../../shared/session-tree-names.js";

/** Typed read failure: the named blob is absent for this session folder. */
export type CodeSnapshotError = { kind: "code_snapshot_missing"; sha: string };

/** `<sessionFolder>/code-snapshots/` — the blob directory SSOT. */
export function codeSnapshotDir(sessionFolder: string): string {
  return join(sessionFolder, CODE_SNAPSHOTS_DIR_NAME);
}

/** sha256 hex of the raw bytes — the blob's content address / filename. */
export function codeSnapshotSha(bytes: Buffer | string): string {
  return createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes)
    .digest("hex");
}

/**
 * Write `bytes` as a content-addressed blob, returning its sha256 hex.
 * Existing blobs are left untouched (dedup): an `EEXIST` on the exclusive
 * write is the normal second-capture path, not a failure.
 */
export async function captureCodeSnapshot(
  sessionFolder: string,
  bytes: Buffer | string
): Promise<string> {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const sha = codeSnapshotSha(buf);
  const dir = codeSnapshotDir(sessionFolder);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, sha), buf, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return sha;
    throw err;
  }
  return sha;
}

/**
 * Read a previously captured blob. Missing blob → typed
 * `{ kind:"code_snapshot_missing", sha }`; any other failure propagates so the
 * caller never mistakes an IO fault for an absent preimage.
 */
export async function readCodeSnapshot(
  sessionFolder: string,
  sha: string
): Promise<Buffer> {
  try {
    return await readFile(join(codeSnapshotDir(sessionFolder), sha));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw { kind: "code_snapshot_missing", sha } satisfies CodeSnapshotError;
    }
    throw err;
  }
}
