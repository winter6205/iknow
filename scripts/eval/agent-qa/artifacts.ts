/**
 * Artifact lifecycle for the agent-qa capability: write-once JSON, fsynced JSONL,
 * digest-verified reads, a directory hash index, and kernel-decided claims.
 *
 * The three read faults that matter are kept separate on purpose: absent, unreadable
 * and corrupt are different facts, and collapsing any pair of them is how "we could not
 * look" turns into a confident verdict.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { DIGEST_PATTERN, HASH_INDEX_FILE } from "./types.ts";
import {
  ArtifactFailure,
  ClaimFailure,
  ioFailure,
  isEvalFailure,
  type EvalFailure,
  type FailurePhase,
} from "./failures.ts";

/** Index format version; a reader must refuse an index it cannot interpret. */
export const HASH_INDEX_VERSION = 1;

export type HashIndexEntries = Readonly<Record<string, string>>;

export type JsonArtifact = {
  readonly value: unknown;
  readonly digest: string;
};

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

/**
 * A filesystem fault must never leave the capability as a bare errno, but an already
 * typed failure must not be re-wrapped either: the kind it carries is the verdict.
 */
function typed(
  error: unknown,
  phase: FailurePhase,
  subject: string,
  attemptId?: string
): EvalFailure {
  if (isEvalFailure(error)) return error;
  return ioFailure(error, phase, subject, attemptId);
}

/**
 * ENOENT is the only errno that means "nothing is here". Everything else means the
 * bytes are unknown, which is a fault, not an absence.
 */
function classifyReadFault(path: string, error: unknown): EvalFailure {
  if (errnoCode(error) === "ENOENT") {
    return new ArtifactFailure(
      "missing-reference",
      "artifact-read",
      `${path} is absent`
    );
  }
  return ioFailure(error, "artifact-read", `read of ${path}`);
}

export function sha256File(path: string): string {
  try {
    return digestOf(readFileSync(path));
  } catch (error) {
    // EXIT: bytes cannot be read — absent stays missing-reference, a fault stays io-failure; nothing to clean; dispatch may not continue.
    throw classifyReadFault(path, error);
  }
}

function serialize(value: unknown, path: string): string {
  try {
    return `${JSON.stringify(value)}\n`;
  } catch {
    // EXIT: value cannot cross JSON (circular or bare bigint) — the file is never opened, so no partial artifact exists; dispatch may not continue.
    throw new ArtifactFailure(
      "artifact-write",
      "artifact-write",
      `value for ${path} is not JSON-serializable`
    );
  }
}

/**
 * Create a file exclusively. O_EXCL is the load-bearing part: an existing artifact is
 * refused by the kernel at open time, so no reader can ever observe an overwritten
 * artifact and two writers cannot both believe they won.
 */
export function writeJsonOnce(
  path: string,
  value: unknown,
  opts: { attemptId?: string } = {}
): string {
  const body = serialize(value, path);
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      // EXIT: artifact already exists and is never overwritten — existing bytes stay as they are; dispatch may not continue.
      throw new ArtifactFailure(
        "artifact-write",
        "artifact-write",
        `${path} already exists; artifacts are write-once`,
        opts.attemptId
      );
    }
    // EXIT: the artifact could not be created — errno only, no contents; nothing to clean; dispatch may not continue.
    throw ioFailure(
      error,
      "artifact-write",
      `create of ${path}`,
      opts.attemptId
    );
  }
  try {
    const written = writeSync(fd, body, null, "utf8");
    if (written !== Buffer.byteLength(body)) {
      // EXIT: short write — the torn file is retained as evidence of the attempt rather than deleted; dispatch may not continue.
      throw new ArtifactFailure(
        "artifact-write",
        "artifact-write",
        `${path} held a short write (${written}/${Buffer.byteLength(body)} bytes)`,
        opts.attemptId
      );
    }
    fsyncSync(fd);
  } catch (error) {
    // EXIT: write or fsync failed — durable-proof is lost, so the artifact cannot be claimed; dispatch may not continue.
    throw typed(error, "artifact-write", `write of ${path}`);
  } finally {
    closeSync(fd);
  }
  return digestOf(Buffer.from(body, "utf8"));
}

/** Append one JSONL record and fsync it, so a killed driver leaves whole lines only. */
export function appendLineFsync(path: string, value: unknown): void {
  const body = serialize(value, path);
  try {
    appendFileSync(path, body, "utf8");
  } catch (error) {
    // EXIT: append failed — whatever was durable before stays durable; dispatch may not continue.
    throw ioFailure(error, "artifact-write", `append to ${path}`);
  }
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    // EXIT: appended bytes cannot be re-opened for fsync, so durability is unproven; dispatch may not continue.
    throw ioFailure(error, "artifact-write", `fsync of ${path}`);
  }
  try {
    fsyncSync(fd);
  } catch (error) {
    // EXIT: fsync refused — the record exists but is not proven durable; dispatch may not continue.
    throw ioFailure(error, "artifact-write", `fsync of ${path}`);
  } finally {
    closeSync(fd);
  }
}

