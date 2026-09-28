/**
 * src/harness/sandbox/protected-target-feedback.ts
 *
 * The protected-target boundary refusal template (ADR-0129 /
 * specs/effect-boundary-protection.md "Error handling → The refusal message
 * template"). When a write to a protected target is refused by the fence's
 * physical ro-bind (kernel EROFS), this module turns the stderr into one
 * actionable guidance line in the `[fs_denied]` family.
 *
 * The shape is shared with the ADR-0109 worktree donor
 * (`isolation/worktree-gate.ts:unboundFenceErofsGuidance`) — typed
 * `VIOLATION_PREFIXES.fsDenied` prefix, EROFS-stderr trigger, cap-and-count
 * rendering of the attempted-path clues, `undefined` on a stderr with no
 * EROFS line — but NO string and NO sentence is shared with it. The donor
 * describes a different boundary (the read-only main checkout of an unbound
 * session) and prescribes `create-worktree`; that remedy on a protected-
 * credential refusal would send the model to a fix that cannot help. This
 * template is a distinct function, and the two boundaries' wording can never
 * drift into each other (pinned both directions in
 * tests/harness/isolation/protected-target-erofs-guidance.test.ts).
 *
 * Four parts, in this order:
 *   1. the typed `[fs_denied]` prefix (VIOLATION_PREFIXES SSOT — the same
 *      table the categorizer in `violation-handling.ts` recognizes);
 *   2. the protected target CLASS, named from the inventory
 *      (`protected-targets.ts` `targetClass` ids), never a bare path;
 *   3. the attribution: refused at the filesystem layer by the sandbox
 *      fence (kernel EROFS) — a boundary refusal, NOT a command-syntax
 *      judgment; re-spelling the command will not help;
 *   4. that removing a protected target is not an operation this session can
 *      perform — no receipt, flag, ordering, or spelling changes that.
 *
 * Like the donor, the guidance rides in the ok-envelope stderr (F4 ssh-hostkey
 * precedent), NOT a typed failure: `categorizeResult` only counts
 * `execution_failed` kinds, so appending here surfaces the boundary to the
 * model without opening a new violation-counting tier.
 *
 * TWO templates live here, deliberately not one: the EROFS arm above (a write
 * into a read-only protected mount) and the EBUSY arm below (an unlink of a
 * per-file `/dev/null` mask point, which is a mount point and therefore EBUSY,
 * not EROFS). They share the typed prefix and nothing else — not a sentence,
 * not a constant, not a parameter. See the EBUSY section header for why.
 */
import { VIOLATION_PREFIXES } from "../permission/prefixes.js";
import type { ProtectedTargetInventory } from "./protected-targets.js";

/** One EROFS line in program stderr: the fence's physical refusal signature. */
const EROFS_LINE_PATTERN = /Read-only file system/;

/** Attempted-path clue rendering (the shape inherited from ADR-0109): the
 *  first five EROFS lines, the remainder as a count. */
const MAX_CLUE_LINES = 5;

/** Quoted path BEFORE the marker — GNU coreutils:
 *  `rm: cannot remove '/home/u/.ssh/id_ed25519': Read-only file system`. */
const QUOTED_PATH_BEFORE = /["']([^"'\n]+)["']\s*:\s*Read-only file system/g;
/** Quoted path AFTER the marker — Python OSError:
 *  `[Errno 30] Read-only file system: '/home/u/.aws/credentials'`. */
const QUOTED_PATH_AFTER = /Read-only file system:\s*["']([^"'\n]+)["']/g;
/** Unquoted absolute path BEFORE the marker — e.g.
 *  `tee: /home/u/.netrc: Read-only file system`. */
