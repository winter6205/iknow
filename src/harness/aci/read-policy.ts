import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve as resolvePath,
} from "node:path";

import { ToolExecutionError } from "../errors.js";
import { isBoundWorktreeRoot } from "../isolation/worktree-gate.js";
import type { FsModeContext } from "../sandbox/fs-mode.js";
import { FS_ISOLATION_MODE_DEFAULT } from "../sandbox/fs-mode.js";
import { resolveSessionFenceTmp } from "../sandbox/fence-tmp.js";
import { isWithinRoot, resolveWithinRoot } from "./tools/helpers.js";

/**
 * Canonical host-read policy (ADR-0128, specs/host-read-policy.md).
 *
 * Pure value surface owning two decisions for every read-capable ACI tool:
 * (a) which paths a read may reach, given the filesystem mode and the
 * identity roots, and (b) which reached paths are protected credentials.
 * Both modes are broadly readable host views (ADR-0092), so the mode does
 * not fork the read answer; the protected-path roster is what refuses.
 *
 * Outcomes are exactly allow | deny and the policy is fail-closed: any path
 * that cannot be decided — empty, unusable, over-long, unresolvable — is a
 * deny with a typed resolution-failure reason. The matcher never throws and
 * never leaks a raw errno name into a message.
 *
 * Composes with, and does not replace, the realpath-based containment
 * discipline of `tools/helpers.ts` (`resolveWithinRoot`): write containment
 * keeps using that directly; this module owns the *read* answer end to end —
 * the verdict, the containment root-set construction, the arm switch, the
 * shared reach resolution (`resolveReadReach`) and the one shared
 * decide → resolve → decide flow the read tools call (`decideAndResolveRead-
 * Reach`, specs/host-read-policy.md SC6). Still callable with no tool, client,
 * ctx, or session state — it takes the tool's snapshot inputs and returns
 * plain values; the only effect besides filesystem reads is throwing the
 * typed `ToolExecutionError` denial with the calling tool's label.
 */

export type ReadPolicyFsMode = "global" | "workspace";

export interface ReadPolicyRoots {
  /** Anchors relative candidates; identity root, not a reach boundary. */
  readonly taskRoot?: string;
  /** Expands a leading `~`; without it, `~` inputs are undecidable. */
  readonly homeRoot?: string;
}

export type ReadPolicyDenyReason =
  "protected_path" | "resolution_failure" | "out_of_reach";

export interface ReadPolicyAllow {
  readonly outcome: "allow";
  /** The realpath-canonicalized (or deepest-anchor-joined) path. */
  readonly canonicalPath: string;
}

export interface ReadPolicyDeny {
  readonly outcome: "deny";
  readonly reason: ReadPolicyDenyReason;
  /** Names the rule that fired; distinguishable per reason. */
  readonly message: string;
}

export type ReadPolicyVerdict = ReadPolicyAllow | ReadPolicyDeny;

export type ReadProtectedPathShape =
  | "path-glob"
  | "extension-glob"
  | "exact-basename"
  | "dotfile-glob"
  | "suffix-glob"
  | "inner-glob"
  | "absolute-prefix";

export interface ReadProtectedPathEntry {
  readonly shape: ReadProtectedPathShape;
  readonly pattern: string;
}

function protectedEntry(
  shape: ReadProtectedPathShape,
  pattern: string
): ReadProtectedPathEntry {
  return Object.freeze({ shape, pattern });
}

