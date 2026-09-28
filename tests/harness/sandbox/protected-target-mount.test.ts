/**
 * T7 mount layer — real-bwrap effect-equivalence for protected targets
 * (specs/effect-boundary-protection.md SC1/SC10).
 *
 * For ≥3 protected targets, the shell deletion spelling `rm -f <target>` and
 * the interpreter spelling `python3 -c 'import os; os.remove("<target>")'`
 * are BOTH refused at the kernel layer (EROFS), and the target's bytes on the
 * host are unchanged after each attempt — the mount layer is
 * interpreter-independent; no command-text scanning is involved. An ordinary
 * workspace write still succeeds (the protected layer is the only tightening
 * this tier gains). One absent fixture target degrades exactly one entry:
 * the fence starts, the present targets stay refused, the workspace stays
 * writable, and the typed skip warning carries a non-zero surviving count.
 *
 * Discipline (mirrors ssh-key-fs-modes.test.ts):
 *   - fixture HOME lives in a per-run mkdtemp scratch root; HOME is
 *     redirected through the fence env; the operator's real `~/.ssh` and
 *     real credential files are NEVER read, written, or copied — the fixture
 *     key is generated in the scratch root via ssh-keygen;
 *   - this file asserts status codes, EROFS-class stderr, and byte equality
 *     only; it never prints credential bytes into assertion messages.
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import {
  createBwrapFence,
  type ProtectedTargetSkippedWarning,
} from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createProtectedTargetInventory } from "../../../src/harness/sandbox/protected-targets.js";

function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

function hasPython3(): boolean {
  return spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
}

const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

const SKIP = !hasBwrap();

const FAKE_HOME = scratchDir("iknow-t7-fence-home-");
const TASK = scratchDir("iknow-t7-fence-task-");
const TMP = scratchDir("iknow-t7-fence-tmp-");
const ABSENT_TARGET = join(FAKE_HOME, ".kube");

// Three protected targets from three inventory classes; every path sits under
// the fixture home, never under the operator's real one.
const PROTECTED_TARGETS = [
  { label: "ssh key", path: join(FAKE_HOME, ".ssh", "id_ed25519") },
  { label: "aws credentials", path: join(FAKE_HOME, ".aws", "credentials") },
  { label: "gpg marker", path: join(FAKE_HOME, ".gnupg", "secring-marker") },
] as const;

const contentsBefore = new Map<string, string>();

beforeAll(() => {
  // bwrap absent = whole group skipped (CI shape); fixtures are moot, skip.
  if (SKIP) return;
  mkdirSync(join(FAKE_HOME, ".ssh"), { recursive: true, mode: 0o700 });
  mkdirSync(join(FAKE_HOME, ".aws"), { recursive: true, mode: 0o700 });
  mkdirSync(join(FAKE_HOME, ".gnupg"), { recursive: true, mode: 0o700 });
  // ABSENT_TARGET (.kube) is deliberately never created: the SC10 case.
  const key = join(FAKE_HOME, ".ssh", "id_ed25519");
  const gen = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-C", "iknow-t7-fixture", "-f", key, "-q"],
    { stdio: "ignore" }
  );
  assert.equal(gen.status, 0, "ssh-keygen fixture key generation must succeed");
  chmodSync(key, 0o600);
  writeFileSync(
    join(FAKE_HOME, ".aws", "credentials"),
    "[default]\naws_access_key_id = fixture\n",
    { mode: 0o600 }
  );
  writeFileSync(
    join(FAKE_HOME, ".gnupg", "secring-marker"),
    "gpg fixture marker\n",
    {
      mode: 0o600,
    }
  );
  for (const target of PROTECTED_TARGETS) {
    contentsBefore.set(target.path, readFileSync(target.path, "utf8"));
  }
});

afterAll(() => {
  for (const p of scratch.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

function runFence(
  script: string,
  onSkipped?: (warning: ProtectedTargetSkippedWarning) => void
): { status: number; stderr: string } {
  const argv = createBwrapFence({
    command: "bash",
    args: ["-c", script],
    fsPolicy: createFsPolicy({ tmpDir: TMP, mode: "global" }),
    // HOME redirected explicitly to the fixture home (operator's real home
    // untouched); PATH is the fence-whitelisted env, same shape as the pin.
    env: { HOME: FAKE_HOME, PATH: "/usr/bin:/bin" },
    cwd: TASK,
    protectedTargets: createProtectedTargetInventory({
      home: FAKE_HOME,
      scanRoot: FAKE_HOME,
    }),
    onProtectedTargetSkipped: onSkipped ?? (() => undefined),
  }).argv;
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

describe("T7 real-bwrap: protected targets refused by both spellings (SC1)", () => {
  for (const { label, path } of PROTECTED_TARGETS) {
    it.skipIf(SKIP)(
      `${label}: rm -f refused at the kernel (EROFS), host bytes unchanged`,
      () => {
        const r = runFence(`rm -f '${path}'`);
        assert.notEqual(r.status, 0, "rm -f on a protected target must fail");
        assert.match(
          r.stderr.toLowerCase(),
          /read-only file system|erofs/,
          `expected EROFS-class refusal, got: ${r.stderr}`
        );
        assert.equal(
          readFileSync(path, "utf8"),
          contentsBefore.get(path),
          "target bytes unchanged after the rm attempt"
        );
      }
    );

    it.skipIf(SKIP || !hasPython3())(
      `${label}: python3 os.remove refused at the kernel (EROFS), host bytes unchanged`,
      () => {
        const r = runFence(`python3 -c "import os; os.remove('${path}')"`);
        assert.notEqual(
          r.status,
          0,
          "os.remove on a protected target must fail"
        );
        assert.match(
          r.stderr,
          /Read-only file system|errno 30/i,
          `expected EROFS-class refusal, got: ${r.stderr}`
        );
        assert.equal(
          readFileSync(path, "utf8"),
          contentsBefore.get(path),
          "target bytes unchanged after the os.remove attempt"
        );
      }
    );
  }

  it.skipIf(SKIP)(
    "an ordinary workspace write still succeeds — the protected layer is the only tightening",
    () => {
      const probe = join(TASK, "workspace-write-probe");
      const r = runFence(`echo ok > '${probe}'`);
      assert.equal(r.status, 0, `workspace write failed: ${r.stderr}`);
      assert.equal(readFileSync(probe, "utf8").trim(), "ok");
    }
  );
});

describe("T7 real-bwrap: one absent target degrades exactly one entry (SC10)", () => {
  it.skipIf(SKIP)(
    "absent .kube: fence starts, present targets still refused, workspace writable, warning carries remainingProtected",
    () => {
      assert.ok(
        !existsSync(ABSENT_TARGET),
        "the .kube fixture target stays absent"
      );
      const warnings: ProtectedTargetSkippedWarning[] = [];
      const probe = join(TASK, "absent-case-write");
      const write = runFence(`echo ok > '${probe}'`, (w) => warnings.push(w));
      assert.equal(
        write.status,
        0,
        `fence must start despite the absent target: ${write.stderr}`
      );
      const skipped = warnings.find((w) => w.target === ABSENT_TARGET);
      assert.ok(skipped, "the absent entry is diagnosed with a typed warning");
      assert.equal(skipped.kind, "protected_target_absent_on_host");
      assert.equal(skipped.targetClass, "kube_config");
      assert.ok(
        skipped.remainingProtected > 0,
        "the surviving protection count is observable from the warning"
      );
      const key = PROTECTED_TARGETS[0].path;
      const rm = runFence(`rm -f '${key}'`, (w) => warnings.push(w));
      assert.notEqual(rm.status, 0);
      assert.match(rm.stderr.toLowerCase(), /read-only file system/);
      assert.equal(readFileSync(key, "utf8"), contentsBefore.get(key));
    }
  );
});

/**
 * SC3(a) real-bwrap — the ordinary-backup row. An agent-created backup in a
 * permitted writable location is removed by BOTH spellings and is gone from the
 * host in both cases; the two rows differ by LOCATION, never by spelling.
 *
 * The no-artifact half is asserted as an observable rather than by a directory
 * name: the fence tmp pad is snapshotted before the run, and after both
 * removals the ONLY difference anywhere beneath it is the backup file that was
 * created and then deleted. Nothing else — no receipt, claim, or authorization
 * directory — is created or consulted, because the protected-target layer never
 * opened this location's parent at all.
 *
 * Same fixture discipline as the SC1 block above: mkdtemp roots only, HOME
 * redirected into the fixture, no operator credential read or written.
 */