const UNQUOTED_ABS_PATH = /(?:^|\s)(\/[^\s"']+):\s*Read-only file system/g;

/**
 * English phrase per inventory target class (the ids are the
 * `ProtectedTargetClassId` set in `protected-targets.ts`; a lookup table, not
 * a switch, keeps this function branch-free for the S5 gate).
 */
const PROTECTED_TARGET_CLASS_PHRASES: Readonly<Record<string, string>> = {
  ssh_key_material: "an SSH private key",
  cloud_credential: "a cloud credential file",
  gpg_key_material: "a GPG key file",
  github_cli_credential: "a GitHub CLI credential file",
  kube_config: "a Kubernetes config file",
  docker_config: "a Docker config file",
  netrc_credential: "a netrc credential file",
  dotenv_file: "an environment file",
  tls_key_material: "a TLS key material file",
  process_environ: "a process environment file",
  system_identity_file: "a system identity file",
  system_readonly_tree: "a system read-only path",
};

/**
 * An extra-target id falls back to a named-class phrase so the refusal still
 * answers "WHAT category was refused", never a bare path or a silent noun.
 */
export function describeProtectedTargetClass(classId: string): string {
  return (
    PROTECTED_TARGET_CLASS_PHRASES[classId] ??
    `a protected target (class "${classId}")`
  );
}

/** The EROFS-carrying lines of a raw stderr, in original order. */
function erofsLines(stderr: string): readonly string[] {
  return stderr.split("\n").filter((line) => EROFS_LINE_PATTERN.test(line));
}

/**
 * The protected-target boundary refusal template. `stderr` is the raw
 * sandbox stderr, `targetClass` is the inventory class the refusal is
 * attributed to. Returns `undefined` when the stderr carries no EROFS line —
 * the caller then leaves the result byte-identical.
 */
export function protectedTargetErofsGuidance(
  stderr: string,
  targetClass: string
): string | undefined {
  const lines = erofsLines(stderr);
  if (lines.length === 0) return undefined;
  const shown = lines.slice(0, MAX_CLUE_LINES);
  const rest = lines.length - shown.length;
  const classPhrase = describeProtectedTargetClass(targetClass);
  return (
    `${VIOLATION_PREFIXES.fsDenied} the refused write targeted ${classPhrase}: ` +
    `this protected target is mounted read-only by the sandbox fence, and the ` +
    `kernel (EROFS) refused the write at the filesystem layer. This is a ` +
    `boundary refusal, not a command-syntax judgment — re-spelling the command ` +
    `will not help. Removing ${classPhrase} is not an operation this session ` +
    `can perform: the target stays read-only for the whole session, and no ` +
    `spelling, flag, or ordering of the command changes that. ` +
    `Attempted paths (from stderr): ${shown.join(" | ")}` +
    (rest > 0 ? ` (+${rest} more EROFS lines)` : "")
  );
}

/** The EROFS clue-path regex family as one array. Separate from the EBUSY
 *  family below because the two boundaries parse DIFFERENT marker text — a
 *  shared array would let one arm's pattern reach the other's parsing. */
const EROFS_PATH_PATTERNS: readonly RegExp[] = [
  QUOTED_PATH_BEFORE,
  QUOTED_PATH_AFTER,
  UNQUOTED_ABS_PATH,
];

/** Candidate protected paths named by one refusal stderr line, in the shapes
 *  that boundary's stderr surfaces (coreutils, Python, unquoted absolute).
 *  The pattern family is a caller argument — the structure is shared between
 *  the two arms, the patterns never are. */
function extractCandidatePaths(
  line: string,
  patterns: readonly RegExp[]
): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern)) {
      const path = match[1];
      if (path !== undefined && !seen.has(path)) {
        seen.add(path);
        found.push(path);
      }
    }
  }
  return found;
}

/** The EROFS arm accepts every parsed path — being protected is the only
 *  test (the EBUSY arm's extra `accepts` is the mask correlation). */
const acceptAnyPath = (): boolean => true;

/** Group refusal stderr lines by the inventory class their attempted path
 *  falls under; lines whose paths the arm rejects are dropped (another
 *  boundary's message owns them). */