/**
 * The read policy's own frozen protected-path roster — a NEW constant of this
 * module, not a reuse of the shell wall's `SENSITIVE_PATH_FRAGMENTS` (that
 * list stays byte-unchanged in `hard-walls.ts`; the SC9 pin in
 * `tests/harness/aci/tools/host-read-policy.test.ts` couples the two read-only
 * by asserting this matcher denies at least everything that roster covers).
 *
 * The `suffix-glob` / `inner-glob` arms exist because the shell wall's roster
 * is mostly anchored regexes (`\.env$`, `\.ssh$`, `\.pem$`, …) and one mid-name
 * regex (`\.env\.`), plus three bare unanchored substrings. Those spellings
 * deny a credential whose name merely ENDS with the token, CONTAINS it between
 * dots, or — for the unanchored three — sits anywhere inside a name at any
 * depth (`app.env`, `foo.env.bar`, `app.id_rsa`, `id_rsax.ts`). No other shape
 * reaches them: `dotfile-glob .env` needs a leading dot on the whole name,
 * `extension-glob *.pem` needs the extension at the end, `path-glob .ssh/`
 * needs an exact segment, and `exact-basename` needs the whole final segment.
 * Without these arms the read channel was weaker than the shell channel on
 * exactly those names (`bash cat app.env` walled, `read_file app.env` served).
 */
export const READ_PROTECTED_PATHS: readonly ReadProtectedPathEntry[] =
  Object.freeze([
    protectedEntry("path-glob", ".ssh/"),
    protectedEntry("path-glob", ".aws/"),
    protectedEntry("path-glob", ".gnupg/"),
    protectedEntry("path-glob", ".config/gh/"),
    protectedEntry("path-glob", ".kube/"),
    protectedEntry("path-glob", ".docker/config.json"),
    protectedEntry("extension-glob", "*.pem"),
    protectedEntry("extension-glob", "*.key"),
    protectedEntry("extension-glob", "*.p12"),
    protectedEntry("suffix-glob", "id_rsa"),
    protectedEntry("suffix-glob", "id_ed25519"),
    protectedEntry("suffix-glob", ".netrc"),
    protectedEntry("dotfile-glob", ".env"),
    protectedEntry("dotfile-glob", ".env.*"),
    // The shell roster's `$`-anchored regexes, in roster order.
    protectedEntry("suffix-glob", ".env"),
    protectedEntry("suffix-glob", ".ssh"),
    protectedEntry("suffix-glob", ".aws"),
    protectedEntry("suffix-glob", ".gnupg"),
    protectedEntry("suffix-glob", ".config/gh"),
    protectedEntry("suffix-glob", ".kube"),
    protectedEntry("suffix-glob", ".pem"),
    protectedEntry("suffix-glob", ".key"),
    protectedEntry("suffix-glob", ".p12"),
    // The shell roster's one non-`$` regex (`\.env\.`).
    protectedEntry("inner-glob", ".env"),
    protectedEntry("absolute-prefix", "/etc/passwd"),
    protectedEntry("absolute-prefix", "/etc/shadow"),
    protectedEntry("absolute-prefix", "/proc/self/environ"),
  ]);

/** Tokens whose `/`-form the shell roster also carries (see matchesSuffixGlob). */
const CONTINUABLE_SUFFIX_TOKENS: readonly string[] = Object.freeze([
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gh",
  ".kube",
]);

/**
 * Tokens the shell roster carries UNANCHORED — a bare `includes` with no `$`
 * and no `\.` prefix — so it matches inside a longer name and at any depth
 * (`app.id_rsa`, `keys/id_rsa`). `exact-basename` is strictly narrower and
 * would leave SC9 holes, so these are suffix-glob entries instead.
 */
const UNANCHORED_SHELL_TOKENS: readonly string[] = Object.freeze([
  "id_rsa",
  "id_ed25519",
  ".netrc",
]);

function splitSegments(normalized: string): readonly string[] {
  return normalized.split("/").filter((segment) => segment.length > 0);
}

function containsConsecutive(
  segments: readonly string[],
  needle: readonly string[]
): boolean {
  outer: for (
    let start = 0;
    start + needle.length <= segments.length;
    start++
  ) {
    for (let k = 0; k < needle.length; k++) {
      if (segments[start + k] !== needle[k]) continue outer;
    }
    return true;
  }
  return false;
}