export function readJsonArtifact(
  path: string,
  expectedDigest?: string
): JsonArtifact {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    // EXIT: artifact unreadable — absent and fault stay distinguishable; nothing to clean; dispatch may not continue.
    throw classifyReadFault(path, error);
  }
  const digest = digestOf(bytes);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    // EXIT: bytes do not parse — corruption is the more specific fault than a digest complaint; dispatch may not continue.
    throw new ArtifactFailure(
      "artifact-corrupt",
      "artifact-read",
      `${path} does not parse as JSON (${bytes.length} byte(s))`
    );
  }
  if (expectedDigest !== undefined && expectedDigest !== digest) {
    // EXIT: the bytes are not the bytes the caller froze — the reference is stale; dispatch may not continue.
    throw new ArtifactFailure(
      "stale-digest",
      "artifact-read",
      `${path} digest does not match the expected digest`
    );
  }
  return { value, digest };
}

/** An index never hashes an index: self-hashing is what makes a hash index unverifiable. */
function isIndexName(name: string): boolean {
  return name === HASH_INDEX_FILE || name.startsWith(`${HASH_INDEX_FILE}.`);
}

function visitFiles(
  dir: string,
  base: string,
  out: string[],
  phase: FailurePhase
): void {
  for (const name of readdirSync(dir).sort()) {
    if (isIndexName(name)) continue;
    const rel = base === "" ? name : `${base}/${name}`;
    // lstat, not stat: a symlink is refused rather than followed, so an index can never be
    // pointed at bytes outside the artifact root it claims to describe.
    const stats = lstatSync(join(dir, name));
    if (stats.isDirectory()) {
      visitFiles(join(dir, name), rel, out, phase);
      continue;
    }
    if (!stats.isFile()) {
      // EXIT: a non-regular entry (symlink, socket, fifo, device) has no stable bytes inside the root to index; dispatch may not continue.
      throw new ArtifactFailure(
        "artifact-corrupt",
        phase,
        `${rel} under ${dir} is not a regular file`
      );
    }
    out.push(rel);
  }
}

function listFiles(dir: string, phase: FailurePhase): string[] {
  const out: string[] = [];
  try {
    visitFiles(dir, "", out, phase);
  } catch (error) {
    // EXIT: the directory cannot be walked — a partial roster is never reported as a complete one; dispatch may not continue.
    throw typed(error, phase, `listing of ${dir}`);
  }
  return out;
}

function buildEntries(dir: string, phase: FailurePhase): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const rel of listFiles(dir, phase)) {
    try {
      entries[rel] = digestOf(readFileSync(join(dir, rel)));
    } catch (error) {
      // EXIT: an indexed file cannot be read — digest unknown, so the index cannot be written; dispatch may not continue.
      throw typed(error, phase, `digest of ${rel}`);
    }
  }
  return entries;
}

