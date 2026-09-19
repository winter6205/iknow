/**
 * egress-ssh-bridge T6 —— 私钥可读性现状钉子（assumption 5 地面化）。
 *
 * 真起 bwrap 断言（形态镜像 bash-workspace-mode-fence.test.ts 的
 * `it.skipIf(!hasBwrap())`；本机 WSL 有 bwrap，CI 排除集另管）：
 *   - global 档：围栏内 `test -r ~/.ssh/id_ed25519` 可读（`--bind / /`
 *     打底，key 可写可见是本档既定姿态）；
 *   - workspace 档：home `--ro-bind`（bwrap.ts workspaceMountArgs）下同一
 *     fixture key **可读**（可见非闭世界）、对 key 的**写**必败（EROFS），
 *     且宿主侧文件内容事后逐字节不变（写没有旁路落到别的副本）。
 *
 * 纪律（plans/egress-ssh-bridge.md 子弹 6 CONSTRAINTS）：
 *   - fixture key 一律 `ssh-keygen -t ed25519 -N ""` 生成于 tmpdir，
 *     **绝不使用 / 读取 / 复制操作员真实 `~/.ssh` 私钥**；HOME 经围栏
 *     env 显式重定向到 fixture home，不动真 home；
 *   - 本文件不断言 key 内容、不输出私钥字节。
 *
 * 「key 进围栏的姿态 = 出口域限制兜底」（ADR-0105 §Decision 5）：可读性
 * 本身不是漏洞面，风险收敛于 egress 域判定；此处只钉 fs 事实。
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
  // bwrap 缺席 = 整组 skip（CI 形态），fixture 无从谈起，不生成。
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
    // HOME 显式重定向到 fixture home（不动操作员真 home）。
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