function matchesExtensionGlob(pattern: string, lastSegment: string): boolean {
  const dot = lastSegment.lastIndexOf(".");
  return dot > 0 && lastSegment.slice(dot + 1) === pattern.slice(2);
}

function matchesDotfileGlob(pattern: string, lastSegment: string): boolean {
  if (!pattern.endsWith(".*")) return lastSegment === pattern;
  const prefix = pattern.slice(0, -1);
  return lastSegment.startsWith(prefix) && lastSegment.length > prefix.length;
}

/**
 * The token ends a path SEGMENT (`app.env`, `backup.ssh`, `/home/u/.ssh`,
 * `backup.ssh/config`): the token must be a SUFFIX of the segment, so
 * `app.env` matches the token `.env` while `envoy` and `re.environ` — which
 * carry it mid-name — stay ordinary.
 *
 * The `/`-continuation applies only to `CONTINUABLE_SUFFIX_TOKENS` — the five
 * tokens the shell roster also lists as slash fragments (`.ssh`, `.aws`,
 * `.gnupg`, `.config/gh`, `.kube`), and which `path-glob` already denies
 * segment-exactly. Extending it to every token denied `router.key/`,
 * `certs.pem/` and `app.env/` — ordinary source directories the shell wall
 * allows — which is the over-denial this arm exists to avoid.
 */
function matchesSuffixGlob(pattern: string, normalized: string): boolean {
  const continuable =
    CONTINUABLE_SUFFIX_TOKENS.includes(pattern) ||
    UNANCHORED_SHELL_TOKENS.includes(pattern);
  const segments = splitSegments(normalized);
  const width = splitSegments(pattern).length;
  for (let index = 0; index < segments.length; index += 1) {
    // Compare the joined tail, not one segment: a token may itself span
    // segments (`.config/gh`), and matching only single segments would make
    // that roster entry permanently dead.
    const span = segments.slice(index, index + width).join("/");
    if (!span.endsWith(pattern)) continue;
    const endsPath = index + width === segments.length;
    if (endsPath) return true;
    if (continuable) return true;
  }
  // The shell's `id_rsa` / `id_ed25519` are bare substrings with no anchor at
  // all, so they also match mid-name (`id_rsax.ts`). Anchoring them would
  // leave SC9 holes on exactly the names the shell wall refuses.
  if (UNANCHORED_SHELL_TOKENS.includes(pattern)) {
    return normalized.includes(pattern);
  }
  return false;
}

/**
 * The token continues past a dot INSIDE a name: `foo.env.bar`, `re.env.json` —
 * the shell roster's single non-`$` regex, `\.env\.`. A token that merely
 * starts a longer name (`envoy`, `re.environ`) is followed by a letter, not a
 * dot, so it stays ordinary.
 */
function matchesInnerGlob(pattern: string, normalized: string): boolean {
  return normalized.includes(`${pattern}.`);
}

function matchesShape(
  entry: ReadProtectedPathEntry,
  normalized: string,
  segments: readonly string[]
): boolean {
  const lastSegment = segments.length > 0 ? segments[segments.length - 1] : "";
  switch (entry.shape) {
    case "path-glob":
      return containsConsecutive(segments, splitSegments(entry.pattern));
    case "extension-glob":
      return matchesExtensionGlob(entry.pattern, lastSegment);
    case "exact-basename":
      return segments.includes(entry.pattern);
    case "dotfile-glob":
      return matchesDotfileGlob(entry.pattern, lastSegment);
    case "suffix-glob":
      return matchesSuffixGlob(entry.pattern, normalized);
    case "inner-glob":
      return matchesInnerGlob(entry.pattern, normalized);
    case "absolute-prefix":
      return (
        normalized === entry.pattern ||
        normalized.startsWith(`${entry.pattern}/`)
      );
  }
}