describe("SC3(a) real-bwrap: an ordinary backup is removable by both spellings", () => {
  const BK_HOME = scratchDir("iknow-t7-bk-home-");
  const BK_TASK = scratchDir("iknow-t7-bk-task-");
  const BK_TMP = scratchDir("iknow-t7-bk-tmp-");
  const BACKUP = join(BK_TASK, "iknow-probe-backup");
  const BACKUP_BYTES = "ordinary-backup-fixture\n";

  function snapshotTree(root: string, prefix = root): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const full = join(root, entry.name);
      out.push(join(prefix.slice(root.length), entry.name) + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory()) out.push(...snapshotTree(full, prefix));
    }
    return out.sort();
  }

  function runBackupFence(script: string): { status: number; stderr: string } {
    const argv = createBwrapFence({
      command: "bash",
      args: ["-c", script],
      fsPolicy: createFsPolicy({ tmpDir: BK_TMP, mode: "global" }),
      env: { HOME: BK_HOME, PATH: "/usr/bin:/bin" },
      cwd: BK_TASK,
      // The scan root is the fixture workspace, so the protected layer is
      // fully wired — this is the row that must stay ordinary regardless.
      protectedTargets: createProtectedTargetInventory({
        home: BK_HOME,
        scanRoot: BK_TASK,
      }),
      onProtectedTargetSkipped: () => undefined,
    }).argv;
    const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
    return { status: r.status ?? -1, stderr: r.stderr ?? "" };
  }

  it.skipIf(SKIP)(
    "rm -f removes it (exit 0, gone from the host); os.remove then removes the re-created file; no fence artifact is created",
    () => {
      const tmpBefore = snapshotTree(BK_TMP);
      const taskBefore = snapshotTree(BK_TASK);

      writeFileSync(BACKUP, BACKUP_BYTES, { mode: 0o600 });
      const viaRm = runBackupFence(`rm -f '${BACKUP}'`);
      assert.equal(viaRm.status, 0, `rm -f on an ordinary backup: ${viaRm.stderr}`);
      assert.equal(
        existsSync(BACKUP),
        false,
        "the backup is really gone from the host, not just reported removed"
      );

      writeFileSync(BACKUP, BACKUP_BYTES, { mode: 0o600 });
      const viaPython = runBackupFence(
        `python3 -c "import os; os.remove('${BACKUP}')"`
      );
      assert.equal(
        viaPython.status,
        0,
        `os.remove on an ordinary backup: ${viaPython.stderr}`
      );
      assert.equal(
        existsSync(BACKUP),
        false,
        "the interpreter spelling is indistinguishable in outcome"
      );

      // The no-artifact half, observable: the fence tmp pad is byte-for-byte
      // as it started, and the task root holds nothing but what this case
      // itself created and then deleted.
      assert.deepEqual(
        snapshotTree(BK_TMP),
        tmpBefore,
        "no receipt / claim / authorization directory was created under the fence tmp pad"
      );
      assert.deepEqual(
        snapshotTree(BK_TASK),
        taskBefore,
        "nothing beyond the backup file itself was created or consulted"
      );
    }
  );

  it.skipIf(SKIP || !hasPython3())(
    "both spellings agree: an ordinary backup is removable and a protected target in the SAME assembly is not",
    () => {
      // The pair SC3 exists to pin, in one assembly, in both spellings: the
      // rows differ by location, never by how removal is spelled.
      const protectedPath = join(BK_HOME, ".ssh", "id_ed25519");
      mkdirSync(join(BK_HOME, ".ssh"), { recursive: true, mode: 0o700 });
      const key = spawnSync(
        "ssh-keygen",
        ["-t", "ed25519", "-N", "", "-C", "iknow-t7-sc3", "-f", protectedPath, "-q"],
        { stdio: "ignore" }
      );
      assert.equal(key.status, 0, "fixture key generation must succeed");
      chmodSync(protectedPath, 0o600);
      const protectedBefore = readFileSync(protectedPath, "utf8");

      const rmBoth = runBackupFence(
        `rm -f '${BACKUP}'; rm -f '${protectedPath}'`
      );
      const pythonBoth = runBackupFence(
        `python3 -c "import os; [os.remove(p) for p in ['${BACKUP}', '${protectedPath}'] if True]"`
      );
      for (const [label, r] of [
        ["rm -f", rmBoth],
        ["os.remove", pythonBoth],
      ] as const) {
        assert.notEqual(
          r.status,
          0,
          `${label} must still fail on the protected half of the pair`
        );
        assert.equal(
          existsSync(BACKUP),
          false,
          `${label} removed the ordinary backup before the protected refusal`
        );
      }
      assert.equal(
        readFileSync(protectedPath, "utf8"),
        protectedBefore,
        "the protected target's bytes are unchanged in both spellings"
      );
    }
  );
});