function groupLinesByProtectedClass(
  lines: readonly string[],
  inventory: ProtectedTargetInventory,
  patterns: readonly RegExp[],
  accepts: (path: string) => boolean
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const line of lines) {
    for (const path of extractCandidatePaths(line, patterns)) {
      if (!accepts(path)) continue;
      const entry = inventory.protectedTargetFor(path);
      if (entry === undefined) continue;
      const bucket = groups.get(entry.targetClass);
      if (bucket !== undefined) bucket.push(line);
      else groups.set(entry.targetClass, [line]);
      break;
    }
  }
  return groups;
}

/**
 * The shared render skeleton: one message per distinct protected class,
 * newline-joined; no group that renders nothing → `undefined` (the caller
 * keeps its result byte-identical).
 *
 * `render` is each arm's OWN copy renderer. Sharing this skeleton is
 * structural only: the module header forbids the two boundaries sharing a
 * sentence, a constant, or a parameter, and neither template's copy passes
 * through here.
 */
function renderBoundaryRefusals(
  groups: ReadonlyMap<string, string[]>,
  render: (stderr: string, targetClass: string) => string | undefined
): string | undefined {
  const messages: string[] = [];
  for (const [targetClass, groupLines] of groups) {
    const message = render(groupLines.join("\n"), targetClass);
    if (message !== undefined) messages.push(message);
  }
  return messages.length > 0 ? messages.join("\n") : undefined;
}

/**
 * Resolve the boundary refusal from raw stderr against the protected-target
 * inventory: group the EROFS lines by the inventory class their attempted
 * path falls under, and render one template message per distinct class.
 * Returns `undefined` (caller keeps the result byte-identical) when there is
 * no EROFS line or no EROFS line names a protected path — an EROFS on a
 * non-protected path is another boundary's message (e.g. the worktree
 * unbound-fence state), and this template never guesses a class for it.
 */
export function protectedTargetFenceGuidance(
  stderr: string,
  inventory: ProtectedTargetInventory
): string | undefined {
  const groups = groupLinesByProtectedClass(
    erofsLines(stderr),
    inventory,
    EROFS_PATH_PATTERNS,
    acceptAnyPath
  );
  if (groups.size === 0) return undefined;
  return renderBoundaryRefusals(groups, protectedTargetErofsGuidance);
}

/* ------------------------------------------------------------------------- *
 * The EBUSY arm of the same boundary — a SECOND, separate template.
 *
 * When a credential is masked as an EXACT file (`--ro-bind /dev/null <file>`
 * landing directly at the file), that file becomes a mount point under an
 * otherwise writable parent. `unlink` on a mount point returns **EBUSY**, not
 * EROFS, so the EROFS trigger above never fires for that refusal subclass —
 * the refusal is truthful (non-zero exit, host bytes unchanged) but the model
 * got no target-class or boundary attribution.
 *
 * Why a separate function and not a parameter of the EROFS one: the two
 * refusals have genuinely different physics (a read-only mount refused the
 * write, vs. an active mount point refused the unlink), and the EBUSY copy
 * must not claim an EROFS happened when it did not.
 * Sharing one string would let either boundary's wording drift into the
 * other's — the exact failure this module's header already forbids. Pinned
 * both directions in tests/harness/isolation/protected-target-ebusy-guidance.test.ts.
 *
 * Unlike the EROFS arm, this trigger MUST be correlated against the masks the
 * fence actually emitted. "Device or resource busy" is a generic host-level
 * errno — an umount/loopback/CD-ROM/overlay refusal looks identical — so
 * firing on the stderr line alone would relabel unrelated execution failures
 * as protected-target violations (the advisory-guidance failure mode). The
 * correlation is against the EFFECTIVE post-ordering mask list, which already
 * excludes absent targets (they emitted no mask) and, with the cleanup
 * override withdrawn, has no superseded-by-authorization case to filter.
 * ------------------------------------------------------------------------- */

/** One EBUSY line: the kernel's "Device or resource busy" refusal. */
const EBUSY_LINE_PATTERN = /Device or resource busy/;

/** The EBUSY clue cap — same five-line discipline as the EROFS arm, its own
 *  constant so the two arms cannot silently come to share a budget. */
const MAX_EBUSY_CLUE_LINES = 5;