/**
 * Roster matcher over a path string. Never throws. Per-shape matching only: a
 * substring arm once denied any path merely *containing* a pattern's core
 * (`.keyboard.md`, `.sshfoo/`), over-denying ordinary files while catching no
 * credential the shapes miss. So this matcher is stricter than the shell wall's
 * raw `includes` pass on real credentials and looser on incidental substring
 * collisions; SC9's corpus pin covers the credential side.
 *
 * The two `$`-anchor arms (`suffix-glob` end-anchored, `inner-glob`
 * dot-bounded) restore what the shell roster's regex spellings deny without
 * reintroducing that over-denial: they are anchored at a name boundary, so
 * `app.env` is refused while `envoy` and `re.environ` are ordinary files.
 */
export function matchProtectedPath(
  candidate: string
): ReadProtectedPathEntry | null {
  try {
    const normalized = candidate.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    const segments = splitSegments(normalized);
    for (const entry of READ_PROTECTED_PATHS) {
      if (matchesShape(entry, normalized, segments)) return entry;
    }
    return null;
  } catch {
    // An unmatchable string is undecided, and undecided is protected-adjacent:
    // report the floor entry so callers deny rather than allow.
    return READ_PROTECTED_PATHS[0] ?? null;
  }
}

/**
 * Containment-arm switch predicate (ADR-0128 host-reach widening).
 * `true` when the canonicalized target sits under one of the containment
 * roots (live root, extras, session tmp pad, gated identity root), so that
 * arm's legacy resolution continues byte-identically. `false` means the
 * target is outside every root, and the only authority that may still reach
 * it is an `allow` verdict from `decideRead` — host reach widens *through*
 * the policy decision, never through an unguarded root (SC8): protected,
 * unusable and undecidable paths deny upstream and never arrive at the
 * fallback arm. Comparison semantics are `helpers.isWithinRoot`'s, delegated
 * to that single owner; this module adds the empty/whitespace guard and the
 * realpath canonicalization of the roots (same discipline as
 * `resolveWithinRoot`, so a symlinked root parent never misclassifies a
 * policy-canonical target as outside the root that contains it).
 */
export function withinContainmentRoots(
  canonicalTarget: string,
  roots: readonly (string | undefined)[]
): boolean {
  return roots.some((root) => {
    if (root === undefined || root.trim().length === 0) return false;
    return isWithinRoot(resolvePath(root), canonicalTarget);
  });
}

/**
 * Realpath a containment root for the arm switch (`helpers.ts`
 * `resolveWithinRoot` discipline: `realpath(resolve(root))`). A root that
 * cannot be canonicalized (not created yet — e.g. a persona `.iknow` or a
 * session pad in its first call) keeps its anchored form; the switch then
 * compares like-for-like exactly as before.
 */