/**
 * T2 real-bwrap: a workspace-scoped name-pattern match with NO covering ancestor
 * concrete rule gets real kernel-level protection. `server.pem` under the
 * scan scope's `project/` matches the `*.pem` arm; nothing in the inventory
 * binds that path, so only materialization can protect it. Both spellings —
 * `rm -f` and `python3 os.remove` — are refused, the on-host bytes are
 * unchanged, and the non-matching sibling `notes.txt` in the SAME directory
 * stays writable, proving the protection is scoped to the match rather than the
 * directory.
 *
 * Fixture discipline: HOME is an mkdtemp scratch home redirected into the
 * fence env; the operator's real home and credentials are never touched, and
 * the fixture values are not credentials. The scan root is a SEPARATE mkdtemp
 * workspace, never `MAT_HOME` — the name arm's scope is the workspace
 * directory, so a home-rooted fixture would pin the withdrawn scope.
 */
describe("T2 real-bwrap: a workspace-scoped name-pattern match with no ancestor gets real protection", () => {
  const MAT_HOME = scratchDir("iknow-t2-fence-home-");
  const MAT_TASK = scratchDir("iknow-t2-fence-task-");
  const MAT_TMP = scratchDir("iknow-t2-fence-tmp-");
  // The scan root is a fixture WORKSPACE, deliberately a different directory
  // from `home`: the name arm's scope is `resolveWorkspaceRoot`'s directory, so
  // rooting the real-bwrap evidence at a fixture home would test the withdrawn
  // first-revision scope instead of the contract.
  const MAT_WS = scratchDir("iknow-t2-fence-ws-");
  const PROJECT = join(MAT_WS, "project");
  const PEM = join(PROJECT, "server.pem");
  const SIBLING = join(PROJECT, "notes.txt");
  const PEM_BEFORE = "materialized-match-fixture-bytes\n";

  beforeAll(() => {
    if (SKIP) return;
    mkdirSync(PROJECT, { recursive: true, mode: 0o700 });
    writeFileSync(PEM, PEM_BEFORE, { mode: 0o600 });
    writeFileSync(SIBLING, "sibling\n", { mode: 0o600 });
  });

  function runMatFence(script: string): { status: number; stderr: string } {
    const argv = createBwrapFence({
      command: "bash",
      args: ["-c", script],
      fsPolicy: createFsPolicy({ tmpDir: MAT_TMP, mode: "global" }),
      env: { HOME: MAT_HOME, PATH: "/usr/bin:/bin" },
      cwd: MAT_TASK,
      protectedTargets: createProtectedTargetInventory({
        home: MAT_HOME,
        scanRoot: MAT_WS,
      }),
      onProtectedTargetSkipped: () => undefined,
    }).argv;
    const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
    return { status: r.status ?? -1, stderr: r.stderr ?? "" };
  }

  it.skipIf(SKIP)(
    "rm -f on the materialized match is refused and host bytes are unchanged",
    () => {
      const r = runMatFence(`rm -f '${PEM}'`);
      assert.notEqual(r.status, 0, "rm -f on a materialized match must fail");
      // The per-file `/dev/null` cover makes the match a mount point, so the
      // kernel refuses the unlink as EBUSY rather than EROFS — the same
      // truthful-refusal shape an exact-file credential takes (see
      // fence-production-combo). Never a vacuous exit 0.
      assert.match(
        r.stderr,
        /Read-only file system|busy|errno 30|errno 16/i,
        `expected a kernel refusal, got: ${r.stderr}`
      );
      assert.equal(readFileSync(PEM, "utf8"), PEM_BEFORE);
    }
  );

  it.skipIf(SKIP || !hasPython3())(
    "python3 os.remove on the materialized match is refused and host bytes are unchanged",
    () => {
      const r = runMatFence(`python3 -c "import os; os.remove('${PEM}')"`);
      assert.notEqual(r.status, 0, "os.remove on a materialized match must fail");
      assert.match(
        r.stderr,
        /Read-only file system|errno 30|errno 16/i,
        `expected a kernel refusal, got: ${r.stderr}`
      );
      assert.equal(readFileSync(PEM, "utf8"), PEM_BEFORE);
    }
  );

  it.skipIf(SKIP)(
    "the non-matching sibling in the same directory stays writable",
    () => {
      const probe = join(PROJECT, "sibling-write-probe");
      const r = runMatFence(`echo written > '${probe}'`);
      assert.equal(
        r.status,
        0,
        `the sibling directory must stay writable: ${r.stderr}`
      );
      assert.equal(readFileSync(probe, "utf8").trim(), "written");
    }
  );
});

