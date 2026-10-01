/**
 * T8 read-side control — protected credential sources are masked-value-or-nothing
 * inside the fence (specs/effect-boundary-protection.md SC4).
 *
 * Layer: a mount-level mask block emitted by createBwrapFence when
 * `protectCredentialReads` is set with a protected-target inventory — ONE
 * coordinated mount plan with the T7 write block, never a second
 * independently-stacked cover. It lands AFTER the T7 `--ro-bind` block and
 * before `--proc`:
 *   - directory-shaped credential sources (subtree entries) stay mounted as
 *     their REAL directories, read-only, and every regular file under them
 *     is individually `/dev/null`-covered: the real bytes are unreachable
 *     for every reader (the fence's nodev binds refuse the open outright;
 *     worst case elsewhere: the empty mask), while `rm -f <credential>`
 *     meets a truthful kernel EROFS from the read-only parent (an
 *     empty-subtree cover instead made rm exit 0 on the hidden name — the
 *     vacuous success this plan removes);
 *   - single-file credential sources (exact entries) are `/dev/null`-covered
 *     the same way;
 *   - an absent credential source contributes no tokens: its read is the
 *     ordinary host ENOENT, never a fabricated success and never a
 *     mount-assembly break (bwrap rejects missing bind sources);
 *   - where the egress credential-sentinel layer has masked a file under a
 *     covered subtree, that masked bind is re-emitted after the masks so the
 *     masked value stays reachable (coordination, not contradiction);
 *   - a bounded empty-subtree fallback exists ONLY above the per-subtree
 *     file budget (argv protection; presence hidden, deletion truthful for
 *     everything the fallback does not hide).
 *
 * Argv pins run everywhere; the effect matrix runs only on a host with bwrap
 * (`hasBwrap()` guard). Fixture HOME lives in mkdtemp scratch roots with
 * ssh-keygen-generated keys; the operator's real `~/.ssh` and real credential
 * files are never read or written (discipline of ssh-key-fs-modes.test.ts).
 * Sentinel strings are random per run and asserted ABSENT from every output.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import type { EgressFenceSpec } from "../../../src/harness/sandbox/egress/session.js";
import {
  createBwrapFence,
  type ProtectedTargetSkippedWarning,
} from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createProtectedTargetInventory } from "../../../src/harness/sandbox/protected-targets.js";

function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

const SKIP = !hasBwrap();

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

// ── argv-surface fixtures (paths need not exist unless existence is the point;
// the subtree/exact covers skip absent sources, so presence IS the point here) ──
const ARGV_HOME = scratchDir("iknow-t8-argv-home-");
const ARGV_TASK = scratchDir("iknow-t8-argv-task-");
const ARGV_TMP = scratchDir("iknow-t8-argv-tmp-");

beforeAll(() => {
  for (const rel of [".ssh", ".aws", ".gnupg", join(".config", "gh")]) {
    mkdirSync(join(ARGV_HOME, rel), { recursive: true });
    // One regular file per credential subtree: the coordinated plan masks
    // files, not subtrees, so the argv pins observe the per-file tokens.
    writeFileSync(join(ARGV_HOME, rel, "config"), "k\n");
  }
  writeFileSync(join(ARGV_HOME, ".netrc"), "machine x login y password z\n");
});

function argvAssemble(opts: {
  readonly home?: string;
  readonly protectCredentialReads?: boolean;
  readonly withInventory?: boolean;
  readonly yolo?: boolean;
  readonly egress?: EgressFenceSpec;
  readonly tmpRoot?: string;
}): {
  readonly argv: readonly string[];
  readonly warnings: ProtectedTargetSkippedWarning[];
} {
  const warnings: ProtectedTargetSkippedWarning[] = [];
  const argv = createBwrapFence({
    command: "bash",
    args: ["-c", "true"],
    fsPolicy: createFsPolicy({
      tmpDir: opts.tmpRoot ?? ARGV_TMP,
      mode: "global",
    }),
    env: { PATH: "/bin" },
    cwd: ARGV_TASK,
    ...(opts.withInventory === false
      ? {}
      : {
          protectedTargets: createProtectedTargetInventory({
            home: opts.home ?? ARGV_HOME,
            scanRoot: opts.home ?? ARGV_HOME,
          }),
        }),
    ...(opts.protectCredentialReads === undefined
      ? {}
      : { protectCredentialReads: opts.protectCredentialReads }),
    ...(opts.egress === undefined ? {} : { egress: opts.egress }),
    ...(opts.yolo === undefined ? {} : { yolo: opts.yolo }),
    onProtectedTargetSkipped: (w) => warnings.push(w),
  }).argv;
  return { argv, warnings };
}

function tripleIdx(argv: readonly string[], src: string, dest: string): number {
  return argv.findIndex(
    (arg, i) =>
      arg === "--ro-bind" && argv[i + 1] === src && argv[i + 2] === dest
  );
}

/** Index of the cover triple for a protected dest path (src is the cover dir). */
function coverIdx(argv: readonly string[], dest: string): number {
  return argv.findIndex(
    (arg, i) =>
      arg === "--ro-bind" && argv[i + 2] === dest && argv[i + 1] !== dest
  );
}

