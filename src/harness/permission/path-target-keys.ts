/**
 * src/harness/permission/path-target-keys.ts
 *
 * The ONE roster of input fields a tool call may declare its path target under.
 * Two readers with unrelated verdicts consume it — `hard-walls.ts`
 * (`getPathLikeString`: "is this a protected target") and `policy.ts`
 * (`writeTargetOf`: "is this a write the current fs tier cannot reach") — and
 * the KEY LIST cannot be a second copy in either of them.
 *
 * The failure that forbids the copy: a tool declaring its target under a key
 * the hard wall reads and this list omits is DENIED by the wall while SILENTLY
 * escaping the ADR-0140 boundary ask. Two readers, one roster.
 *
 * The ACCESSORS stay separate, and for the reason that is not about this list:
 * they answer different questions over different vocabularies, and sharing one
 * would couple two verdicts that must be able to diverge in scope (a call that
 * derives its own target declares none here and is fenced, not asked).
 *
 * A leaf by layering: it imports nothing, so neither reader gains an edge. It
 * lives under `permission/` because `sandbox/` imports `permission/` and never
 * the reverse (see `FsBoundaryReader` in `policy.ts`).
 */
export const PATH_TARGET_KEYS: ReadonlyArray<string> = Object.freeze([
  "path",
  "file",
  "filepath",
  "target",
]);