function dropStaleTemp(tempPath: string): void {
  try {
    unlinkSync(tempPath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    // EXIT: a previous temp index cannot be removed, so publishing would be ambiguous; dispatch may not continue.
    throw typed(error, "artifact-write", `remove of ${tempPath}`);
  }
}

/**
 * Publish the digest of every regular file under `dir`, keyed by relative path.
 *
 * The index is a derived view of the artifacts, not evidence itself, so it is rewritten
 * through a temp name and rename instead of being write-once: refreshing a manifest
 * destroys nothing, while the artifacts it names stay immutable.
 */
export function writeHashIndex(dir: string): string {
  const entries = buildEntries(dir, "artifact-write");
  const indexPath = join(dir, HASH_INDEX_FILE);
  const tempPath = `${indexPath}.tmp`;
  dropStaleTemp(tempPath);
  writeJsonOnce(tempPath, { indexVersion: HASH_INDEX_VERSION, entries });
  try {
    renameSync(tempPath, indexPath);
  } catch (error) {
    // EXIT: the temp index exists but was never published — no reader sees it, so the stale index (if any) is still what verifies; dispatch may not continue.
    throw typed(error, "artifact-write", `rename of ${tempPath}`);
  }
  return sha256File(indexPath);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every index-shape fault is the same fact: the manifest itself is the corrupt artifact. */
function corruptIndex(dir: string, problem: string): ArtifactFailure {
  return new ArtifactFailure(
    "artifact-corrupt",
    "artifact-read",
    `index under ${dir} ${problem}`
  );
}

function assertEntryDigests(dir: string, entries: Record<string, unknown>): void {
  for (const [rel, digest] of Object.entries(entries)) {
    if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
      // EXIT: an entry value that is not a hex digest corrupts the manifest itself; dispatch may not continue.
      throw corruptIndex(dir, `carries a non-digest entry for ${rel}`);
    }
  }
}

function parseIndex(value: unknown, dir: string): HashIndexEntries {
  const record: Record<string, unknown> = isPlainRecord(value) ? value : {};
  if (record.indexVersion !== HASH_INDEX_VERSION) {
    // EXIT: a foreign layout would certify the wrong bytes; nothing to clean; dispatch may not continue.
    throw corruptIndex(dir, "has an unsupported indexVersion");
  }
  if (!isPlainRecord(record.entries)) {
    // EXIT: an index without an entries map proves nothing, so it cannot pass; dispatch may not continue.
    throw corruptIndex(dir, "carries no entries map");
  }
  // Each entry digest must be a hex sha256, or the manifest itself is the corrupt artifact.
  assertEntryDigests(dir, record.entries);
  return record.entries as HashIndexEntries;
}

function assertIndexed(dir: string, rel: string, expected: string): void {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(dir, rel));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      // EXIT: an indexed artifact vanished — a missing reference is never a pass; dispatch may not continue.
      throw new ArtifactFailure(
        "missing-reference",
        "artifact-read",
        `${rel} is indexed but absent under ${dir}`
      );
    }
    // EXIT: an indexed artifact cannot be read — a fault, not an absence; dispatch may not continue.
    throw ioFailure(error, "artifact-read", `read of ${rel}`);
  }
  if (digestOf(bytes) !== expected) {
    // EXIT: bytes changed after indexing — the retained evidence is no longer what was frozen; dispatch may not continue.
    throw new ArtifactFailure(
      "artifact-corrupt",
      "artifact-read",
      `${rel} digest does not match the index`
    );
  }
}

export function verifyHashIndex(dir: string): void {
  const entries = parseIndex(
    readJsonArtifact(join(dir, HASH_INDEX_FILE)).value,
    dir
  );
  for (const [rel, expected] of Object.entries(entries)) {
    assertIndexed(dir, rel, expected);
  }
  const extras = listFiles(dir, "artifact-read").filter(
    (rel) => !Object.hasOwn(entries, rel)
  );
  if (extras.length > 0) {
    // EXIT: files exist that the index never named — the directory is no longer the frozen set; dispatch may not continue.
    throw new ArtifactFailure(
      "artifact-corrupt",
      "artifact-read",
      `${dir} holds ${extras.length} unindexed file(s): ${extras.join(", ")}`
    );
  }
}

/**
 * Create a directory the capability owns. An errno here is a fault of this capability,
 * never a bare throw the caller would have to guess an attribution for.
 */
export function makeDir(
  path: string,
  phase: FailurePhase,
  attemptId?: string
): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    // EXIT: the directory was not created and nothing was written into it; the caller's
    // owned resources stay in the hands of its own teardown.
    throw typed(error, phase, `create directory ${path}`, attemptId);
  }
}

/**
 * Reserve an attempt directory with a non-recursive mkdir.
 * Non-recursive is the point: a typo or a missing parent surfaces as a fault instead of
 * silently building a whole new tree the run never declared.
 */
export function reserveDir(path: string, attemptId: string): void {
  try {
    mkdirSync(path);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      // EXIT: the directory is already reserved — it is never reused or overwritten, and nothing new was created; dispatch may not continue.
      throw new ClaimFailure(
        "contended-claim",
        attemptId,
        `${path} is already reserved; refusing to reuse it`
      );
    }
    // EXIT: reservation failed for another reason (missing parent, permission) — no directory was claimed; dispatch may not continue.
    throw ioFailure(error, "claim", `reserve of ${path}`, attemptId);
  }
}

/**
 * Claim a path exclusively and record who holds it. The kernel decides the winner at
 * open time, so two concurrent claimants cannot both proceed.
 */
export function claimFile(path: string, holder: string, attemptId: string): void {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      // EXIT: another holder already claimed the path — the loser writes nothing and must not dispatch; dispatch may not continue.
      throw new ClaimFailure(
        "duplicate-claim",
        attemptId,
        `${path} is already claimed; refusing to share an attempt`
      );
    }
    // EXIT: the claim file could not be created — no claim exists, so nothing may dispatch; dispatch may not continue.
    throw ioFailure(error, "claim", `claim create of ${path}`, attemptId);
  }
  try {
    writeSync(fd, `${holder}\n`, null, "utf8");
    fsyncSync(fd);
  } catch (error) {
    // EXIT: the claim was opened but its holder cannot be persisted — a claim nobody can attribute is not a claim; dispatch may not continue.
    throw ioFailure(error, "claim", `claim write of ${path}`, attemptId);
  } finally {
    closeSync(fd);
  }
}
