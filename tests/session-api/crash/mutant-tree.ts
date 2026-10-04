/**
 * Mutant-tree builder for the SC2 replay mutation control.
 *
 * The question this exists to answer is narrow: if the product DID replay a
 * restored `tool_use` on reopen, would the negative recovery assertion in
 * `fresh-process-recovery.test.ts` go red? Answering that needs a build of the
 * product that replays, and it must not be produced by patching the repository
 * in place — the whole suite is running in parallel forks against that same
 * source tree, so a mutation window there would leak into unrelated files.
 *
 * So the mutation is applied to a COPY: `src/` plus the three child-side test
 * files, a `package.json` (its `"type": "module"` is what lets tsx load the
 * entry), and symlinks for `node_modules` and `vendor`. The copy lives outside
 * the repository, the harness spawns the copy's own entry via
 * `createCrashHost({ hostEntryPath })`, and the copy is discarded afterwards.
 * The repository is never modified — `assertRepoSourceUnchanged` re-checks that
 * by digest after every mutant run rather than trusting the copy to be
 * self-contained.
 *
 * The slice below is the measured minimum, established by running the crash
 * child out of exactly this set: `src/` (482 files, 6.8 MB), the two crash
 * files, and `tests/cli/_fixtures.ts` (imported dynamically by the
 * `chat_turn` / `chat_turn`+tool arms). A missing piece fails loudly rather
 * than silently: without `package.json` the entry dies on a top-level-await
 * transform error, without `node_modules` on a module-not-found, without
 * `_fixtures.ts` on the dynamic import.
 */
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** One crash child needs these under the copy root, at these depths. */
const SLICE = [
  "src",
  "package.json",
  "tests/session-api/crash/crash-harness.ts",
  "tests/session-api/crash/crash-host-entry.ts",
  "tests/cli/_fixtures.ts",
] as const;

/** Symlinked rather than copied: both are large and both are read-only here. */
const SYMLINKED = ["node_modules", "vendor"] as const;

/**
 * Digest every COPIED file, path-ordered: the whole slice, not just `src/`.
 * Cheap (~7 MB) and blunt on purpose — the point is to detect that the mutant
 * run did not write through the symlinks into the real tree, not to attribute a
 * change to a cause. `src/` alone would leave the three copied test files
 * unwatched, which is wider than the claim the header makes.
 */
function digestSlice(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : 1)
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        hash.update(full.slice(root.length));
        hash.update(readFileSync(full));
      }
    }
  };
  for (const item of SLICE) {
    const full = join(root, item);
    if (lstatSync(full).isDirectory()) {
      walk(full);
    } else {
      hash.update(item);
      hash.update(readFileSync(full));
    }
  }
  return hash.digest("hex");
}

export type MutantTree = {
  /** Root of the copied tree; the copy's crash entry lives under it. */
  readonly root: string;
  /** Pass to `createCrashHost({ hostEntryPath })` to spawn the mutant. */
  readonly hostEntryPath: string;
  /** Digest of the real repository's copied slice, before the mutation. */
  readonly repoDigestBefore: string;
  /**
   * Re-read the real slice and throw if it moved. A caller must still wrap this
   * in a `try` whose `finally` calls `cleanup()` — otherwise the one case that
   * most needs the copy gone is the one case that keeps it.
   */
  assertRepoSourceUnchanged: () => void;
  readonly cleanup: () => void;
};

/**
 * Copy the slice into `copyRoot` and let `mutate` patch the copy. `repoRoot` is
 * the live checkout (working tree, not a commit) so the copy carries any
 * uncommitted test-harness state the arm under test depends on.
 */
export function buildMutantTree(
  repoRoot: string,
  copyRoot: string,
  mutate: (copyRoot: string) => void
): MutantTree {
  const repoDigestBefore = digestSlice(repoRoot);
  mkdirSync(copyRoot, { recursive: true });
  for (const item of SLICE) {
    cpSync(join(repoRoot, item), join(copyRoot, item), { recursive: true });
  }
  for (const item of SYMLINKED) {
    // A missing target is fine: `vendor/` is gitignored and absent from fresh
    // worktrees, and nothing in the SC2 path shells out to ripgrep. Symlinking
    // a non-existent path would break every subsequent child spawn instead.
    try {
      symlinkSync(join(repoRoot, item), join(copyRoot, item));
    } catch {
      /* absent in this checkout; the child does not need it */
    }
  }
  mutate(copyRoot);
  return {
    root: copyRoot,
    hostEntryPath: join(
      copyRoot,
      "tests/session-api/crash/crash-host-entry.ts"
    ),
    repoDigestBefore,
    assertRepoSourceUnchanged: () => {
      const after = digestSlice(repoRoot);
      if (after !== repoDigestBefore) {
        throw new Error(
          `mutant run modified the repository (${repoDigestBefore.slice(0, 12)} -> ${after.slice(0, 12)}); the mutation must stay inside the copy`
        );
      }
    },
    cleanup: () => {
      // Left to the caller's scratch sweep: the copy holds symlinks, and a
      // recursive delete that followed them would reach the real node_modules.
      for (const item of [...SLICE, ...SYMLINKED]) {
        rmOne(join(copyRoot, item));
      }
      rmOne(copyRoot);
    },
  };
}

/** Remove one path, unlinking symlinks without ever following them. */
function rmOne(path: string): void {
  try {
    // lstat, not stat: a symlink must be unlinked, never recursed into, or the
    // deletion would walk into the real node_modules it points at.
    if (lstatSync(path).isDirectory()) {
      rmSync(path, { recursive: true, force: true });
    } else {
      rmSync(path, { force: true });
    }
  } catch {
    /* already gone */
  }
}
