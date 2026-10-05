/**
 * T8 wiring end-to-end (specs/effect-boundary-protection.md SC4): the verify
 * executor (makeDefaultRunVerify — a production fence call site) enforces the
 * credential read mask through the REAL fence, not just createBwrapFence
 * directly. The argv-level proof for the bash tool / background spawn lives
 * in tests/harness/aci/bash-protected-targets-wiring.test.ts; this file runs
 * the wired path end to end under bwrap.
 *
 * Fixture HOME is a mkdtemp scratch root with an ssh-keygen-generated key;
 * the operator's real ~/.ssh and credential files are never touched. The
 * session tmp nests under homeRoot (production shape, as in
 * workspace-mode-fence.test.ts). Sentinels are random per run and asserted
 * ABSENT from every collected output.
 *
 * The fence-visible PATH is pinned to a system-only PATH for this file (see
 * SYSTEM_PATH) so every command below resolves the same binaries regardless of
 * what the host PATH happens to shadow.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { makeDefaultRunVerify } from "../../../src/harness/verify/sandbox-run.ts";

import { canRunBwrapFence } from "../../_helpers/bwrap-capability.js";

/**
 * Binary-resolution pin — a test-environment fix, not a product change.
 *
 * This file drives the production call site, so the fence env is assembled
 * from `process.env` at call time (`envIsolation.filter(process.env)` in
 * src/harness/verify/sandbox-run.ts) and `PATH` is in `BASE_ENV_WHITELIST`
 * (src/harness/sandbox/env-isolation.ts), which makes bwrap emit
 * `--setenv PATH <host PATH>`. On a host whose PATH leads with a runtime shim
 * directory that shadows `rm` with a recoverable-delete wrapper, the sandboxed
 * `rm -f` execs the wrapper and its own failure text replaces the kernel
 * refusal the fence assertion depends on — the fence stays intact, only WHICH
 * `rm` the sandbox resolved changed. Pinning the fence-visible PATH to a
 * system-only PATH for this file makes every case below depend on the fence
 * rather than on the host's binary shadowing. The system-only fence PATH is
 * not new to this repo: tests/harness/sandbox/backup-receipt-fence.test.ts and
 * tests/harness/isolation/protected-target-ebusy-guidance.test.ts pin the same
 * `/usr/bin:/bin` VALUE, though they hand it to createBwrapFence's `env` option
 * and never touch `process.env` — this file pins the process env instead
 * because the production call site above reads `process.env` and offers no env
 * option.
 *
 * The command text stays exactly what a user would type (`rm -f '<key>'`, never
 * an absolute `/bin/rm`): the ENVIRONMENT is pinned, not the assertion
 * special-cased. The unlink case also carries a writable-path control proving
 * `rm -f` in the pinned PATH really works, so the credential refusal can only
 * be the fence's read-only mount.
 */
const SYSTEM_PATH = "/usr/bin:/bin";

/**
 * Skip decision taken under the SAME PATH the run uses: the probe runs with
 * `PATH: SYSTEM_PATH` in an explicit env instead of the inherited one, because
 * everything this file executes after the beforeAll pin resolves under that
 * PATH — the production probe (requireBwrap, src/harness/sandbox/runner.ts)
 * and the `ssh-keygen` fixture alike. Deciding on the host PATH at module load
 * would skip a host whose `bwrap` sits outside SYSTEM_PATH, then fail the
 * fixture setup anyway.
 *
 * It is a physical capability probe, not a `bwrap --version` existence check:
 * every case below really spawns the wired fence (constant `--unshare-net`),
 * so the gate must answer "can a fence start here", not "is the binary
 * present". The existence check admits a GHA runner (bwrap installed, no
 * user-namespace) and turns the skip into a red.
 */
const SKIP = !canRunBwrapFence({ path: SYSTEM_PATH });
/** Host PATH as of this module's load — the value to put back on teardown. */
const SAVED_PATH = process.env.PATH;

const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

const HOME = scratchDir("verify-t8-home-");
const TASK = scratchDir("verify-t8-task-");
const SESSION_TMP = join(
  HOME,
  ".iknow",
  "projects",
  "slug",
  "conv1",
  "fence-tmp"
);

const KEY = join(HOME, ".ssh", "id_ed25519");
const ABSENT_FILE = join(HOME, ".kube", "config"); // .kube is never created

let KEY_SENTINEL = "";

function makeRunVerify() {
  return makeDefaultRunVerify({
    cwd: TASK,
    tmpDir: SESSION_TMP,
    fsMode: "workspace",
    homeRoot: HOME,
  });
}

interface RunOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const outputs: string[] = [];
async function run(command: string): Promise<RunOutput> {
  const result = await makeRunVerify()(command, {});
  outputs.push(result.stdout, result.stderr);
  return result;
}

beforeAll(() => {
  // Hermetic binary resolution for every case below, fixture setup included —
  // restored verbatim in afterAll, so nothing leaks into a sibling suite.
  process.env.PATH = SYSTEM_PATH;
  if (SKIP) return;
  mkdirSync(join(HOME, ".ssh"), { recursive: true, mode: 0o700 });
  mkdirSync(SESSION_TMP, { recursive: true });
  const gen = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-C", "verify-t8-fixture", "-f", KEY, "-q"],
    { stdio: "ignore" }
  );
  assert.equal(gen.status, 0, "ssh-keygen fixture key generation must succeed");
  chmodSync(KEY, 0o600);
  KEY_SENTINEL = readFileSync(KEY, "utf8").slice(11, 43);
});