describe("T8 credential read mask — argv pins", () => {
  it("flag absent: argv byte-identical to the T7-only shape (c5ef36ba contract)", () => {
    const baseline = argvAssemble({ protectCredentialReads: false });
    const omitted = argvAssemble({});
    assert.deepEqual([...omitted.argv], [...baseline.argv]);
    // No cover token: nothing --ro-bind'd onto a home path from a foreign src.
    for (let i = 0; i < baseline.argv.length - 2; i += 1) {
      if (baseline.argv[i] !== "--ro-bind") continue;
      const src = baseline.argv[i + 1]!;
      const dest = baseline.argv[i + 2]!;
      assert.equal(
        src === dest || !dest.startsWith(ARGV_HOME),
        true,
        `unexpected cover-shaped token pair ${src} -> ${dest}`
      );
    }
  });

  it("flag with no inventory is inert", () => {
    const withFlag = argvAssemble({
      withInventory: false,
      protectCredentialReads: true,
    });
    const bare = argvAssemble({ withInventory: false });
    assert.deepEqual([...withFlag.argv], [...bare.argv]);
  });

  it("subtree credential sources stay real ro-binds carrying per-file /dev/null masks after the T7 block", () => {
    const { argv } = argvAssemble({ protectCredentialReads: true });
    const procIdx = argv.indexOf("--proc");
    assert.ok(procIdx > 0);
    for (const rel of [".ssh", ".aws", ".gnupg", join(".config", "gh")]) {
      const dest = join(ARGV_HOME, rel);
      const t7 = tripleIdx(argv, dest, dest);
      assert.ok(
        t7 >= 0,
        `T7 ro-bind for ${rel} still present (the real subtree stays mounted read-only)`
      );
      assert.equal(
        coverIdx(argv, dest),
        -1,
        `no whole-subtree cover on ${rel} — an empty-dir cover would let rm -f on a hidden name exit 0 (vacuous success)`
      );
      const mask = tripleIdx(argv, "/dev/null", join(dest, "config"));
      assert.ok(
        mask > t7 && mask < procIdx,
        `per-file mask for ${rel}/config lands after its T7 ro-bind, before --proc`
      );
    }
  });

  it("exact-file credential sources are /dev/null-covered", () => {
    const { argv } = argvAssemble({ protectCredentialReads: true });
    const dest = join(ARGV_HOME, ".netrc");
    const idx = tripleIdx(argv, "/dev/null", dest);
    assert.ok(idx > 0, "the exact-file source gets a /dev/null cover");
    assert.ok(idx < argv.indexOf("--proc"));
  });

  it("absent credential sources contribute no cover tokens (ENOENT branch, no mount break)", () => {
    const kube = join(ARGV_HOME, ".kube");
    assert.ok(!existsSync(kube));
    const { argv } = argvAssemble({ protectCredentialReads: true });
    assert.equal(coverIdx(argv, kube), -1);
    assert.ok(!argv.includes(kube));
  });

  it("no /proc cover tokens (guest environ is the clearenv'd one)", () => {
    const { argv } = argvAssemble({ protectCredentialReads: true });
    assert.ok(
      !argv.some((a) => typeof a === "string" && a === "/proc/self/environ")
    );
  });

  it("cover source is deterministic across assemblies (fg/bg parity stable)", () => {
    const a = argvAssemble({ protectCredentialReads: true });
    const b = argvAssemble({ protectCredentialReads: true });
    assert.deepEqual([...a.argv], [...b.argv]);
  });

  it("egress masked bind under a covered subtree is re-emitted after the cover", () => {
    const maskedSrc = join(ARGV_TMP, "masked-hosts.yml");
    writeFileSync(maskedSrc, "github.com:\n  oauth_token: fake\n");
    const dest = join(ARGV_HOME, ".config", "gh", "hosts.yml");
    const egress: EgressFenceSpec = {
      unixSocketPath: "",
      sandboxLocalPort: 3128,
      env: {},
      innerBridgeScript: "",
      relayAssetsDir: "",
      binds: [{ src: maskedSrc, dest, readonly: true }],
    };
    const { argv } = argvAssemble({ protectCredentialReads: true, egress });
    const cover = coverIdx(argv, join(ARGV_HOME, ".config", "gh"));
    // The masked pair appears twice: the early egress segment and the
    // coordination re-emission above the cover. Last-mount-wins is the
    // re-emission, so assert on the LAST occurrence.
    let rebind = -1;
    argv.forEach((arg, i) => {
      if (
        arg === "--ro-bind" &&
        argv[i + 1] === maskedSrc &&
        argv[i + 2] === dest
      ) {
        rebind = i;
      }
    });
    assert.ok(cover > 0, "the ~/.config/gh subtree is covered");
    assert.ok(rebind > cover, "the masked bind is re-emitted above the cover");
    assert.ok(rebind < argv.indexOf("--proc"));
  });

  it("yolo retires the mask with the fence (bare argv)", () => {
    const { argv } = argvAssemble({ protectCredentialReads: true, yolo: true });
    assert.deepEqual([...argv], ["bash", "-c", "true"]);
  });
});

