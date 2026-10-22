/**
 * `loadIknowSettings` memoization — cache hit, invalidation, frozen return.
 *
 * The loader memoizes its result inside its own module, keyed by the metadata
 * of the two source files (user `~/.iknow/settings.json`, project
 * `<cwd>/.iknow/settings.json`): existence plus, for the realpath'd target,
 * `(dev, ino, size, mtimeNs, ctimeNs)`. A file whose mtime is within a 2-second
 * window of now bypasses the cache so a just-edited file is re-read — the
 * security invariant (`src/harness/trace/jsonl.ts` re-fetches
 * `currentSecretValues()` before every write and must see a fresh settings
 * read). Stat / read failures never serve stale cache.
 *
 * Tests here pin:
 *  1. a cache hit actually happens (same object instance on the second call);
 *  2. the security invariant: rewriting apiKey is visible on the next read;
 *  3. creating a previously-absent source file invalidates the cache;
 *  4. the frozen contract (matching tests/config/settings.test.ts:301-316);
 *  5. injected `onWarn` bypasses the cache (side-effect channel contract,
 *     matching tests/config/settings.test.ts:1821-1865);
 *  6. probe failure semantics match `readSettingsFile`'s `existsSync` guard:
 *     an unstattable source file (ELOOP — the chmod-free errno case) does not
 *     throw and yields `{}` for that layer, a directory still throws EISDIR
 *     from the real read, and a failed probe never serves a previously cached
 *     value.
 *  7. the 2-second freshness branch itself (the `fresh` bypass in
 *     `settingsCacheKey`): a just-written file whose mtime is inside the
 *     window is never served from cache — two immediate reads return distinct
 *     instances with equal content. This is the one invalidation mechanism
 *     that still fires when a rewrite preserves mtime (backup/sync tooling),
 *     the residual risk ADR-0143 §3 accepts; the window is "the security
 *     invariant, not a heuristic".
 *
 * Every case mints its own random tmp dirs (the `makeSettings` pattern in
 * tests/config/settings.test.ts:47-49) and never touches the real ~/.iknow.
 * All apiKey values are synthetic placeholders, never real credentials.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIknowSettings } from "../../src/config/settings.ts";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-settings-memo-test-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Mints a fresh random home/cwd pair per call (isolation), optionally writing
 * each layer's settings file. Mirrors tests/config/settings.test.ts:44-65.
 */
async function makeDirs(opts?: {
  user?: Record<string, unknown>;
  project?: Record<string, unknown>;
}): Promise<{ home: string; cwd: string }> {
  const home = join(workDir, "home", `${Math.random().toString(36).slice(2)}`);
  const cwd = join(workDir, "cwd", `${Math.random().toString(36).slice(2)}`);
  await mkdir(join(home, ".iknow"), { recursive: true });
  await mkdir(join(cwd, ".iknow"), { recursive: true });
  if (opts?.user !== undefined) {
    await writeFile(
      join(home, ".iknow", "settings.json"),
      JSON.stringify(opts.user)
    );
  }
  if (opts?.project !== undefined) {
    await writeFile(
      join(cwd, ".iknow", "settings.json"),
      JSON.stringify(opts.project)
    );
  }
  return { home, cwd };
}

/**
 * Ages a file's mtime to 10 seconds ago (outside the 2-second window).
 * Age ONCE before the reads that must hit: `utimesSync` itself is an inode
 * metadata write, so it bumps ctime — re-aging between two reads changes the
 * cached key's ctimeNs component and forces a legitimate miss.
 */
function ageFile(path: string): void {
  const old = new Date(Date.now() - 10_000);
  utimesSync(path, old, old);
}

/**
 * Replaces a settings path with a symlink loop: `settings.json` → `loop-a` →
 * `loop-b` → `loop-a`. Every stat of the path fails with ELOOP — the one
 * errno this environment can produce without chmod — and `existsSync` (the
 * guard `readSettingsFile` relies on) reports `false` for it, exactly as it
 * does for ENOENT. The memo probe must classify an unstattable path the same
 * way, or a path that today degrades to `{}` would start throwing.
 * EACCES / ENAMETOOLONG are reasoned-only here (chmod denied in this
 * environment; ENAMETOOLONG additionally verified by a throwaway node probe).
 * An existing file or directory at the target path is replaced.
 */
