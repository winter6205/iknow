/**
 * Private-key readability pin for specs/egress-ssh-bridge.md (grounds Assumption 5).
 *
 * Real-bwrap assertions (shape mirrors bash-workspace-mode-fence.test.ts's
 * `it.skipIf(!hasBwrap())`; local WSL has bwrap, the CI exclusion set is handled
 * separately):
 *   - global tier: `test -r ~/.ssh/id_ed25519` reads fine inside the fence
 *     (`--bind / /` is the base layer; key writable-and-visible is this tier's
 *     intended posture);
 *   - workspace tier: under the home `--ro-bind` (bwrap.ts workspaceMountArgs) the
 *     same fixture key IS readable (visible, not closed-world); any WRITE to the
 *     key MUST fail (EROFS), and the host-side file content is byte-identical
 *     afterwards (no write bypassed into some other copy).
 *
 * Discipline (specs/egress-ssh-bridge.md / ADR-0107):
 *   - fixture keys are always generated in tmpdir via
 *     `ssh-keygen -t ed25519 -N ""`; NEVER use / read / copy the operator's real
 *     `~/.ssh` private keys. HOME is redirected to the fixture home explicitly
 *     through the fence env, leaving the real home untouched;
 *   - this file never asserts key content and never prints private-key bytes.
 *
 * "The key-in-fence posture relies on egress domain limits as the backstop"
 * (ADR-0105 Decision 5): readability itself is not the vulnerability surface — the
 * risk converges on egress domain decisions. This file pins fs facts only.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";

function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

let FAKE_HOME = "";
let KEY_PATH = "";
let KEY_CONTENT_BEFORE = "";
let TASK = "";
let TMP = "";

beforeAll(() => {
  // bwrap absent = whole group skipped (CI shape); fixtures are moot, don't generate.
  if (!hasBwrap()) return;
  FAKE_HOME = scratchDir("iknow-t6-home-");
  TASK = scratchDir("iknow-t6-task-");
  TMP = scratchDir("iknow-t6-tmp-");
  const sshDir = join(FAKE_HOME, ".ssh");
  mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  KEY_PATH = join(sshDir, "id_ed25519");
  const gen = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-C", "iknow-t6-fixture", "-f", KEY_PATH, "-q"],
    { stdio: "ignore" }
  );
  assert.equal(gen.status, 0, "ssh-keygen fixture key generation must succeed");
  chmodSync(KEY_PATH, 0o600);
  KEY_CONTENT_BEFORE = readFileSync(KEY_PATH, "utf8");
});

afterAll(() => {
  for (const p of scratch.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

function runFence(
  mode: "global" | "workspace",
  script: string
): { status: number; stderr: string } {
  const argv = createBwrapFence({
    command: "bash",
    args: ["-c", script],
    fsPolicy: createFsPolicy({ tmpDir: TMP, mode }),
    // HOME redirected explicitly to the fixture home (operator's real home untouched).
    env: { HOME: FAKE_HOME, PATH: "/usr/bin:/bin" },
    cwd: TASK,
    ...(mode === "workspace"
      ? { homeRoot: FAKE_HOME, workspaceRoot: TASK, tmpRoot: TMP }
      : {}),
  }).argv;
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

describe("T6 私钥两档可读性（真 bwrap，fixture key 生成于 tmpdir）", () => {
  const skip = !hasBwrap();

  it.skipIf(skip)(
    "global 档：围栏内 test -r ~/.ssh/id_ed25519 可读（exit 0）",
    () => {
      const r = runFence("global", 'test -r "$HOME/.ssh/id_ed25519"');
      assert.equal(r.status, 0, `global read failed: stderr=${r.stderr}`);
    }
  );

  it.skipIf(skip)(
    "workspace 档：同一 fixture key 围栏内可读（home 可见但只读，非闭世界）",
    () => {
      const r = runFence("workspace", 'test -r "$HOME/.ssh/id_ed25519"');
      assert.equal(r.status, 0, `workspace read failed: stderr=${r.stderr}`);
    }
  );

  it.skipIf(skip)(
    "workspace 档：对 key 的写必败（ro-bind EROFS），宿主侧文件内容逐字节不变",
    () => {
      const r = runFence("workspace", 'echo tamper >> "$HOME/.ssh/id_ed25519"');
      assert.notEqual(r.status, 0, "write to ro-bound key must fail");
      assert.match(
        r.stderr.toLowerCase(),
        /read-only file system|erofs/,
        `expected EROFS-class failure, got: ${r.stderr}`
      );
      assert.equal(
        readFileSync(KEY_PATH, "utf8"),
        KEY_CONTENT_BEFORE,
        "key content must be untouched on host side"
      );
    }
  );
});