// ── real-bwrap effect matrix ────────────────────────────────────────────────

const HOME = scratchDir("iknow-t8-fence-home-");
const TASK = scratchDir("iknow-t8-fence-task-");
const TMP = scratchDir("iknow-t8-fence-tmp-");

const KEY = join(HOME, ".ssh", "id_ed25519");
const AWS = join(HOME, ".aws", "credentials");
const NETRC = join(HOME, ".netrc");
const GH = join(HOME, ".config", "gh", "hosts.yml");
const ABSENT_FILE = join(HOME, ".kube", "config"); // .kube is never created

const sentinel = (tag: string): string =>
  `${tag}-SECRET-${Math.random().toString(36).slice(2, 10)}`;
const AWS_SENTINEL = sentinel("AWS");
const NETRC_SENTINEL = sentinel("NETRC");
const GH_SENTINEL = sentinel("GH");
let KEY_SENTINEL = "";

function runMaskedFence(
  script: string,
  extra: {
    readonly egressBinds?: readonly { src: string; dest: string }[];
  } = {}
): { status: number; stdout: string; stderr: string } {
  const maskedSrc = join(TMP, "masked-hosts.yml");
  const binds =
    extra.egressBinds ??
    (existsSync(maskedSrc) ? [{ src: maskedSrc, dest: GH }] : undefined);
  const argv = createBwrapFence({
    command: "bash",
    args: ["-c", script],
    fsPolicy: createFsPolicy({ tmpDir: TMP, mode: "global" }),
    env: { HOME, PATH: "/usr/bin:/bin" },
    cwd: TASK,
    protectedTargets: createProtectedTargetInventory({
      home: HOME,
      scanRoot: HOME,
    }),
    protectCredentialReads: true,
    ...(binds === undefined
      ? {}
      : {
          egress: {
            unixSocketPath: "",
            sandboxLocalPort: 3128,
            env: {},
            innerBridgeScript: "",
            relayAssetsDir: "",
            binds: binds.map((b) => ({ ...b, readonly: true as const })),
          } satisfies EgressFenceSpec,
        }),
  }).argv;
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

const outputs: string[] = [];
function observe(r: {
  status: number;
  stdout: string;
  stderr: string;
}): typeof r {
  outputs.push(r.stdout, r.stderr);
  return r;
}

beforeAll(() => {
  if (SKIP) return;
  mkdirSync(join(HOME, ".ssh"), { recursive: true, mode: 0o700 });
  mkdirSync(join(HOME, ".aws"), { recursive: true, mode: 0o700 });
  mkdirSync(join(HOME, ".gnupg"), { recursive: true, mode: 0o700 });
  mkdirSync(join(HOME, ".config", "gh"), { recursive: true, mode: 0o700 });
  const gen = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-C", "iknow-t8-fixture", "-f", KEY, "-q"],
    { stdio: "ignore" }
  );
  assert.equal(gen.status, 0, "ssh-keygen fixture key generation must succeed");
  chmodSync(KEY, 0o600);
  const keyBody = readFileSync(KEY, "utf8");
  KEY_SENTINEL = keyBody.slice(11, 43);
  writeFileSync(AWS, `[default]\naws_access_key_id = ${AWS_SENTINEL}\n`, {
    mode: 0o600,
  });
  writeFileSync(NETRC, `machine gh login tok password ${NETRC_SENTINEL}\n`, {
    mode: 0o600,
  });
  writeFileSync(GH, `github.com:\n  oauth_token: ${GH_SENTINEL}\n`, {
    mode: 0o600,
  });
});