/**
 * The name arm's real-bwrap evidence for the two shapes the spec names BY NAME
 * under the workspace scan scope: `node_modules/server.pem` (proving
 * `node_modules` is not an implied exclusion) and a hidden `.env` (proving
 * hidden files are not either). Both are refused by BOTH spellings, on-host
 * bytes unchanged, while a non-matching sibling in the same `node_modules`
 * package stays writable.
 *
 * These are the same workspace-scoped cases the argv/membership unit pins in
 * `name-pattern-scan-scope.test.ts` cover — that file proves the tokens are
 * emitted, this one proves the kernel actually refuses the effect.
 */
describe("T2 real-bwrap: node_modules and hidden matches inside the workspace scan scope", () => {
  const NM_HOME = scratchDir("iknow-t2-nm-home-");
  const NM_TASK = scratchDir("iknow-t2-nm-task-");
  const NM_TMP = scratchDir("iknow-t2-nm-tmp-");
  const NM_WS = scratchDir("iknow-t2-nm-ws-");
  const PKG = join(NM_WS, "node_modules", "server-pkg");
  const NM_PEM = join(PKG, "server.pem");
  const HIDDEN_ENV = join(NM_WS, ".env");
  const NM_SIBLING = join(PKG, "index.js");
  const MATCH_BYTES = "workspace-match-fixture-bytes\n";

  beforeAll(() => {
    if (SKIP) return;
    mkdirSync(PKG, { recursive: true, mode: 0o700 });
    writeFileSync(NM_PEM, MATCH_BYTES, { mode: 0o600 });
    writeFileSync(HIDDEN_ENV, MATCH_BYTES, { mode: 0o600 });
    writeFileSync(NM_SIBLING, "module.exports = {};\n", { mode: 0o600 });
  });

  function runNmFence(script: string): { status: number; stderr: string } {
    const argv = createBwrapFence({
      command: "bash",
      args: ["-c", script],
      fsPolicy: createFsPolicy({ tmpDir: NM_TMP, mode: "global" }),
      env: { HOME: NM_HOME, PATH: "/usr/bin:/bin" },
      cwd: NM_TASK,
      protectedTargets: createProtectedTargetInventory({
        home: NM_HOME,
        scanRoot: NM_WS,
      }),
      protectCredentialReads: true,
      onProtectedTargetSkipped: () => undefined,
    }).argv;
    const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
    return { status: r.status ?? -1, stderr: r.stderr ?? "" };
  }

  for (const [label, target] of [
    ["node_modules/server-pkg/server.pem", NM_PEM],
    [".env", HIDDEN_ENV],
  ] as const) {
    it.skipIf(SKIP)(
      `${label}: rm -f refused at the kernel, host bytes unchanged`,
      () => {
        const r = runNmFence(`rm -f '${target}'`);
        assert.notEqual(r.status, 0, `rm -f on ${label} must fail`);
        assert.match(
          r.stderr,
          /Read-only file system|busy|errno 30|errno 16/i,
          `expected a kernel refusal, got: ${r.stderr}`
        );
        assert.equal(readFileSync(target, "utf8"), MATCH_BYTES);
      }
    );

    it.skipIf(SKIP || !hasPython3())(
      `${label}: python3 os.remove refused at the kernel, host bytes unchanged`,
      () => {
        const r = runNmFence(`python3 -c "import os; os.remove('${target}')"`);
        assert.notEqual(r.status, 0, `os.remove on ${label} must fail`);
        assert.match(
          r.stderr,
          /Read-only file system|errno 30|errno 16/i,
          `expected a kernel refusal, got: ${r.stderr}`
        );
        assert.equal(readFileSync(target, "utf8"), MATCH_BYTES);
      }
    );
  }

  it.skipIf(SKIP)(
    "the non-matching sibling in the same node_modules package stays writable",
    () => {
      const probe = join(PKG, "write-probe.txt");
      const r = runNmFence(`echo written > '${probe}'`);
      assert.equal(
        r.status,
        0,
        `the package directory must stay writable: ${r.stderr}`
      );
      assert.equal(readFileSync(probe, "utf8").trim(), "written");
    }
  );
});
