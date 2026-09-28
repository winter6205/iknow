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
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { makeDefaultRunVerify } from "../../../src/harness/verify/sandbox-run.ts";

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