afterAll(() => {
  for (const p of scratch.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

describe("T8 real-bwrap: credential reads are masked-value-or-nothing (SC4 matrix)", () => {
  it.skipIf(SKIP)(
    "direct shell read of the fixture key is denied (cat refuses; no value)",
    () => {
      // The coordinated plan masks the file itself (`--ro-bind /dev/null` on
      // the read-only subtree), not its mount point: an OPEN of the masked
      // path is refused by the fence's nodev binds (EACCES) and yields no
      // value. `test -r` on a /dev/null cover reports the chardev's mode bits
      // (faccessat succeeds) without making the real value reachable — the
      // guarantee is read-content, not stat metadata.
      const c = observe(runMaskedFence(`cat '${KEY}'`));
      assert.notEqual(c.status, 0, "cat must fail on the masked credential");
      assert.doesNotMatch(c.stdout + c.stderr, /BEGIN OPENSSH PRIVATE KEY/);
      assert.ok(
        !c.stdout.includes(KEY_SENTINEL) && !c.stderr.includes(KEY_SENTINEL)
      );
    }
  );

  it.skipIf(SKIP)(
    "python3 open() of the same source is denied by the same rule",
    () => {
      const r = observe(
        runMaskedFence(`python3 -c "print(open('${KEY}').read())"`)
      );
      assert.notEqual(r.status, 0, "interpreter read must fail too");
      // nodev refusal (PermissionError/EACCES) or, if a device read ever
      // resolves, the empty mask — both pinned; the real value is neither.
      assert.match(r.stderr, /PermissionError|OSError/);
      assert.ok(
        !r.stdout.includes(KEY_SENTINEL) && !r.stderr.includes(KEY_SENTINEL)
      );
    }
  );

  it.skipIf(SKIP)(
    "a second interpreter reads the same source through the same wall",
    () => {
      const probe = observe(
        runMaskedFence("command -v perl || command -v node")
      );
      if (probe.status !== 0) return; // neither available in this fence: vacuous
      const r = probe.stdout.includes("perl")
        ? observe(
            runMaskedFence(
              `perl -e 'open my $f, "<", "${KEY}" or exit 7; print <$f>'`
            )
          )
        : observe(
            runMaskedFence(
              `node -e 'console.log(require("fs").readFileSync("${KEY}","utf8"))'`
            )
          );
      assert.notEqual(r.status, 0, "second-interpreter read must be denied");
    }
  );

  it.skipIf(SKIP)(
    "presence is visible under the read-only subtree; content never leaks",
    () => {
      // Coordinated-plan tradeoff, documented: hiding the subtree behind an
      // empty cover would hide names but make `rm -f <credential>` exit 0 on
      // the hidden name — a vacuous success with no refusal signal, breaking
      // the SC1/SC3 refusal shape (reproduced before the fix, pinned against
      // it in fence-production-combo.test.ts). The mask therefore keeps file
      // names visible and carries the SC4 guarantee on content reachability.
      const ls = observe(runMaskedFence(`ls -A '${HOME}/.ssh'`));
      assert.equal(ls.status, 0, "the directory itself still exists");
      assert.ok(!ls.stdout.includes(KEY_SENTINEL), "no content in the listing");
      const py = observe(
        runMaskedFence(
          `python3 -c "import glob,os; p='${KEY}'; print(os.path.exists(p), glob.glob('${HOME}/.ssh/*'), open(p).read() if os.path.exists(p) else '')"`
        )
      );
      assert.notEqual(
        py.status,
        0,
        "the existence-then-read chain still dies at the read"
      );
      assert.ok(
        !py.stdout.includes(KEY_SENTINEL) && !py.stderr.includes(KEY_SENTINEL)
      );
    }
  );

  it.skipIf(SKIP)("the whole .aws subtree is nothing-at-all as well", () => {
    const r = observe(runMaskedFence(`cat '${AWS}'`));
    assert.notEqual(r.status, 0);
    assert.ok(
      !r.stdout.includes(AWS_SENTINEL) && !r.stderr.includes(AWS_SENTINEL)
    );
  });

  it.skipIf(SKIP)(
    "a single-file source is unreachable — refusal, or empty mask; never the value",
    () => {
      const r = observe(runMaskedFence(`cat '${NETRC}'`));
      // The fence's bind mounts carry nodev, so opening the /dev/null cover
      // meets EACCES (a refusal). If a future mount layer opened device reads,
      // the worst case is the empty mask — either way the real bytes are
      // unreachable. Both acceptable branches are pinned; a value read is not.
      if (r.status === 0)
        assert.equal(r.stdout, "", "masked branch: zero bytes");
      else assert.doesNotMatch(r.stdout, /password/);
      assert.ok(
        !r.stdout.includes(NETRC_SENTINEL) && !r.stderr.includes(NETRC_SENTINEL)
      );
      const py = observe(
        runMaskedFence(`python3 -c "print(open('${NETRC}').read())"`)
      );
      if (py.status === 0) assert.equal(py.stdout.trim(), "");
      else assert.match(py.stderr, /PermissionError|OSError/);
    }
  );

  it.skipIf(SKIP)(
    "an absent credential source reads as ordinary ENOENT, never a fabricated success",
    () => {
      assert.ok(!existsSync(ABSENT_FILE));
      const c = observe(runMaskedFence(`cat '${ABSENT_FILE}'`));
      assert.notEqual(c.status, 0, "cat on the absent source must fail");
      assert.match(
        c.stderr,
        /No such file or directory/,
        "the refusal is the ordinary ENOENT shape"
      );
      const py = observe(
        runMaskedFence(`python3 -c "open('${ABSENT_FILE}').read()"`)
      );
      assert.notEqual(py.status, 0);
      assert.match(py.stderr, /FileNotFoundError/);
    }
  );

  it.skipIf(SKIP)(
    "writes stay boundary-refused inside a covered subtree (EROFS, not silent success)",
    () => {
      const r = observe(runMaskedFence(`touch '${HOME}/.ssh/new-file'`));
      assert.notEqual(
        r.status,
        0,
        "creating inside the covered subtree must fail"
      );
      assert.match(r.stderr.toLowerCase(), /read-only file system/);
      assert.ok(!existsSync(join(HOME, ".ssh", "new-file")));
    }
  );

  it.skipIf(SKIP)("on-disk bytes are unchanged after every attempt", () => {
    assert.equal(readFileSync(KEY, "utf8").includes(KEY_SENTINEL), true);
    assert.equal(
      readFileSync(AWS, "utf8"),
      `[default]\naws_access_key_id = ${AWS_SENTINEL}\n`
    );
    assert.equal(readFileSync(NETRC, "utf8").includes(NETRC_SENTINEL), true);
    assert.equal(readFileSync(GH, "utf8").includes(GH_SENTINEL), true);
  });

  it.skipIf(SKIP)(
    "the real values are absent from every tool output collected so far",
    () => {
      const all = outputs.join("\n");
      for (const s of [
        KEY_SENTINEL,
        AWS_SENTINEL,
        NETRC_SENTINEL,
        GH_SENTINEL,
      ]) {
        assert.ok(s.length > 0);
        assert.ok(!all.includes(s), `sentinel leaked into fence output`);
      }
    }
  );

  it.skipIf(SKIP)(
    "egress coordination: a masked bind under a covered subtree stays reachable as the masked value",
    () => {
      const maskedSrc = join(TMP, "masked-hosts.yml");
      writeFileSync(
        maskedSrc,
        "github.com:\n  oauth_token: FAKE-MASKED-VALUE\n"
      );
      try {
        const r = observe(runMaskedFence(`cat '${GH}'`));
        assert.equal(r.status, 0, `masked read must succeed: ${r.stderr}`);
        assert.match(r.stdout, /FAKE-MASKED-VALUE/);
        assert.ok(
          !r.stdout.includes(GH_SENTINEL),
          "the real token stays unreachable"
        );
      } finally {
        rmSync(maskedSrc, { force: true });
      }
    }
  );

  it.skipIf(SKIP)(
    "ordinary non-protected reads and workspace writes are unchanged",
    () => {
      const readable = join(TASK, "readable.txt");
      writeFileSync(readable, "ordinary bytes");
      const r = observe(runMaskedFence(`cat '${readable}'`));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "ordinary bytes");
      const probe = join(TASK, "workspace-write-probe");
      const w = observe(runMaskedFence(`echo ok > '${probe}'`));
      assert.equal(w.status, 0, `workspace write failed: ${w.stderr}`);
      assert.equal(readFileSync(probe, "utf8").trim(), "ok");
    }
  );

  it.skipIf(
    SKIP || spawnSync("gh", ["--version"], { stdio: "ignore" }).status !== 0
  )(
    "GitHub CLI starts with safe defaults without exposing the host configuration",
    () => {
      const config = join(HOME, ".config", "gh", "config.yml");
      const maskedHosts = join(TMP, "gh-cli-masked-hosts.yml");
      const privateConfig =
        "git_protocol: ssh\neditor: PRIVATE-CONFIG-FIXTURE\n";
      writeFileSync(config, privateConfig);
      writeFileSync(
        maskedHosts,
        "github.com:\n  oauth_token: fake_fixture_token\n"
      );
      try {
        const cli = observe(
          runMaskedFence("gh config get git_protocol", {
            egressBinds: [{ src: maskedHosts, dest: GH }],
          })
        );
        assert.equal(cli.status, 0, `GitHub CLI must start: ${cli.stderr}`);
        assert.equal(
          cli.stdout.trim(),
          "https",
          "the fence uses safe defaults"
        );

        const read = observe(runMaskedFence(`cat '${config}'`));
        assert.equal(read.status, 0, read.stderr);
        assert.ok(!read.stdout.includes("PRIVATE-CONFIG-FIXTURE"));
        assert.ok(!read.stdout.includes("git_protocol: ssh"));

        const write = observe(runMaskedFence(`echo changed > '${config}'`));
        assert.notEqual(
          write.status,
          0,
          "host configuration remains read-only"
        );
        assert.equal(readFileSync(config, "utf8"), privateConfig);

        const sourceWrite = observe(
          runMaskedFence(
            `for p in '${TMP}'/protected-credential-cover/gh-default-config-*/config.yml; do echo changed > "$p" || exit $?; done`
          )
        );
        assert.notEqual(
          sourceWrite.status,
          0,
          "generated sources remain read-only"
        );
        const coverRoot = join(TMP, "protected-credential-cover");
        for (const dir of readdirSync(coverRoot).filter((name) =>
          name.startsWith("gh-default-config-")
        )) {
          assert.equal(
            readFileSync(join(coverRoot, dir, "config.yml"), "utf8"),
            "{}\n"
          );
        }
      } finally {
        rmSync(config, { force: true });
        rmSync(maskedHosts, { force: true });
      }
    }
  );

  it.skipIf(
    SKIP || spawnSync("gh", ["--version"], { stdio: "ignore" }).status !== 0
  )(
    "GitHub CLI defaults and masked credentials survive the oversized-subtree cover",
    () => {
      const ghDir = join(HOME, ".config", "gh");
      const config = join(ghDir, "config.yml");
      const maskedHosts = join(TMP, "gh-fallback-masked-hosts.yml");
      const files = Array.from({ length: 513 }, (_, i) =>
        join(ghDir, `extra-${i}`)
      );
      writeFileSync(config, "git_protocol: ssh\n");
      writeFileSync(
        maskedHosts,
        "github.com:\n  oauth_token: fake_fallback_token\n"
      );
      for (const file of files)
        writeFileSync(file, "PRIVATE-SIBLING-FIXTURE\n");
      try {
        const cli = observe(
          runMaskedFence("gh config get git_protocol", {
            egressBinds: [{ src: maskedHosts, dest: GH }],
          })
        );
        assert.equal(cli.status, 0, cli.stderr);
        assert.equal(cli.stdout.trim(), "https");
        const sibling = observe(runMaskedFence(`cat '${files[0]}'`));
        assert.notEqual(sibling.status, 0);
        assert.ok(!sibling.stdout.includes("PRIVATE-SIBLING-FIXTURE"));
      } finally {
        for (const file of [...files, config, maskedHosts])
          rmSync(file, { force: true });
      }
    }
  );

  it.skipIf(SKIP)(
    "a symlinked GitHub configuration does not expose a protected target",
    () => {
      const config = join(HOME, ".config", "gh", "config.yml");
      symlinkSync(AWS, config);
      try {
        const read = observe(runMaskedFence(`cat '${config}'`));
        assert.notEqual(read.status, 0);
        assert.ok(!read.stdout.includes(AWS_SENTINEL));
        assert.equal(
          readFileSync(AWS, "utf8"),
          `[default]\naws_access_key_id = ${AWS_SENTINEL}\n`
        );
      } finally {
        rmSync(config, { force: true });
      }
    }
  );

  it.skipIf(
    SKIP || spawnSync("gh", ["--version"], { stdio: "ignore" }).status !== 0
  )(
    "a tampered generated config is preserved but never used by GitHub CLI",
    () => {
      const config = join(HOME, ".config", "gh", "config.yml");
      const maskedHosts = join(TMP, "gh-tamper-masked-hosts.yml");
      writeFileSync(config, "git_protocol: ssh\n");
      writeFileSync(
        maskedHosts,
        "github.com:\n  oauth_token: fake_tamper_token\n"
      );
      const extra = { egressBinds: [{ src: maskedHosts, dest: GH }] };
      let source: string | undefined;
      try {
        assert.equal(
          runMaskedFence("gh config get git_protocol", extra).status,
          0
        );
        const coverRoot = join(TMP, "protected-credential-cover");
        const directory = readdirSync(coverRoot).find((name) =>
          name.startsWith("gh-default-config-")
        );
        assert.ok(directory);
        source = join(coverRoot, directory, "config.yml");
        writeFileSync(source, "git_protocol: ssh\n");
        const cli = observe(
          runMaskedFence("gh config get git_protocol", extra)
        );
        assert.equal(cli.status, 0, cli.stderr);
        assert.equal(cli.stdout.trim(), "https");
        assert.equal(readFileSync(source, "utf8"), "git_protocol: ssh\n");
      } finally {
        if (source !== undefined) writeFileSync(source, "{}\n");
        for (const file of [config, maskedHosts]) rmSync(file, { force: true });
      }
    }
  );
});
