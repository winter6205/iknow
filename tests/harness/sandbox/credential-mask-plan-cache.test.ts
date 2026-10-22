/**
 * Credential read-mask plan cache — the session-scoped holder that lets one
 * session reuse ONE credential read-mask plan across fence assemblies (perf:
 * without the holder every assembly re-walks the credential subtrees).
 *
 * What the holder promises, and what this suite pins:
 *   - the plan is reused only while the plan's INPUTS are unchanged AND every
 *     fs identity the plan depends on still holds; any change rebuilds it;
 *   - the holder is PER INSTANCE (one per bash-tool factory, i.e. one per
 *     session): two holders share nothing, and no plan survives the session
 *     that produced it;
 *   - the holder is OPT-IN: with no holder the fence factory computes the plan
 *     per assembly, and the emitted argv is byte-identical to the held one;
 *   - the retired-fence path never consults and never populates a holder.
 *
 * Observability: the credential-subtree walk is counted at the `node:fs`
 * level. `vi.mock("node:fs", ...)` wraps `importActual` and counts the
 * `readdirSync` calls the mask plan makes under the credential subtree; every
 * call is delegated to the real implementation, so the mock observes a
 * DEPENDENCY of the subject and fakes none of the subject's behaviour. (A
 * `vi.spyOn` on `node:fs` cannot do this: it throws "Cannot spy on export
 * \"readdirSync\". Module namespace is not configurable in ESM.") Every case
 * below ALSO asserts the behavioural outcome — the emitted argv and the
 * emitted `/dev/null` mask dests — so no case rests on the counter alone.
 *
 * The fence factory is called with a no-op availability probe: these cases
 * assert ARGV CONSTRUCTION, and whether the host has bwrap installed is not
 * what is under test.
 *
 * Fixture discipline: every home, scan scope and session tmp root lives in a
 * mkdtemp scratch root, cleaned with the suite. No host credential file is
 * read or written.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, it, vi } from "vitest";

import {
  createBwrapFence,
  type BwrapFence,
} from "../../../src/harness/sandbox/bwrap.js";
import {
  createMaskPlanCache,
  type MaskPlanCache,
} from "../../../src/harness/sandbox/credential-read-mask.js";
import type { EgressFenceSpec } from "../../../src/harness/sandbox/egress/session.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createProtectedTargetInventory } from "../../../src/harness/sandbox/protected-targets.js";

// The fs-level call counter. `vi.hoisted` puts it in scope before the hoisted
// `vi.mock` factory below runs.
const fsCounter = vi.hoisted(() => ({ readdirPaths: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (path: string, options?: unknown) => {
      fsCounter.readdirPaths.push(String(path));
      return options === undefined
        ? actual.readdirSync(path)
        : actual.readdirSync(path, options as never);
    },
  };
});

// ── fixtures ───────────────────────────────────────────────────────────────

const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

afterAll(() => {
  for (const p of scratch.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

/** A home holding the given relative files (credential-arm fixtures). */
function makeHome(
  prefix: string,
  files: Readonly<Record<string, string>>
): string {
  const home = scratchDir(prefix);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(home, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return home;
}

const HOME = scratchDir("iknow-maskcache-home-");
const TASK = scratchDir("iknow-maskcache-task-");
const TMP = scratchDir("iknow-maskcache-tmp-");

const SSH_DIR = join(HOME, ".ssh");
const SSH_CONFIG = join(SSH_DIR, "config");
const AWS_DIR = join(HOME, ".aws");
const AWS_CREDENTIALS = join(AWS_DIR, "credentials");
const GH_DIR = join(HOME, ".config", "gh");
const GH_HOSTS = join(GH_DIR, "hosts.yml");

beforeAll(() => {
  mkdirSync(SSH_DIR, { recursive: true });
  writeFileSync(SSH_CONFIG, "k\n");
  mkdirSync(AWS_DIR, { recursive: true });
  writeFileSync(AWS_CREDENTIALS, "a\n");
  mkdirSync(GH_DIR, { recursive: true });
  writeFileSync(GH_HOSTS, "github.com:\n  oauth_token: fake\n");
});

/** The cover root the mask plan writes its generated sources under. */
const COVER_ROOT = join(TMP, "protected-credential-cover");

/** The deterministic fallback-cover directory name for one subtree path. */
function fallbackCoverDir(subtreePath: string): string {
  return join(
    COVER_ROOT,
    createHash("sha256").update(subtreePath).digest("hex").slice(0, 24)
  );
}

/** The deterministic gh default-config directory name for one config path. */
function ghDefaultConfigDir(configPath: string): string {
  return join(
    COVER_ROOT,
    `gh-default-config-${createHash("sha256")
      .update(configPath)
      .digest("hex")
      .slice(0, 24)}`
  );
}

// ── assembly helper ────────────────────────────────────────────────────────

interface AssembledFence {
  readonly argv: readonly string[];
  readonly exactFileMaskPaths: readonly string[];
}

function assemble(opts: {
  readonly home: string;
  readonly scanRoot?: string;
  readonly tmpRoot?: string;
  readonly maskCache?: MaskPlanCache;
  readonly fenceRetired?: boolean;
  readonly egress?: EgressFenceSpec;
}): AssembledFence {
  const fence: BwrapFence = createBwrapFence(
    {
      command: "bash",
      args: ["-c", "true"],
      fsPolicy: createFsPolicy({
        tmpDir: opts.tmpRoot ?? TMP,
        mode: "global",
      }),
      env: { PATH: "/bin" },
      cwd: TASK,
      protectedTargets: createProtectedTargetInventory({
        home: opts.home,
        scanRoot: opts.scanRoot ?? TASK,
      }),
      protectCredentialReads: true,
      ...(opts.maskCache === undefined ? {} : { maskCache: opts.maskCache }),
      ...(opts.fenceRetired === undefined
        ? {}
        : { fenceRetired: opts.fenceRetired }),
      ...(opts.egress === undefined ? {} : { egress: opts.egress }),
      // The absent-target skip diagnostics are not what this suite is about;
      // the default warn channel would print one line per absent credential
      // source on every assembly.
      onProtectedTargetSkipped: () => {},
    },
    () => {}
  );
  return { argv: fence.argv, exactFileMaskPaths: fence.exactFileMaskPaths };
}

/**
 * The cover source bound at `dest`: the LAST `--ro-bind` whose source is not
 * the dest itself. The write block's self-bind (`--ro-bind <dest> <dest>`) is
 * not a cover, and the per-file `/dev/null` mask of the same dest comes before
 * the coordination re-emission, so the last non-self source is the cover.
 */
function coverSrcFor(
  argv: readonly string[],
  dest: string
): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < argv.length - 2; i += 1) {
    if (argv[i] !== "--ro-bind" || argv[i + 2] !== dest) continue;
    const src = argv[i + 1]!;
    if (src === dest) continue;
    found = src;
  }
  return found;
}

