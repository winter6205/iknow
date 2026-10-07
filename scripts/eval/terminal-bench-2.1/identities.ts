/**
 * Run identity: the single record that says WHICH instrument produced a result.
 *
 * Why it exists (issue 1219): the superseded #1212 `preflight.env` and `wiring.env` wrote
 * only `task` and `image`. A stale `EXCLUDE:oracle-or-grader` record for `db-wal-recovery`
 * was therefore indistinguishable from a fresh successful retry, and the pilot driver
 * copied whichever `OK:`-looking string it happened to read. Every artifact this tooling
 * retains is bound to one of these identities, and a mismatch REJECTS the artifact —
 * the verdict string never rescues it.
 *
 * Pure: no filesystem, no subprocess. Every comparison is a total function so callers
 * cannot accidentally treat "unknown" as "match".
 */

/** The identity fields a preflight / wiring / attempt record must carry to be usable. */
export interface RunIdentity {
  readonly runId: string;
  readonly task: string;
  readonly image: string;
  /** Immutable image content digest; a mutable tag is not an identity. */
  readonly imageDigest: string;
  readonly datasetCommit: string;
  readonly bundleSha256: string;
  readonly nodeArchiveSha256: string;
  readonly runnerVersion: string;
  readonly outputLayout: string;
}

export interface IdentityComparison {
  readonly fresh: boolean;
  readonly mismatches: ReadonlyArray<keyof RunIdentity>;
}

/**
 * Field order is fixed so a mismatch list is deterministic and diffable in a report.
 * `image` is included deliberately: an image name change with an unchanged digest still
 * means the runner's `-v` mounts were built for a different tag.
 */
export const IDENTITY_FIELDS: ReadonlyArray<keyof RunIdentity> = [
  "runId",
  "task",
  "image",
  "imageDigest",
  "datasetCommit",
  "bundleSha256",
  "nodeArchiveSha256",
  "runnerVersion",
  "outputLayout",
];

/**
 * Machine-specific defaults inherited from the #1212 scripts. Any of these appearing in
 * a config value means the value was never explicitly provided, so the run must refuse
 * to start rather than silently reading one operator's home directory.
 */
const PLACEHOLDER_EXACT = new Set([
  "/home/winner/eval-1189/dataset",
  "/home/winner/eval-1189/bundle/iknow-bundle-9fa88f57.tgz",
  "/home/winner/eval-1212/prov/node.tar.gz",
  "/home/winner/.iknow/settings.json",
]);

/** True when a value is absent, blank, or one of the inherited machine defaults. */
export function isPlaceholder(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  if (trimmed === "") return true;
  return PLACEHOLDER_EXACT.has(trimmed);
}

/** Every identity field still holding a placeholder, in `IDENTITY_FIELDS` order. */
export function findPlaceholderFields(
  identity: RunIdentity
): ReadonlyArray<keyof RunIdentity> {
  return IDENTITY_FIELDS.filter((field) => isPlaceholder(identity[field]));
}

/** A real registry content digest: `sha256:` and 64 hex characters, and nothing else. */
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * True when the value is a usable image content digest.
 *
 * "Usable" is deliberately strict: a short fixture string (`sha256:aaa111`) or the smoke's own
 * declared gap (`sha256:unresolved-local-tag:…`) cannot pin anything, and treating either as a
 * digest would let a mutable tag run behind a record that claims an immutable identity.
 */
export function isUsableImageDigest(value: unknown): boolean {
  return typeof value === "string" && IMAGE_DIGEST.test(value.trim());
}

/**
 * The image reference `docker run` must be given: content-addressed, never the bare tag.
 *
 * Returns `null` when the identity carries no usable digest — the caller then decides what an
 * unpinned image means for that path, rather than silently running a mutable tag under an
 * identity that says otherwise.
 */
export function pinnedImageRef(identity: RunIdentity): string | null {
  const digest = identity.imageDigest.trim();
  return isUsableImageDigest(digest) ? `${identity.image}@${digest}` : null;
}

/**
 * Compare a retained record's identity against the manifest's expected identity.
 *
 * An absent or non-string field counts as a mismatch: a record that never recorded an
 * identity cannot prove it describes the current instrument.
 */
export function compareIdentities(
  expected: RunIdentity,
  actual: RunIdentity | Partial<RunIdentity> | null | undefined
): IdentityComparison {
  if (actual === null || actual === undefined) {
    return { fresh: false, mismatches: [...IDENTITY_FIELDS] };
  }
  const mismatches = IDENTITY_FIELDS.filter((field) => {
    const value = actual[field];
    return typeof value !== "string" || value !== expected[field];
  });
  return { fresh: mismatches.length === 0, mismatches };
}