afterAll(() => {
  if (SAVED_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = SAVED_PATH;
  for (const p of scratch.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

describe("wired verify fence: protected credential reads are masked-value-or-nothing (T8 e2e)", () => {
  it.skipIf(SKIP)(
    "direct read of the fixture key through the wired call path is denied",
    async () => {
      // Coordinated plan (HIGH-1 fix): the file stays present on the
      // read-only subtree, masked by /dev/null — the open is refused by the
      // fence's nodev binds and yields no value. (`test -r` reports the
      // chardev's mode bits; the guarantee is content reachability, and the
      // deletion truthfulness lives in the rm pin below.)
      const c = await run(`cat '${KEY}'`);
      assert.notEqual(c.exitCode, 0, "cat must fail on the masked credential");
      assert.ok(!c.stdout.includes(KEY_SENTINEL));
      assert.doesNotMatch(c.stdout + c.stderr, /BEGIN OPENSSH PRIVATE KEY/);
    }
  );

  it.skipIf(SKIP)(
    "interpreter-mediated read of the same source is denied by the same rule",
    async () => {
      const r = await run(`python3 -c "print(open('${KEY}').read())"`);
      assert.notEqual(r.exitCode, 0, "interpreter read must fail too");
      assert.match(r.stderr, /PermissionError|OSError/);
      assert.ok(
        !r.stdout.includes(KEY_SENTINEL) && !r.stderr.includes(KEY_SENTINEL)
      );
    }
  );

  it.skipIf(SKIP)(
    "unlink attempts meet a truthful kernel refusal through the wired path (HIGH-1 shape)",
    async () => {
      const before = readFileSync(KEY, "utf8");
      const r = await run(`rm -f '${KEY}'`);
      assert.notEqual(
        r.exitCode,
        0,
        "rm -f must NOT exit 0 on the protected credential"
      );
      assert.match(r.stderr, /Read-only file system|Device or resource busy/);
      assert.equal(readFileSync(KEY, "utf8"), before, "bytes unchanged");
    }
  );

  it.skipIf(SKIP)(
    "anti-vacuity control: the same `rm -f` really deletes under this fence, so the refusal above is the read-only mount",
    async () => {
      // If `rm` were absent or broken in the pinned PATH, the credential case
      // would still fail — proving nothing about the fence. Under the SAME
      // fence, `rm -f` on a WRITABLE path inside the task root must exit 0 and
      // really remove the file, so the HIGH-1 refusal can only come from the
      // fence's read-only mount over the credential subtree. The control file
      // is a synthetic scratch fixture inside TASK — swept by the afterAll
      // scratch loop whether or not the command removed it.
      const control = join(TASK, "rm-writable-control.txt");
      writeFileSync(control, "deletable-by-design\n");
      const r = await run(`rm -f '${control}'`);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(
        existsSync(control),
        false,
        "the writable-path file must actually be gone"
      );
    }
  );

  it.skipIf(SKIP)(
    "presence is visible under the read-only subtree; content never leaks",
    async () => {
      // Documented coordinated-plan tradeoff (credential-read-mask.test.ts
      // header): hiding names behind an empty cover made rm -f exit 0 — the
      // vacuous success the plan removes. Names may be listed; bytes may not
      // be read.
      const ls = await run(`ls -A '${HOME}/.ssh'`);
      assert.equal(ls.exitCode, 0, "the directory itself still exists");
      assert.ok(!ls.stdout.includes(KEY_SENTINEL), "no content in the listing");
      const py = await run(
        `python3 -c "import os; print(os.path.exists('${KEY}'), len(open('${KEY}').read()))"`
      );
      assert.notEqual(
        py.exitCode,
        0,
        "the existence-then-read chain dies at the read"
      );
      assert.ok(
        !py.stdout.includes(KEY_SENTINEL) && !py.stderr.includes(KEY_SENTINEL)
      );
    }
  );

  it.skipIf(SKIP)(
    "an absent credential source reads as ordinary ENOENT — no fabricated success, no mount-assembly break",
    async () => {
      assert.ok(!existsSync(ABSENT_FILE));
      const c = await run(`cat '${ABSENT_FILE}'`);
      assert.notEqual(c.exitCode, 0);
      assert.match(c.stderr, /No such file or directory/);
      // The fence still assembles and works after the absent-source request:
      // subsequent commands on this same call site run normally.
      const after = await run(`echo still-standing`);
      assert.equal(after.exitCode, 0, after.stderr);
      assert.equal(after.stdout.trim(), "still-standing");
    }
  );

  it.skipIf(SKIP)(
    "ordinary workspace reads and writes through the wired fence are unchanged",
    async () => {
      const file = join(TASK, "ordinary.txt");
      const w = await run(`printf workspace > '${file}'`);
      assert.equal(w.exitCode, 0, w.stderr);
      assert.equal(readFileSync(file, "utf8"), "workspace");
      const r = await run(`cat '${file}'`);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(r.stdout, "workspace");
    }
  );

  it.skipIf(SKIP)(
    "on-disk bytes are unchanged after every attempt",
    async () => {
      assert.equal(readFileSync(KEY, "utf8").includes(KEY_SENTINEL), true);
    }
  );

  it.skipIf(SKIP)(
    "the real value is absent from every output collected through the wired path",
    async () => {
      assert.ok(KEY_SENTINEL.length > 0);
      const all = outputs.join("\n");
      assert.ok(
        !all.includes(KEY_SENTINEL),
        "key material leaked into tool output"
      );
    }
  );
});
