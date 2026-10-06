/**
 * Per-file atomic publish (ADR-0136 / specs/session-checkpoint-architecture.md
 * §3 item 5, SC10).
 *
 * Real temp directory + real filesystem: the claim under test is what a reader
 * on the other side of an interrupted write observes, so nothing here is
 * mocked. Two crash points are exercised by two different mechanisms, named
 * per case:
 *   - IN-PROCESS SEAM: the staging / post-publish callback throws, so the
 *     helper's own cleanup path runs (a handled failure — no debris).
 *   - REAL SIGKILL: a child process is killed by the OS at the same seam, so
 *     no cleanup can run at all. Strongest available evidence that the target
 *     bytes are wholly old or wholly new after a hard interruption.
 *
 * A staging file that survives a SIGKILL is expected and asserted as inert,
 * not as a defect: a killed process cannot run a `finally`.
 *
 * Child topology: the child is spawned as `node --import tsx/dist/esm/index.mjs
 * --input-type=module -e <script>`, NOT a bare `.ts` entry and NOT the tsx CLI.
 * CI pins Node 20 (`.github/workflows/test.yml`), which cannot execute a bare
 * `.ts` entry at all (ERR_UNKNOWN_FILE_EXTENSION — the same class recorded for
 * `tests/integration/mcp-resources-fixture.test.ts` in vitest.ci-excludes.ts);
 * tsx's ESM register supplies the transform instead of relying on Node's
 * type-stripping, so the child runs identically on Node 20 and Node 24. The
 * register entry (`dist/esm/index.mjs`) is used rather than `dist/cli.mjs` because
 * the CLI is a wrapper that spawns a second script layer and escalates a signal
 * to SIGKILL after ~30ms, which would destroy the real-SIGKILL seam this file
 * exists to prove — the child under test must BE the spawned process, so that
 * `process.kill(process.pid, "SIGKILL")` is observed as `signal === "SIGKILL"`.
 * (Same reasoning, and the same helper, as `tests/cli/register-shutdown.test.ts`.)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "vitest";

import { publishFile } from "../../src/util/atomic-file-publish.ts";

const PUBLISH_MODULE = new URL(
  "../../src/util/atomic-file-publish.ts",
  import.meta.url
).href;

/**
 * Locate tsx's ESM register entry, walking up from this file's directory to the
 * first `node_modules` that has it (a worktree's node_modules may be empty with
 * deps hoisted to the main repo). Uses `dist/esm/index.mjs` — the
 * `node --import` register entry — never `dist/cli.mjs`, the wrapper CLI.
 */
function resolveTsxEsm(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(
      dir,
      "node_modules",
      "tsx",
      "dist",
      "esm",
      "index.mjs"
    );
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // keep climbing
    }
    const parent = join(dir, "..");
    if (parent === dir) throw new Error("cannot locate tsx/dist/esm/index.mjs");
    dir = parent;
  }
}

const tsxEsm = resolveTsxEsm();

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "iknow-atomic-publish-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Debris check: the target's own directory must hold only what the test put
 *  there, i.e. a staged file was renamed away rather than left behind. */