async function canonicalContainmentRoot(
  root: string | undefined
): Promise<string | undefined> {
  if (root === undefined || root.trim().length === 0) return undefined;
  const absolute = resolvePath(root);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Identity-root read passthrough gate (ADR-0037), owned once for all three
 * read tools so the extra-root set is built from one rule:
 * - `projectIdentityRoot` absent → no extra (undefined).
 * - `allowProjectIdentityRoot === true` (production: isolation ON) additionally
 *   requires the live root to be a BOUND worktree (`isBoundWorktreeRoot`, issue
 *   1231 — task-shaped or explicitly entered), so a same-run rebind opens the
 *   passthrough without widening the OFF / main-checkout surface.
 * - `allowProjectIdentityRoot === false` → hard deny.
 * - key not threaded (legacy / worker direct-factory callers) → the threaded
 *   root passes unguarded, matching the historical tri-state behavior.
 */
function gateProjectIdentityRoot(
  liveRoot: string,
  projectIdentityRoot: string | undefined,
  allowProjectIdentityRoot: boolean | undefined
): string | undefined {
  if (projectIdentityRoot === undefined) return undefined;
  if (allowProjectIdentityRoot === true && !isBoundWorktreeRoot(liveRoot)) {
    return undefined;
  }
  if (allowProjectIdentityRoot === false) return undefined;
  return projectIdentityRoot;
}

/**
 * Compute the per-call extra containment roots, anchored to the same wave
 * snapshot as `taskRoot` (root + extras share one vintage — the
 * read-path-live-task-root invariant). Read-only reachability surface:
 *   - `profileRoot` (home profile `~/.iknow`, read_file only) always when given
 *   - `<workspaceRoot>/.iknow` (per-root persona state) when threaded and
 *     distinct from the live root
 *   - the gated `projectIdentityRoot` (ADR-0037 passthrough) when threaded and
 *     distinct from the live root
 *
 * The extras are the **containment arm**: targets whose policy-canonical
 * path sits under one of them resolve through `resolveWithinRoot`
 * (realpath-based, symlink-escape rejecting) exactly as before; targets under
 * none of them are reached by the canonical policy's allow verdict instead
 * (ADR-0128 host reach), so this list gates resolution semantics, not whether
 * an ordinary host path is readable at all.
 */
function computeExtraReadRoots(input: {
  readonly taskRoot: string;
  readonly profileRoot?: string;
  readonly workspaceRoot?: string;
  readonly projectIdentityRoot?: string;
}): readonly string[] {
  const extras: string[] = [];
  if (input.profileRoot !== undefined) extras.push(input.profileRoot);
  if (input.workspaceRoot && input.workspaceRoot !== input.taskRoot) {
    extras.push(join(input.workspaceRoot, ".iknow"));
  }
  if (
    input.projectIdentityRoot &&
    input.projectIdentityRoot !== input.taskRoot
  ) {
    extras.push(input.projectIdentityRoot);
  }
  return Object.freeze(extras);
}

/** Inputs of the shared read-reach resolution — one snapshot vintage. */
export interface ReadReachInput {
  /**
   * Primary containment anchor: the live-root snapshot as the tool uses it
   * for `resolveWithinRoot` (grep threads its realpath'ed root, glob and
   * read_file the raw snapshot — unchanged from the per-tool shape).
   */
  readonly primaryRoot: string;
  /** The model's raw requested path (relative or absolute). */
  readonly target: string;
  /**
   * The decideRead **allow** verdict's canonical path for the same request —
   * this function is only reached after that verdict allowed.
   */
  readonly policyPath: string;
  /** Ungated `projectIdentityRoot` threading; gated here (see above). */
  readonly projectIdentityRoot?: string;
  readonly allowProjectIdentityRoot?: boolean;
  /** Home profile extra (`~/.iknow`); read_file only. */
  readonly profileRoot?: string;
  /** Per-root persona anchor; read_file only. */
  readonly workspaceRoot?: string;
  /** ADR-0092 session tmp pad; read_file only. */
  readonly sessionTmpRoot?: string;
  /**
   * Live-root snapshot used for the identity gating and the extras dedup
   * when it differs from `primaryRoot` (grep gates on the raw snapshot while
   * its containment anchor is realpath'ed). Defaults to `primaryRoot`.
   */
  readonly liveRoot?: string;
}

/**
 * The single owner of per-tool read reach (specs/host-read-policy.md SC6):
 * containment root-set construction + the arm switch, previously derived in
 * parallel by `read-file.ts`, `grep.ts` and `glob.ts`.
 *
 * Arm switch (ADR-0128): when `policyPath` sits outside every containment
 * root, the verdict itself is the resolved target — ordinary host paths are
 * readable in both modes and no unguarded root is involved (protected and
 * undecidable paths denied before getting here). Inside the roots the legacy
 * `resolveWithinRoot` arm runs byte-identically, extras and pad included.
 * A relative name missing from the primary root still falls back to the
 * gated identity root (ADR-0037 convenience), and an absolute target never
 * takes the fallback arm.
 */
export async function resolveReadReach(input: ReadReachInput): Promise<string> {
  const liveRoot = input.liveRoot ?? input.primaryRoot;
  const projectIdentityRoot = gateProjectIdentityRoot(
    liveRoot,
    input.projectIdentityRoot,
    input.allowProjectIdentityRoot
  );
  const extraReadRoots = computeExtraReadRoots({
    taskRoot: liveRoot,
    profileRoot: input.profileRoot,
    workspaceRoot: input.workspaceRoot,
    projectIdentityRoot,
  });
  const containmentRoots = await Promise.all(
    [input.primaryRoot, ...extraReadRoots, input.sessionTmpRoot].map(
      canonicalContainmentRoot
    )
  );
  if (!withinContainmentRoots(input.policyPath, containmentRoots)) {
    return input.policyPath;
  }
  const primary = await resolveWithinRoot(input.primaryRoot, input.target, {
    extraReadRoots,
    sessionTmpRoot: input.sessionTmpRoot,
  });
  if (projectIdentityRoot === undefined || isAbsolute(input.target)) {
    return primary;
  }
  try {
    await stat(primary);
    return primary;
  } catch {
    const candidate = await resolveWithinRoot(
      projectIdentityRoot,
      input.target
    );
    try {
      await stat(candidate);
      return candidate;
    } catch {
      return primary;
    }
  }
}

/**
 * Tool-deps bag the shared flow reads *wholesale* (no per-field optional
 * chains at the call site): the union of the read tools' deps interfaces'
 * policy-relevant fields. Extra fields on the caller's interface are fine —
 * the flow only reads these.
 */
export interface ReadFlowDeps {
  readonly projectIdentityRoot?: string;
  readonly allowProjectIdentityRoot?: boolean;
  readonly workspaceRoot?: string;
  readonly tmpDir?: string;
  readonly projectDir?: string;
  readonly fsMode?: FsModeContext;
}

/** Inputs of the shared decide → resolve → decide flow (one call per read). */
export interface ReadFlowInput {
  /** Tool label for the denial prefix, e.g. `"read_file"`. */
  readonly tool: string;
  /** Containment anchor as the tool's resolution uses it (see `ReadReachInput`). */
  readonly primaryRoot: string;
  /** The model's raw requested path. */
  readonly target: string;
  /** Live-root snapshot when it differs from `primaryRoot` (grep). */
  readonly liveRoot?: string;
  /** Home profile extra (read_file only). */
  readonly profileRoot?: string;
  /** Session identity for the tmp pad (read_file only); others leave undefined. */
  readonly conversationId?: string;
  /** The tool's deps/options object, passed whole. */
  readonly deps?: ReadFlowDeps;
}

/** Snapshot the policy view for one call: fs mode + identity roots. */
function policySnapshot(input: ReadFlowInput): {
  readonly mode: ReadPolicyFsMode;
  readonly roots: ReadPolicyRoots;
} {
  return {
    mode: input.deps?.fsMode?.get() ?? FS_ISOLATION_MODE_DEFAULT,
    roots: {
      taskRoot: input.liveRoot ?? input.primaryRoot,
      homeRoot: homedir(),
    },
  };
}

/** Build the reach input for the shared resolver from flow inputs. */
function reachFromFlow(
  input: ReadFlowInput,
  policyPath: string
): ReadReachInput {
  return {
    primaryRoot: input.primaryRoot,
    liveRoot: input.liveRoot,
    target: input.target,
    policyPath,
    profileRoot: input.profileRoot,
    projectIdentityRoot: input.deps?.projectIdentityRoot,
    allowProjectIdentityRoot: input.deps?.allowProjectIdentityRoot,
    workspaceRoot: input.deps?.workspaceRoot,
    // The session tmp pad is a first-class containment root for reads
    // (ADR-0092, same identity as the write tools' sessionTmpRoot). Tools
    // without pad wiring resolve it to `undefined` here, exactly as when
    // they omitted the field before.
    sessionTmpRoot: resolveSessionFenceTmp({
      tmpDir: input.deps?.tmpDir,
      projectDir: input.deps?.projectDir,
      conversationId: input.conversationId,
    }),
  };
}

/**
 * The single owner of the per-read decision flow (specs/host-read-policy.md
 * SC6, ADR-0128), previously spelled near-verbatim by `read_file`, `grep` and
 * `glob`: decide the request → resolve the reach under that verdict → re-decide
 * the resolved path (it can diverge via the identity-root fallback arm) — and
 * throw the calling tool's `ToolExecutionError` denial, message byte-identical
 * to the per-tool spellings, on either deny. The return value is the resolved
 * target the tool goes on to open.
 */
export async function decideAndResolveReadReach(
  input: ReadFlowInput
): Promise<string> {
  const { mode, roots } = policySnapshot(input);
  const requestVerdict = await decideRead(input.target, roots, mode);
  if (requestVerdict.outcome === "deny") {
    throw new ToolExecutionError(`[${input.tool}] ${requestVerdict.message}`);
  }
  const resolved = await resolveReadReach(
    reachFromFlow(input, requestVerdict.canonicalPath)
  );
  const targetVerdict = await decideRead(resolved, roots, mode);
  if (targetVerdict.outcome === "deny") {
    throw new ToolExecutionError(`[${input.tool}] ${targetVerdict.message}`);
  }
  return resolved;
}

function deny(reason: ReadPolicyDenyReason, why: string): ReadPolicyDeny {
  if (reason === "protected_path") {
    return Object.freeze({
      outcome: "deny" as const,
      reason,
      message: `read denied by the protected-path roster (${why}): protected credentials and sensitive locations are refused regardless of reachability`,
    });
  }
  if (reason === "resolution_failure") {
    return Object.freeze({
      outcome: "deny" as const,
      reason,
      message: `read denied (resolution failure): ${why}; an undecidable path is never allowed`,
    });
  }
  return Object.freeze({
    outcome: "deny" as const,
    reason,
    message: `read denied (out of reach): ${why}`,
  });
}

const HOST_PATH_MAX = 4096;
const NAME_MAX = 255;
const MAX_SEGMENTS = 512;

function unusableInputError(trimmed: string): string | null {
  if (trimmed.length === 0 || /^[\s/\\]+$/.test(trimmed)) {
    return "empty or separator-only unusable input";
  }
  if (trimmed.includes("\u0000")) return "path contains a NUL byte";
  const segments = splitSegments(trimmed.replace(/\\/g, "/"));
  if (trimmed.length > HOST_PATH_MAX)
    return "path is too long for the platform limit";
  if (segments.length > MAX_SEGMENTS) return "path is too deeply nested";
  if (segments.some((segment) => segment.length > NAME_MAX)) {
    return "path segment is too long";
  }
  return null;
}

function errnoCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
}