/** The `readdirSync` calls made under `root` since the last counter reset. */
function readsUnder(root: string): readonly string[] {
  return fsCounter.readdirPaths.filter(
    (path) => path === root || path.startsWith(`${root}/`)
  );
}

function resetFsCounter(): void {
  fsCounter.readdirPaths.length = 0;
}

// ── cases ──────────────────────────────────────────────────────────────────

describe("credential read-mask plan cache", () => {
  it("C1 inputs unchanged → the second build does not re-run the mask plan's synchronous fs", () => {
    const cache = createMaskPlanCache();

    resetFsCounter();
    const first = assemble({ home: HOME, maskCache: cache });
    const firstWalks = readsUnder(SSH_DIR);
    assert.ok(
      firstWalks.length > 0,
      "the first build walks the credential subtree (the plan is built fresh)"
    );

    resetFsCounter();
    const second = assemble({ home: HOME, maskCache: cache });
    assert.deepEqual(
      [...readsUnder(SSH_DIR)],
      [],
      "the second build must not re-walk the credential subtree"
    );
    assert.deepEqual(
      [...second.argv],
      [...first.argv],
      "the reused plan emits the same argv"
    );
    assert.deepEqual(
      [...second.exactFileMaskPaths],
      [...first.exactFileMaskPaths],
      "the reused plan emits the same /dev/null mask dests"
    );
    assert.ok(
      first.exactFileMaskPaths.includes(SSH_CONFIG) &&
        first.exactFileMaskPaths.includes(AWS_CREDENTIALS),
      "the shared plan really masks the credential files"
    );
  });

  it("C2 invalidation by fs change → a new file under the masked subtree is masked by the next build", () => {
    const home = makeHome("iknow-maskcache-c2-home-", {
      ".ssh/config": "k\n",
    });
    const added = join(home, ".ssh", "id_ed25519");
    const cache = createMaskPlanCache();

    const first = assemble({ home, maskCache: cache });
    assert.ok(
      !first.exactFileMaskPaths.includes(added),
      "the added file does not exist yet"
    );

    writeFileSync(added, "k\n");
    const second = assemble({ home, maskCache: cache });
    assert.ok(
      second.exactFileMaskPaths.includes(added),
      "the new credential file must be masked by the next build"
    );
    assert.ok(
      second.argv.includes("/dev/null") && second.argv.includes(added),
      "the new file gets its own /dev/null mask token"
    );
  });

  it("C3 invalidation by changed inputs → a changed inventory yields a different key and a fresh plan", () => {
    const other = makeHome("iknow-maskcache-c3-home-", {
      ".ssh/other-key": "k\n",
    });
    const otherKey = join(other, ".ssh", "other-key");
    const cache = createMaskPlanCache();

    const first = assemble({ home: HOME, maskCache: cache });
    assert.ok(first.exactFileMaskPaths.includes(SSH_CONFIG));

    const second = assemble({ home: other, maskCache: cache });
    assert.ok(
      second.exactFileMaskPaths.includes(otherKey),
      "the changed inventory must be reflected, not the stale plan"
    );
    assert.ok(
      !second.exactFileMaskPaths.includes(SSH_CONFIG),
      "the stale plan's mask set must not survive the inventory change"
    );
  });

  it("C3 invalidation by changed inputs → a changed materialized-target set yields a different key and a fresh plan", () => {
    const scanRoot = scratchDir("iknow-maskcache-c3-scan-");
    const cache = createMaskPlanCache();

    const first = assemble({ home: HOME, scanRoot, maskCache: cache });
    assert.ok(
      !first.exactFileMaskPaths.some((path) => path.startsWith(scanRoot)),
      "the scan scope holds no name-pattern match yet"
    );

    const pem = join(scanRoot, "materialized.pem");
    writeFileSync(pem, "k\n");
    const second = assemble({ home: HOME, scanRoot, maskCache: cache });
    assert.ok(
      second.exactFileMaskPaths.includes(pem),
      "the newly materialized match must be masked by the next build"
    );
  });

  it("C4 the holder is per-instance → a fresh holder redoes the work and still yields the correct result", () => {
    const holderA = createMaskPlanCache();

    resetFsCounter();
    const viaA = assemble({ home: HOME, maskCache: holderA });
    assert.ok(readsUnder(SSH_DIR).length > 0, "holder A builds the plan");

    const holderB = createMaskPlanCache();
    resetFsCounter();
    const viaB = assemble({ home: HOME, maskCache: holderB });
    assert.ok(
      readsUnder(SSH_DIR).length > 0,
      "holder B must build its own plan — no module-level cache exists"
    );
    assert.deepEqual(
      [...viaB.argv],
      [...viaA.argv],
      "both holders produce the same argv"
    );
    assert.deepEqual(
      [...viaB.exactFileMaskPaths],
      [...viaA.exactFileMaskPaths],
      "both holders produce the same mask dests"
    );
  });

  it("C5 the retired fence path is unaffected → bare argv, no mask dests, holder untouched", () => {
    const inner = createMaskPlanCache();
    let consulted = 0;
    const counting: MaskPlanCache = {
      resolve: (args) => {
        consulted += 1;
        return inner.resolve(args);
      },
    };

    const retired = assemble({
      home: HOME,
      maskCache: counting,
      fenceRetired: true,
    });
    assert.deepEqual([...retired.argv], ["bash", "-c", "true"]);
    assert.deepEqual([...retired.exactFileMaskPaths], []);
    assert.equal(consulted, 0, "the retired path must not consult the holder");

    // The holder was neither consulted nor populated: the next real build
    // still produces the full mask set.
    const after = assemble({ home: HOME, maskCache: counting });
    assert.equal(consulted, 1);
    assert.ok(
      after.exactFileMaskPaths.includes(SSH_CONFIG),
      "the holder builds the plan itself after the retired call"
    );
  });

  it("C6 the fallback cover directory is created private (0700)", () => {
    const home = makeHome("iknow-maskcache-c6-home-", {
      ".ssh/config": "k\n",
    });
    const sshDir = join(home, ".ssh");
    // A colliding sentinel dest with NO mount point on the host: the plan
    // takes the empty-subtree fallback branch and mints a cover directory.
    const maskedSrc = join(TMP, "masked-hosts.yml");
    writeFileSync(maskedSrc, "github.com:\n  oauth_token: fake\n");
    const egress: EgressFenceSpec = {
      unixSocketPath: "",
      sandboxLocalPort: 3128,
      env: {},
      innerBridgeScript: "",
      relayAssetsDir: "",
      binds: [
        {
          src: maskedSrc,
          dest: join(sshDir, "hosts.yml"),
          readonly: true,
        },
      ],
    };

    const { argv } = assemble({ home, egress });
    const cover = coverSrcFor(argv, sshDir);
    assert.ok(cover !== undefined, "the fallback cover bind is emitted");
    assert.equal(cover, fallbackCoverDir(sshDir));
    assert.equal(
      statSync(cover).mode & 0o777,
      0o700,
      "the fallback cover directory is private (0700)"
    );
  });

  it("C6 a wrongly-permissioned placeholder directory is not reused and never mutated", () => {
    const home = makeHome("iknow-maskcache-c6-foreign-home-", {
      ".ssh/config": "k\n",
    });
    const sshDir = join(home, ".ssh");
    const maskedSrc = join(TMP, "masked-hosts-foreign.yml");
    writeFileSync(maskedSrc, "github.com:\n  oauth_token: fake\n");
    const egress: EgressFenceSpec = {
      unixSocketPath: "",
      sandboxLocalPort: 3128,
      env: {},
      innerBridgeScript: "",
      relayAssetsDir: "",
      binds: [
        {
          src: maskedSrc,
          dest: join(sshDir, "hosts.yml"),
          readonly: true,
        },
      ],
    };

    // A pre-existing placeholder with the right name AND the right entry set
    // but the wrong mode: it is foreign, so it must be neither reused nor
    // mutated. (The entry set matches, so the mode/owner check is the only
    // thing standing between this directory and a reuse.)
    const foreign = fallbackCoverDir(sshDir);
    mkdirSync(foreign, { recursive: true, mode: 0o755 });
    chmodSync(foreign, 0o755);
    writeFileSync(join(foreign, "hosts.yml"), "planted\n");

    const { argv } = assemble({ home, egress });
    const cover = coverSrcFor(argv, sshDir);
    assert.ok(cover !== undefined, "the fallback cover bind is emitted");
    assert.notEqual(
      cover,
      foreign,
      "the wrongly-permissioned placeholder must not be reused"
    );
    assert.ok(
      cover.startsWith(`${fallbackCoverDir(sshDir)}-`),
      "a fresh sibling directory is minted instead"
    );
    assert.equal(
      statSync(foreign).mode & 0o777,
      0o755,
      "the pre-existing directory is never re-permissioned"
    );
    assert.deepEqual(
      [...readdirSync(foreign)],
      ["hosts.yml"],
      "the pre-existing directory keeps exactly its own entries"
    );
    assert.equal(
      readFileSync(join(foreign, "hosts.yml"), "utf8"),
      "planted\n",
      "the pre-existing directory is never written into"
    );
    assert.equal(
      statSync(cover).mode & 0o777,
      0o700,
      "the freshly minted cover directory is private (0700)"
    );
  });

  it("C7 the gh default-config directory reuse validates owner+mode", () => {
    const home = makeHome("iknow-maskcache-c7-home-", {
      ".config/gh/config.yml": "git_protocol: ssh\n",
    });
    const ghConfig = join(home, ".config", "gh", "config.yml");

    // A pre-existing default-config directory with the right name AND the
    // right content but the wrong mode: it is foreign, so the plan must not
    // reuse it.
    const foreign = ghDefaultConfigDir(ghConfig);
    mkdirSync(foreign, { recursive: true, mode: 0o755 });
    chmodSync(foreign, 0o755);
    writeFileSync(join(foreign, "config.yml"), "{}\n");

    const { argv } = assemble({ home });
    const src = coverSrcFor(argv, ghConfig);
    assert.ok(src !== undefined, "the gh default-config bind is emitted");
    assert.notEqual(
      src,
      join(foreign, "config.yml"),
      "the wrongly-permissioned default-config directory must not be reused"
    );
    assert.equal(
      statSync(foreign).mode & 0o777,
      0o755,
      "the pre-existing directory is never re-permissioned"
    );
    assert.deepEqual(
      [...readdirSync(foreign)],
      ["config.yml"],
      "the pre-existing directory keeps exactly its own entries"
    );
    assert.equal(
      readFileSync(join(foreign, "config.yml"), "utf8"),
      "{}\n",
      "the pre-existing directory is never written into"
    );
    assert.equal(
      readFileSync(src, "utf8"),
      "{}\n",
      "the freshly minted default-config source carries the safe defaults"
    );
  });

  it("C7 a tampered gh default-config source is preserved but never used", () => {
    const home = makeHome("iknow-maskcache-c7-tamper-home-", {
      ".config/gh/config.yml": "git_protocol: ssh\n",
    });
    const ghConfig = join(home, ".config", "gh", "config.yml");
    const cache = createMaskPlanCache();

    const first = assemble({ home, maskCache: cache });
    const generated = coverSrcFor(first.argv, ghConfig);
    assert.ok(generated !== undefined, "the gh default-config bind is emitted");
    assert.equal(readFileSync(generated, "utf8"), "{}\n");

    writeFileSync(generated, "git_protocol: ssh\n");
    const second = assemble({ home, maskCache: cache });
    const regenerated = coverSrcFor(second.argv, ghConfig);
    assert.ok(regenerated !== undefined);
    assert.notEqual(
      regenerated,
      generated,
      "a tampered source is never reused — a fresh safe view is minted"
    );
    assert.equal(
      readFileSync(generated, "utf8"),
      "git_protocol: ssh\n",
      "the tampered directory is preserved, not repaired"
    );
    assert.equal(readFileSync(regenerated, "utf8"), "{}\n");
  });

  it("C8 no holder → the argv is the same as with one (the cache is opt-in and transparent)", () => {
    const withoutHolder = assemble({ home: HOME });
    const withHolder = assemble({
      home: HOME,
      maskCache: createMaskPlanCache(),
    });
    assert.deepEqual([...withHolder.argv], [...withoutHolder.argv]);
    assert.deepEqual(
      [...withHolder.exactFileMaskPaths],
      [...withoutHolder.exactFileMaskPaths]
    );
  });
});