async function dirEntries(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

const stageDebris = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((n) => n.startsWith("."));

describe("publishFile — atomic per-file publish", () => {
  it("(a) normal: an existing file is replaced atomically, mode preserved, no debris", async () => {
    const target = join(root, "a.ts");
    await writeFile(target, "old bytes\n", "utf8");
    await chmod(target, 0o640);

    const res = await publishFile(target, "new bytes\n");

    assert.equal(res.published, "atomic");
    assert.equal(res.reason, undefined, "atomic path claims no excuse");
    assert.equal(await readFile(target, "utf8"), "new bytes\n");
    // An in-place writeFile would silently reset a non-default mode; the
    // rename-replace must not.
    assert.equal((await stat(target)).mode & 0o7777, 0o640);
    assert.deepEqual(await stageDebris(root), []);
  });

  it("(b) create: an absent file is created atomically and takes the default mode", async () => {
    const target = join(root, "brand-new.ts");

    const res = await publishFile(target, "fresh\n");

    assert.equal(res.published, "atomic");
    assert.equal(await readFile(target, "utf8"), "fresh\n");
    assert.deepEqual(await stageDebris(root), []);
  });

  it("(c) empty content is a legal publish (boundary), not a no-op", async () => {
    const target = join(root, "truncate.ts");
    await writeFile(target, "something\n", "utf8");

    const res = await publishFile(target, "");

    assert.equal(res.published, "atomic");
    assert.equal(await readFile(target, "utf8"), "");
  });

  it("(d) repeated publishes leave the final bytes and no debris", async () => {
    const target = join(root, "rep.ts");
    await publishFile(target, "one");
    const second = await publishFile(target, "two");
    const third = await publishFile(target, "three");

    assert.equal(second.published, "atomic");
    assert.equal(third.published, "atomic");
    assert.equal(await readFile(target, "utf8"), "three");
    assert.deepEqual(await stageDebris(root), []);
  });

  it("(e) DEGRADES HONESTLY on a symlink target: writes through the link, keeps the link node", async () => {
    const real = join(root, "real.ts");
    const link = join(root, "link.ts");
    await writeFile(real, "old\n", "utf8");
    await symlink(real, link);

    const res = await publishFile(link, "new\n");

    // A rename onto the link path would replace the LINK NODE and silently
    // change symlink semantics — explicitly out of scope, so the helper must
    // report that it did not deliver the guarantee instead of claiming it.
    assert.equal(res.published, "in_place");
    assert.equal(typeof res.reason, "string");
    assert.ok(
      (res.reason ?? "").length > 0,
      "an in_place publish must say why it is not atomic"
    );
    assert.ok((await lstat(link)).isSymbolicLink(), "the link node survives");
    assert.equal(await readFile(real, "utf8"), "new\n");
  });

  it("(f) DEGRADES HONESTLY when the parent directory is a symlink", async () => {
    const realDir = join(root, "real-dir");
    const linkDir = join(root, "link-dir");
    await mkdir(realDir);
    await symlink(realDir, linkDir);

    const res = await publishFile(join(linkDir, "f.ts"), "via link\n");

    assert.equal(res.published, "in_place");
    assert.equal(typeof res.reason, "string");
    assert.equal(await readFile(join(realDir, "f.ts"), "utf8"), "via link\n");
  });

  it("(g) a non-regular existing target keeps today's failure instead of renaming over it", async () => {
    const asDir = join(root, "a-directory");
    await mkdir(asDir);

    // In-place writeFile on a directory is EISDIR today; a rename would have
    // "succeeded" in destroying the directory. The degrade keeps the refusal.
    await assert.rejects(() => publishFile(asDir, "x"), /EISDIR/);
    assert.ok((await lstat(asDir)).isDirectory());
  });

  it("(h) IN-PROCESS SEAM, before replacement: target stays wholly old, staging removed", async () => {
    const target = join(root, "crash-before.ts");
    const old = "wholly old\n";
    await writeFile(target, old, "utf8");

    await assert.rejects(
      () =>
        publishFile(target, "wholly new\n", {
          onStaged: () => {
            throw new Error("interrupted before replacement");
          },
        }),
      /interrupted before replacement/
    );

    assert.equal(await readFile(target, "utf8"), old, "bytes wholly old");
    assert.deepEqual(
      await stageDebris(root),
      [],
      "a handled failure removes its staging file"
    );
  });

  it("(i) IN-PROCESS SEAM, before replacement: the staged file is COMPLETE while the target is still wholly old", async () => {
    const target = join(root, "partial.ts");
    await writeFile(target, "old\n", "utf8");
    const newContent = "new\n";
    let targetDuringStage: string | undefined;
    let stagedDuringStage: string | undefined;

    await assert.rejects(() =>
      publishFile(target, newContent, {
        onStaged: async (stagingPath) => {
          targetDuringStage = await readFile(target, "utf8");
          stagedDuringStage = await readFile(stagingPath, "utf8");
          throw new Error("stop");
        },
      })
    );

    // This pair IS the atomicity argument: the complete new content exists
    // only under the staging name; the target is untouched until rename.
    assert.equal(targetDuringStage, "old\n");
    assert.equal(stagedDuringStage, newContent);
  });

  it("(j) IN-PROCESS SEAM, after replacement: target is wholly new", async () => {
    const target = join(root, "crash-after.ts");
    await writeFile(target, "old\n", "utf8");

    await assert.rejects(
      () =>
        publishFile(target, "wholly new\n", {
          onPublished: () => {
            throw new Error("interrupted after replacement");
          },
        }),
      /interrupted after replacement/
    );

    assert.equal(await readFile(target, "utf8"), "wholly new\n");
    assert.deepEqual(await stageDebris(root), []);
  });

  it("(k) REAL SIGKILL before replacement: a reader observes wholly old bytes", async () => {
    const target = join(root, "sigkill-before.ts");
    const old = "the original file body\n".repeat(200);
    const fresh = "the replacement file body\n".repeat(200);
    await writeFile(target, old, "utf8");

    runChildCrash(target, fresh, "onStaged");

    assert.equal(await readFile(target, "utf8"), old, "bytes wholly old");
    // Debris is expected here: SIGKILL runs no cleanup. It is inert — a
    // dot-prefixed sibling, not the target.
    const debris = await stageDebris(root);
    assert.equal(debris.length, 1, "exactly the un-renamed staging file");
    assert.notEqual(debris[0], "sigkill-before.ts");
  });

  it("(l) REAL SIGKILL after replacement: a reader observes wholly new bytes", async () => {
    const target = join(root, "sigkill-after.ts");
    await writeFile(target, "the original file body\n".repeat(200), "utf8");
    const fresh = "the replacement file body\n".repeat(200);

    runChildCrash(target, fresh, "onPublished");
    assert.equal(await readFile(target, "utf8"), fresh, "bytes wholly new");
  });

  it("(m) REAL SIGKILL before replacement: a later publish still lands cleanly beside the debris", async () => {
    const target = join(root, "sigkill-recover.ts");
    await writeFile(target, "old\n", "utf8");
    runChildCrash(target, "interrupted\n", "onStaged");

    // The killed run's staging file must not be reused or mistaken for the
    // target by the next attempt.
    const res = await publishFile(target, "second attempt\n");

    assert.equal(res.published, "atomic");
    assert.equal(await readFile(target, "utf8"), "second attempt\n");
    assert.deepEqual(
      await dirEntries(root),
      [...(await stageDebris(root)), "sigkill-recover.ts"].sort()
    );
  });
});

/**
 * Run the real publisher in a real child process that SIGKILLs itself at the
 * named seam. The seam and the payload travel by env because `node -e` takes
 * no positional arguments. Fails the test unless the OS actually reported the
 * signal, so this can never silently degrade into an in-process throw.
 *
 * `--import <tsx esm register>` is what makes the `.ts` import resolvable on
 * the Node 20 CI runner; without it the child dies at module load with
 * ERR_UNKNOWN_FILE_EXTENSION and `signal` is null instead of "SIGKILL".
 */
function runChildCrash(
  target: string,
  content: string,
  seam: "onStaged" | "onPublished"
): void {
  const script = `
    const { publishFile } = await import(${JSON.stringify(PUBLISH_MODULE)});
    const hook = { ${seam}: () => process.kill(process.pid, "SIGKILL") };
    await publishFile(process.env.TARGET_PATH, process.env.NEW_CONTENT, hook);
  `;
  const out = spawnSync(
    process.execPath,
    ["--import", tsxEsm, "--input-type=module", "-e", script],
    {
      encoding: "utf8",
      env: { ...process.env, TARGET_PATH: target, NEW_CONTENT: content },
    }
  );
  assert.equal(
    out.signal,
    "SIGKILL",
    `child did not die by SIGKILL (status=${String(out.status)}, ` +
      `stderr=${out.stderr})`
  );
}