/** Maps a resolution errno to a message that never leaks the raw code name. */
function describeResolutionFailure(code: string): string {
  switch (code) {
    case "ENOENT":
      return "path could not be resolved to an existing anchor";
    case "ELOOP":
      return "symlink loop while resolving the path";
    case "EACCES":
    case "EPERM":
      return "unreadable path component during resolution";
    case "ENAMETOOLONG":
      return "path is too long for the filesystem during resolution";
    case "ENOTDIR":
      return "path traverses a non-directory component";
    default:
      return "unexpected path resolution failure";
  }
}

type CanonicalResult =
  | { readonly ok: true; readonly canonical: string }
  | { readonly ok: false; readonly why: string };

/**
 * realpath discipline: canonicalize what exists; where only a trailing tail
 * is missing, anchor at the deepest existing directory. A missing component
 * that exists as a link is a dangling symlink and is undecidable.
 */
async function anchorMissingTail(absolute: string): Promise<CanonicalResult> {
  const tail: string[] = [];
  let current = absolute;
  for (let depth = 0; depth <= MAX_SEGMENTS + 1; depth++) {
    try {
      // The top-level realpath failed with ENOENT here; if this component
      // nevertheless exists, it is a link whose target is gone.
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) return { ok: false, why: "dangling symlink" };
      return { ok: false, why: describeResolutionFailure("ENOENT") };
    } catch {
      // Name absent: fold it into the missing tail and go up one level.
    }
    tail.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) {
      return { ok: false, why: describeResolutionFailure("ENOENT") };
    }
    try {
      return { ok: true, canonical: join(await realpath(parent), ...tail) };
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT") {
        current = parent;
        continue;
      }
      return { ok: false, why: describeResolutionFailure(code) };
    }
  }
  return { ok: false, why: "path is too deeply nested during resolution" };
}

