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
 * UNRESOLVED TEMPLATE — what this module means by "a placeholder" since issue 1219.
 *
 * A value is an unresolved template when its trimmed text still carries a substitution or a
 * marker that NOTHING in this pipeline expands:
 *
 *  - `${VAR}` / `$VAR`: an unexpanded shell-style variable. Deliberately the same VAR-name
 *    charset `src/config/settings.ts` `PLACEHOLDER_PATTERN` uses, so the two definitions
 *    cannot drift into disagreeing about what an unexpanded variable looks like.
 *  - `{{name}}`: an unexpanded mustache/handlebars slot.
 *  - a whole `/`-separated segment that IS `TODO`, `FIXME`, `CHANGEME`, `TBD` or `XXX`
 *    (case-insensitive) — a placeholder somebody left behind rather than filled in.
 *
 * WHAT WAS REMOVED, AND WHY (issue 1219 / the #1221 headless audit). This used to hold a
 * blocklist of four literal host paths — the #1189/#1212 machine defaults — and `config.ts`
 * applied it to every path parameter. That made the CLI unsatisfiable: `cli.ts` REQUIRES all
 * four as mandatory explicit flags, and `main` calls `resolveConfig` BEFORE creating the run
 * root, wiring Docker or dispatching a model, so the frozen #1221 run could only ever exit 1
 * with four "still a placeholder" lines naming real, existing artifacts the operator had
 * supplied by hand. Equality with a historical example is not evidence that anything was left
 * unset, so those literals are now real values. `isInheritedDefaultLiteral` keeps the
 * historical distinction available for a caller that WANTS to report it, without making valid
 * configuration unusable.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *  - A literal trailing `~`. Nothing in this tooling expands or normalizes `~`, so treating it
 *    as unresolved would invent a rule the code does not actually have.
 *  - Angle brackets. `outputLayout` legitimately IS a layout template — the frozen #1221
 *    protocol manifest carries `tb2.1-slot-v1/<task>:<arm>:<maxTurns>` — so `<…>` is a PATH
 *    rule, not an identity rule. See `isUnresolvedPathTemplate`.
 *
 * Existence and type of an artifact are NOT decided here: this module is pure, and a missing
 * bundle tarball is a preflight/provisioning fact, not an input-shape fact.
 */
const UNRESOLVED_TEMPLATE =
  /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\{\{[^{}]*\}\}|^(?:.*\/)?(?:TODO|FIXME|CHANGEME|TBD|XXX)(?:\/.*)?$/i;

/**
 * The #1212/#1189 machine-specific path defaults. DIAGNOSTIC ONLY.
 *
 * Exported so a report or an audit can say "this run was pointed at the literal the old
 * scripts hardcoded" without that observation being able to REFUSE anything. Nothing in
 * configuration resolution consults it; `isPlaceholder` deliberately does not.
 */
export const HISTORICAL_DEFAULT_LITERALS: ReadonlySet<string> = new Set([
  "/home/winner/eval-1189/dataset",
  "/home/winner/eval-1189/bundle/iknow-bundle-9fa88f57.tgz",
  "/home/winner/eval-1212/prov/node.tar.gz",
  "/home/winner/.iknow/settings.json",
]);

/**
 * True when a value is one of the historical machine defaults. Diagnostic, NOT a validity
 * check: every one of these is a real artifact an operator may legitimately name.
 */
export function isInheritedDefaultLiteral(value: unknown): boolean {
  return (
    typeof value === "string" && HISTORICAL_DEFAULT_LITERALS.has(value.trim())
  );
}

/**
 * True when a value is absent, blank, or an unresolved template (see `UNRESOLVED_TEMPLATE`).
 *
 * Applies to EVERY config value and every identity field, so a shas, a run id or an OCI
 * reference carrying an unexpanded substitution is refused exactly as a path would be.
 */
export function isPlaceholder(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  if (trimmed === "") return true;
  return UNRESOLVED_TEMPLATE.test(trimmed);
}

/**
 * `<…>`: an angle-bracket placeholder such as `<path>` or `<dataset-root>`. A PATH-only rule.
 *
 * Split out from `isPlaceholder` because a layout template is legitimately built from angle
 * brackets — `tb2.1-slot-v1/<task>:<arm>:<maxTurns>` is the frozen #1221 `outputLayout` —
 * while no real filesystem path contains one.
 */
const ANGLE_PLACEHOLDER = /<[^<>\s]+>/;

/**
 * True when a PATH parameter is absent, blank, an unresolved template, or an angle-bracket
 * placeholder. This is the predicate `config.ts` applies to every path it is given.
 */
export function isUnresolvedPathTemplate(value: unknown): boolean {
  if (isPlaceholder(value)) return true;
  return ANGLE_PLACEHOLDER.test((value as string).trim());
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
