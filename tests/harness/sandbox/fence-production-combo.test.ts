/**
 * HIGH-1 regression — the EXACT production flag combination in one fence.
 * (specs/effect-boundary-protection.md SC1/SC4/SC7(b); review finding:
 * T8 empty-subtree covers stacked AFTER T7 ro-binds made
 * `rm -f ~/.ssh/id_ed25519` exit 0 with empty stderr — a fake success with
 * no [fs_denied] signal. The fix is one coordinated mount plan; this file
 * pins it with real bwrap and the flags the production wiring passes
 * together: `protectedTargets` + `protectCredentialReads`.)
 *
 * Pinned simultaneously:
 *   - unlink refusals are truthful for every spelling: `rm -f` and
 *     `python3 os.remove` on a masked credential exit NON-ZERO, bytes are
 *     unchanged, and the stderr carries the EROFS line the [fs_denied]
 *     guidance matches (subtree case) or a kernel busy refusal (exact-file
 *     /dev/null mask under a writable parent) — never a silent 0;
 *   - reads stay masked-value-or-nothing (cat refuses, sentinel unreachable);
 *   - no argv in the block ever re-binds a protected target writable: a
 *     credential subtree carries exactly one `--ro-bind` and its masks, and
 *     the mask lands above the subtree bind;
 *   - the boundary stays a boundary: ordinary workspace writes through the
 *     same combo succeed unchanged (the coordinated plan must not narrow the
 *     writable tier beyond the protected targets).
 *
 * Fixtures live in mkdtemp scratch roots (ssh-keygen-generated keys,
 * sentinel strings random per run and asserted absent from every output);
 * the operator's real home and credentials are never read or written.
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

import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createProtectedTargetInventory } from "../../../src/harness/sandbox/protected-targets.js";
import { protectedTargetFenceGuidance } from "../../../src/harness/sandbox/protected-target-feedback.js";
import { VIOLATION_PREFIXES } from "../../../src/harness/permission/prefixes.js";

import { canRunBwrapFence } from "../../_helpers/bwrap-capability.js";

/**
 * Capability gate, not a `bwrap --version` existence check: every gated case
 * really spawns the assembled combo fence (constant `--unshare-net`), so the
 * question is whether a fence can start HERE. The existence check passes on a
 * GHA runner that installed bwrap but has no user-namespace, and the refusal
 * (RTM_NEWADDR) then surfaces as a red instead of a skip.
 */
const SKIP = !canRunBwrapFence();

const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

const HOME = scratchDir("iknow-combo-home-");
const TASK = scratchDir("iknow-combo-task-");
const TMP = scratchDir("iknow-combo-tmp-");

const SSH_DIR = join(HOME, ".ssh");
const KEY = join(SSH_DIR, "id_ed25519");
const AWS_DIR = join(HOME, ".aws");
const AWS = join(AWS_DIR, "credentials");
const NETRC = join(HOME, ".netrc"); // exact-file credential arm

const sentinel = (tag: string): string =>
  `${tag}-SECRET-${Math.random().toString(36).slice(2, 10)}`;
const AWS_SENTINEL = sentinel("AWS");
const NETRC_SENTINEL = sentinel("NETRC");
let KEY_SENTINEL = "";

function comboOptions(): Parameters<typeof createBwrapFence>[0] {
  return {
    command: "bash",
    args: ["-c", "true"],
    fsPolicy: createFsPolicy({ tmpDir: TMP, mode: "global" }),
    env: { HOME, PATH: "/usr/bin:/bin" },
    cwd: TASK,
    protectedTargets: createProtectedTargetInventory({
      home: HOME,
      scanRoot: HOME,
    }),
    protectCredentialReads: true,
  };
}

function runCombo(script: string): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const opts = comboOptions();
  const argv = createBwrapFence({
    ...opts,
    args: ["-c", script],
    onProtectedTargetSkipped: () => {},
  }).argv;
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

const outputs: string[] = [];
function observe(r: { status: number; stdout: string; stderr: string }) {
  outputs.push(r.stdout, r.stderr);
  return r;
}

function tripleIdx(
  argv: readonly string[],
  verb: string,
  src: string,
  dest: string
): number {
  return argv.findIndex(
    (arg, i) => arg === verb && argv[i + 1] === src && argv[i + 2] === dest
  );
}

beforeAll(() => {
  mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(AWS_DIR, { recursive: true, mode: 0o700 });
  const gen = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-C", "iknow-combo-fixture", "-f", KEY, "-q"],
    { stdio: "ignore" }
  );
  assert.equal(gen.status, 0, "ssh-keygen fixture key generation must succeed");
  chmodSync(KEY, 0o600);
  KEY_SENTINEL = readFileSync(KEY, "utf8").slice(11, 43);
  writeFileSync(AWS, `[default]\naws_access_key_id = ${AWS_SENTINEL}\n`, {
    mode: 0o600,
  });
  writeFileSync(NETRC, `machine gh login tok password ${NETRC_SENTINEL}\n`, {
    mode: 0o600,
  });
});