async function canonicalize(absolute: string): Promise<CanonicalResult> {
  try {
    return { ok: true, canonical: await realpath(absolute) };
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") return anchorMissingTail(absolute);
    return { ok: false, why: describeResolutionFailure(code) };
  }
}

function toAbsolute(
  trimmed: string,
  roots: ReadPolicyRoots
): { readonly absolute: string } | { readonly deny: ReadPolicyDeny } {
  const tildeForm = trimmed === "~" || trimmed.startsWith("~/");
  if (tildeForm) {
    if (roots.homeRoot === undefined || roots.homeRoot.trim() === "") {
      return {
        deny: deny(
          "resolution_failure",
          "home alias given without a home identity root"
        ),
      };
    }
    if (trimmed === "~") return { absolute: resolvePath(roots.homeRoot) };
    // `join` (not `resolve`) — the remainder after `~/` must never be treated
    // as absolute; `resolve` would drop the home anchor on `~//x` spellings.
    return { absolute: join(roots.homeRoot, trimmed.slice(2)) };
  }
  if (isAbsolute(trimmed)) return { absolute: resolvePath(trimmed) };
  if (roots.taskRoot === undefined || roots.taskRoot.trim() === "") {
    return {
      deny: deny(
        "out_of_reach",
        "relative path has no task-root anchor inside the reachable host view"
      ),
    };
  }
  return { absolute: resolvePath(roots.taskRoot, trimmed) };
}