function makeSymlinkLoop(dir: string): void {
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, "settings.json"), { force: true, recursive: true });
  symlinkSync("loop-a", join(dir, "settings.json"));
  symlinkSync("loop-b", join(dir, "loop-a"));
  symlinkSync("loop-a", join(dir, "loop-b"));
}

// Deliberately NOT shaped like a real API key (no `sk-` prefix): the values are
// synthetic placeholders, and the commit secret scan must stay clean.
const KEY_A = "synthetic-memo-placeholder-key-a";
const KEY_B = "synthetic-memo-placeholder-key-b";

describe("loadIknowSettings — internal memoization", () => {
  it("serves a cache hit: two aged reads return the same frozen instance", async () => {
    const { home, cwd } = await makeDirs({ user: { llm: { model: "m1" } } });
    const userPath = join(home, ".iknow", "settings.json");
    ageFile(userPath);

    const a = loadIknowSettings({ home, cwd });
    const b = loadIknowSettings({ home, cwd });

    assert.ok(Object.isFrozen(a), "result must be frozen");
    assert.equal(a, b, "second read must return the same cached instance");
  });

  it("security invariant: a fresh-mtime file is never served from cache", async () => {
    const { home, cwd } = await makeDirs({ user: { llm: { model: "m1" } } });

    // Deliberately NO ageFile: the just-written file's mtime is inside the
    // 2-second window, so both calls must bypass the memo via the
    // `userMeta.fresh || projectMeta.fresh` branch and re-read. Every other
    // invalidation mechanism (metadata tuple, absent fragment) is masked when
    // a rewrite preserves mtime — this branch is the only one that still
    // fires there, which is why ADR-0143 §3 calls the window the security
    // invariant rather than a heuristic.
    const a = loadIknowSettings({ home, cwd });
    const b = loadIknowSettings({ home, cwd });

    assert.ok(
      !Object.is(a, b),
      "a fresh-mtime file must never be served from cache: both reads bypass and return distinct instances"
    );
    assert.deepEqual(
      a,
      b,
      "both bypassing reads still produce the same content"
    );
    assert.ok(Object.isFrozen(a), "result must be frozen");
  });

  it("security invariant: rewriting apiKey after a hit returns the new value", async () => {
    const { home, cwd } = await makeDirs({
      user: { llm: { apiKey: KEY_A } },
    });
    const userPath = join(home, ".iknow", "settings.json");

    // Age past the 2-second window, read (populates the cache with KEY_A).
    ageFile(userPath);
    assert.equal(
      loadIknowSettings({ home, cwd }).llm?.apiKey,
      KEY_A,
      "precondition: the aged first read returned the original key"
    );

    // Rewrite with a different key and age again — the next read must see it.
    await writeFile(userPath, JSON.stringify({ llm: { apiKey: KEY_B } }));
    ageFile(userPath);
    assert.equal(
      loadIknowSettings({ home, cwd }).llm?.apiKey,
      KEY_B,
      "a rewritten apiKey must be visible on the very next read, never a stale masked set"
    );
  });

  it("creating a previously-absent project file invalidates the cached absent state", async () => {
    const { home, cwd } = await makeDirs({ user: { llm: { model: "m1" } } });
    const projectPath = join(cwd, ".iknow", "settings.json");

    // Age the user file so this read can populate the cache (project absent).
    ageFile(join(home, ".iknow", "settings.json"));
    const a = loadIknowSettings({ home, cwd });
    const b = loadIknowSettings({ home, cwd });
    assert.equal(
      b,
      a,
      "the absent-project state itself must be served from the cache"
    );

    // Create the project file, age it (its own fresh mtime would otherwise
    // force a re-read and make the invalidation assertion vacuous).
    await writeFile(projectPath, JSON.stringify({ verify: { maxRounds: 3 } }));
    ageFile(projectPath);

    const after = loadIknowSettings({ home, cwd });
    assert.deepEqual(
      after,
      { llm: { model: "m1" }, verify: { maxRounds: 3 } },
      "the newly created project file must be visible after the cached-absent state"
    );
  });

  it("cache hits return the deep-frozen object: nested mutation throws (strict mode)", async () => {
    const { home, cwd } = await makeDirs({
      user: { llm: { maxTurns: 20, compress: { contextWindow: 200000 } } },
    });
    ageFile(join(home, ".iknow", "settings.json"));

    const s = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.llm));
    assert.ok(Object.isFrozen(s.llm!.compress));
    assert.throws(() => {
      (s.llm as { maxTurns: number }).maxTurns = 99;
    }, TypeError);
    assert.throws(() => {
      (s.llm!.compress as { contextWindow: number }).contextWindow = 1;
    }, TypeError);
  });

  it("injected onWarn bypasses the cache and receives warnings on every call", async () => {
    const { home, cwd } = await makeDirs({
      user: { llm: { model: "u" } },
      project: { llm: { model: "p" } }, // project llm → dropped + warned, every call
    });
    ageFile(join(home, ".iknow", "settings.json"));
    ageFile(join(cwd, ".iknow", "settings.json"));

    const warnings: string[] = [];
    const onWarn = (m: string): void => {
      warnings.push(m);
    };
    for (let i = 0; i < 3; i++) {
      loadIknowSettings({ home, cwd, onWarn });
    }
    assert.equal(
      warnings.length,
      3,
      `injected channel must see the warning on EVERY call: ${JSON.stringify(warnings)}`
    );
    assert.match(warnings[0]!, /"llm"/);
  });

  it("an unstattable project file does not throw and yields {} for that layer", async () => {
    const { home, cwd } = await makeDirs({ user: { llm: { model: "m1" } } });
    makeSymlinkLoop(join(cwd, ".iknow"));

    const s = loadIknowSettings({ home, cwd });
    assert.deepEqual(
      s,
      { llm: { model: "m1" } },
      "an ELOOP project layer must degrade to {} like the pre-memo existsSync guard, not crash"
    );
  });

  it("a settings path that is a directory still throws EISDIR from the real read", async () => {
    const { home, cwd } = await makeDirs({ user: { llm: { model: "m1" } } });
    await mkdir(join(cwd, ".iknow", "settings.json"));

    // existsSync returns true for a directory, so the memo probe must treat it
    // as present (its own key fragment) and the real read must throw EISDIR —
    // never swallowed into {} (pinned in the same shape by
    // tests/config/subagent-settings.test.ts "propagates non-JSON user
    // settings file read errors").
    assert.throws(() => loadIknowSettings({ home, cwd }), { code: "EISDIR" });
  });

  it("an unstattable file never serves a previously cached value", async () => {
    // Project-layer content uses `verify` (one of the three allowlisted
    // top-level project keys): an `llm` key in the project file is dropped by
    // the allowlist before the cache could ever matter for it.
    const { home, cwd } = await makeDirs({
      user: { llm: { apiKey: KEY_A } },
      project: { verify: { maxRounds: 3 } },
    });
    const projectPath = join(cwd, ".iknow", "settings.json");
    ageFile(join(home, ".iknow", "settings.json"));
    ageFile(projectPath);
    assert.deepEqual(
      loadIknowSettings({ home, cwd }).verify,
      { maxRounds: 3 },
      "precondition: the cached value carries the project's verify section"
    );

    // Replace the project path with a symlink loop (fresh mtime is moot: a
    // loop has none). The probe must not classify the loop as "the same file
    // as before" — the absent fragment cannot match a present-file key — so
    // the load re-runs; were the loop hiding a layer that throws, the throw
    // would surface here instead of the cached value. Observed via the
    // project layer degrading to {} (the loop's existsSync result) while the
    // untouched user layer still supplies its values.
    makeSymlinkLoop(join(cwd, ".iknow"));
    assert.deepEqual(
      loadIknowSettings({ home, cwd }),
      { llm: { apiKey: KEY_A } },
      "the looped project layer contributes {} — no stale cached verify section, no throw"
    );

    // And after the loop is replaced by a real file, the new content must be
    // visible: the loop never poisoned the cache. (writeFile follows the
    // leftover symlinks, so remove the whole chain before rewriting.)
    rmSync(projectPath);
    rmSync(join(cwd, ".iknow", "loop-a"));
    rmSync(join(cwd, ".iknow", "loop-b"));
    await writeFile(projectPath, JSON.stringify({ verify: { maxRounds: 7 } }));
    ageFile(projectPath);
    assert.deepEqual(
      loadIknowSettings({ home, cwd }).verify,
      { maxRounds: 7 },
      "a file replacing the loop must be read fresh, not served from the poisoned cache"
    );
  });
});