afterAll(() => {
  for (const p of scratch.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

describe("HIGH-1 production combo — one coordinated mount plan (real bwrap)", () => {
  it.skipIf(SKIP)(
    "rm -f on a masked subtree credential exits NON-ZERO with a truthful EROFS and unchanged bytes",
    () => {
      const before = readFileSync(KEY, "utf8");
      const r = observe(runCombo(`rm -f '${KEY}'`));
      assert.notEqual(
        r.status,
        0,
        "rm -f must NOT exit 0 on the protected credential"
      );
      assert.match(r.stderr, /Read-only file system/);
      assert.ok(
        !r.stderr.includes(KEY_SENTINEL),
        "empty-ish refusal carries no credential content"
      );
      assert.equal(readFileSync(KEY, "utf8"), before, "bytes unchanged");
      assert.ok(existsSync(KEY), "the credential still exists");
    }
  );

  it.skipIf(SKIP)(
    "the EROFS stderr from the real fence fires the [fs_denied] guidance",
    () => {
      const r = observe(runCombo(`rm -f '${KEY}'`));
      const guidance = protectedTargetFenceGuidance(
        r.stderr,
        createProtectedTargetInventory({
          home: HOME,
          scanRoot: HOME,
        })
      );
      assert.ok(
        guidance !== undefined,
        "guidance must fire on the real refusal"
      );
      assert.ok(
        guidance!.startsWith(`${VIOLATION_PREFIXES.fsDenied} `),
        `typed prefix expected, got: ${guidance!.slice(0, 40)}`
      );
      // The receipt mechanism is withdrawn (issue #1159): the real-fence
      // guidance names no route, exactly as the synthetic pin in
      // protected-target-erofs-guidance.test.ts asserts.
      assert.ok(
        guidance!.includes("is not an operation this session"),
        "the refusal is stated unconditionally"
      );
      for (const withdrawn of [
        "authorization receipt",
        "cleanup window",
        "authorized route",
      ]) {
        assert.ok(
          !guidance!.includes(withdrawn),
          `the withdrawn ${withdrawn} is not advertised on the real fence path either`
        );
      }
    }
  );

  it.skipIf(SKIP)(
    "python3 os.remove on the same credential is refused by the same wall (non-zero, bytes unchanged)",
    () => {
      const before = readFileSync(KEY, "utf8");
      const r = observe(
        runCombo(`python3 -c "import os; os.remove('${KEY}')"`)
      );
      assert.notEqual(r.status, 0, "os.remove must not silently succeed");
      assert.match(r.stderr, /Read-only file system|EROFS|OSError/);
      assert.equal(readFileSync(KEY, "utf8"), before);
    }
  );

  it.skipIf(SKIP)(
    "rm -f on the exact-file /dev/null-masked credential is non-zero too (busy or ro refusal, never 0)",
    () => {
      const before = readFileSync(NETRC, "utf8");
      const r = observe(runCombo(`rm -f '${NETRC}'`));
      assert.notEqual(
        r.status,
        0,
        "unlink of a mask mountpoint is a truthful refusal"
      );
      assert.equal(readFileSync(NETRC, "utf8"), before, "bytes unchanged");
    }
  );

  it.skipIf(SKIP)(
    "reads stay masked-value-or-nothing under the same combo",
    () => {
      const c = observe(runCombo(`cat '${KEY}'`));
      assert.notEqual(c.status, 0, "cat on the masked key must fail");
      assert.ok(
        !c.stdout.includes(KEY_SENTINEL) && !c.stderr.includes(KEY_SENTINEL)
      );
      const a = observe(runCombo(`cat '${AWS}'`));
      assert.notEqual(
        a.status,
        0,
        "cat on the masked aws credentials must fail"
      );
      assert.ok(
        !a.stdout.includes(AWS_SENTINEL) && !a.stderr.includes(AWS_SENTINEL)
      );
      const p = observe(runCombo(`python3 -c "print(open('${AWS}').read())"`));
      assert.notEqual(p.status, 0);
      assert.ok(
        !p.stdout.includes(AWS_SENTINEL) && !p.stderr.includes(AWS_SENTINEL)
      );
    }
  );

  it("argv shape: no protected target is ever re-bound writable, and the mask stays above its subtree", () => {
    const argv = createBwrapFence({
      ...comboOptions(),
      onProtectedTargetSkipped: () => {},
    }).argv;
    const procIdx = argv.indexOf("--proc");
    for (const p of [SSH_DIR, AWS_DIR]) {
      const ro = tripleIdx(argv, "--ro-bind", p, p);
      assert.ok(ro >= 0 && ro < procIdx, `${p} keeps its ro triple`);
      assert.equal(
        tripleIdx(argv, "--bind", p, p),
        -1,
        `${p} is never re-bound writable anywhere in argv`
      );
    }
    const subtreeRo = tripleIdx(argv, "--ro-bind", SSH_DIR, SSH_DIR);
    const keyMask = tripleIdx(argv, "--ro-bind", "/dev/null", KEY);
    assert.ok(keyMask > subtreeRo, "the mask lands above the subtree bind");
  });

  it.skipIf(SKIP)(
    "workspace writes still succeed under the exact combo (the boundary block is a fence, not a freeze)",
    () => {
      const probe = join(TASK, "combo-write-probe");
      const w = observe(runCombo(`echo ok > '${probe}' && cat '${probe}'`));
      assert.equal(w.status, 0, `workspace write must succeed: ${w.stderr}`);
      assert.equal(readFileSync(probe, "utf8").trim(), "ok");
      rmSync(probe, { force: true });
    }
  );

  it.skipIf(SKIP)(
    "on-disk bytes are unchanged after every unauthorized attempt",
    () => {
      assert.equal(readFileSync(KEY, "utf8").includes(KEY_SENTINEL), true);
      assert.equal(
        readFileSync(AWS, "utf8"),
        `[default]\naws_access_key_id = ${AWS_SENTINEL}\n`
      );
      assert.equal(readFileSync(NETRC, "utf8").includes(NETRC_SENTINEL), true);
    }
  );

  it.skipIf(SKIP)(
    "no sentinel leaked into any fence output collected so far",
    () => {
      const all = outputs.join("\n");
      for (const s of [KEY_SENTINEL, AWS_SENTINEL, NETRC_SENTINEL]) {
        assert.ok(s.length > 0);
        assert.ok(
          !all.includes(s),
          "sentinel must stay unreachable inside the fence"
        );
      }
    }
  );
});