function protectVerdict(entry: ReadProtectedPathEntry): ReadPolicyDeny {
  return deny(
    "protected_path",
    `${entry.shape} "${entry.pattern}" matched the pre-resolution or canonical path`
  );
}

/**
 * The single read decision. `mode` participates only through its value
 * domain: both defined modes give the same readable host view; an unknown
 * mode fails closed. The symlink rule is judged on both the pre-resolution
 * path and the realpath, so an alias of a protected path denies while an
 * ordinary file reached through ordinary links allows.
 */
export async function decideRead(
  candidate: string,
  roots: ReadPolicyRoots,
  mode: ReadPolicyFsMode = "global"
): Promise<ReadPolicyVerdict> {
  try {
    return await decide(candidate, roots, mode);
  } catch {
    // No permissive default on error: anything uncaught is a deny.
    return deny("resolution_failure", "unexpected policy failure");
  }
}

async function decide(
  candidate: string,
  roots: ReadPolicyRoots,
  mode: ReadPolicyFsMode
): Promise<ReadPolicyVerdict> {
  if (mode !== "global" && mode !== "workspace") {
    return deny(
      "out_of_reach",
      `filesystem mode "${String(mode)}" has no defined readable host view`
    );
  }
  const trimmed = candidate.trim();
  const unusable = unusableInputError(trimmed);
  if (unusable !== null) return deny("resolution_failure", unusable);

  const anchored = toAbsolute(trimmed, roots);
  if ("deny" in anchored) return anchored.deny;

  const preHit = matchProtectedPath(anchored.absolute);
  if (preHit !== null) return protectVerdict(preHit);

  const resolved = await canonicalize(anchored.absolute);
  if (!resolved.ok) return deny("resolution_failure", resolved.why);

  const realHit = matchProtectedPath(resolved.canonical);
  if (realHit !== null) return protectVerdict(realHit);

  return Object.freeze({
    outcome: "allow" as const,
    canonicalPath: resolved.canonical,
  });
}