/** Quoted path BEFORE the marker — GNU coreutils:
 *  `rm: cannot remove '/home/u/.netrc': Device or resource busy`. */
const EBUSY_QUOTED_PATH_BEFORE =
  /["']([^"'\n]+)["']\s*:\s*Device or resource busy/g;
/** Quoted path AFTER the marker — Python OSError:
 *  `OSError: [Errno 16] Device or resource busy: '/home/u/.netrc'`. */
const EBUSY_QUOTED_PATH_AFTER =
  /Device or resource busy:\s*["']([^"'\n]+)["']/g;
/** Unquoted absolute path BEFORE the marker (`tee: /home/u/.netrc: Device or
 *  resource busy`). */
const EBUSY_UNQUOTED_ABS_PATH =
  /(?:^|\s)(\/[^\s"']+):\s*Device or resource busy/g;

function ebusyLines(stderr: string): readonly string[] {
  return stderr.split("\n").filter((line) => EBUSY_LINE_PATTERN.test(line));
}

const EBUSY_PATH_PATTERNS: readonly RegExp[] = [
  EBUSY_QUOTED_PATH_BEFORE,
  EBUSY_QUOTED_PATH_AFTER,
  EBUSY_UNQUOTED_ABS_PATH,
];

/**
 * The EBUSY boundary refusal for one target class. Kept as its own renderer
 * (not a flag on the EROFS one) so neither copy can be edited into the other.
 * The refusal says what happened — the file is a mount point the fence holds
 * open, so the kernel refused the unlink — and then says the thing that
 * matters for the next tool call: there is nothing to retry, escalate to, or
 * clean up around, because the session cannot remove this target at all.
 */
export function protectedTargetEbusyGuidance(
  stderr: string,
  targetClass: string
): string | undefined {
  const lines = ebusyLines(stderr);
  if (lines.length === 0) return undefined;
  const shown = lines.slice(0, MAX_EBUSY_CLUE_LINES);
  const rest = lines.length - shown.length;
  const classPhrase = describeProtectedTargetClass(targetClass);
  return (
    `${VIOLATION_PREFIXES.fsDenied} the refused operation targeted ${classPhrase}: ` +
    `this protected target is an individually masked mount point inside the ` +
    `sandbox fence, and the kernel (EBUSY) refused the operation at the ` +
    `filesystem layer. This is a boundary refusal, not a command-syntax ` +
    `judgment — re-spelling the command will not help. This session cannot ` +
    `remove ${classPhrase} at all: no permission, no flag and no ordering of ` +
    `this command will make it removable while the boundary is in place. ` +
    `Attempted paths (from stderr): ${shown.join(" | ")}` +
    (rest > 0 ? ` (+${rest} more EBUSY lines)` : "")
  );
}

/**
 * Resolve the EBUSY boundary refusal: keep only EBUSY lines naming a path this
 * fence actually masked with `/dev/null`, resolve that path's class through
 * the inventory (so a subtree-seeded mask gets its subtree's class, not a
 * guessed one), and render one message per distinct class.
 *
 * `exactFileMaskPaths` is the fence's OWN emitted mask list — the single
 * correlation point. An EBUSY line naming anything else (a device the session
 * never masked, a path in a sibling assembly, a line with no parseable path)
 * is another boundary's message and passes through byte-identical as
 * `undefined`. Guidance is advisory: it annotates, it never relabels.
 */
export function protectedTargetEbusyFenceGuidance(
  stderr: string,
  inventory: ProtectedTargetInventory,
  exactFileMaskPaths: readonly string[]
): string | undefined {
  if (exactFileMaskPaths.length === 0) return undefined;
  // The correlation point: an emitted mask, not merely a protected path.
  const masked = new Set(exactFileMaskPaths);
  const groups = groupLinesByProtectedClass(
    ebusyLines(stderr),
    inventory,
    EBUSY_PATH_PATTERNS,
    (path) => masked.has(path)
  );
  if (groups.size === 0) return undefined;
  return renderBoundaryRefusals(groups, protectedTargetEbusyGuidance);
}
