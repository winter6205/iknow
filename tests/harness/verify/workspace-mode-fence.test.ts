/**
 * ADR-0092 / specs/fs-isolation-modes.md SC11 + SC12 — **verify 命令面**的
 * 工作区档真实围栏行为。
 *
 * 镜像 `tests/harness/aci/bash-workspace-mode-fence.test.ts` 的形态（真实
 * bwrap，`it.skipIf(!hasBwrap())`，host 缺 bwrap 时整组跳过），但被测面是
 * `makeDefaultRunVerify`（verify 闭环的缺省执行体），不是 bash 工具。
 *
 * 为什么单独一份：`tests/harness/verify/sandbox-run.test.ts` 在文件级
 * `vi.mock` 掉了 `sandbox/index.ts` 的 `createBwrapFence` / `runInSandbox`
 * （捕获 opts 用），mock 是文件级的 —— 同一个文件里跑不了真围栏。argv 形态
 * 与真实行为必须两组测试共同钉住（与 bash 面同款分工）。
 *
 * 关键形状：**会话 tmp 嵌套在 homeRoot 之下**（生产形态 —— chat/hub 的会话
 * 文件夹是 `<home>/.iknow/projects/<slug>/<convId>/fence-tmp`）。这正是
 * 判别力所在：
 *   - `--ro-bind <home> <home>` 先盖住整棵 home；
 *   - `--bind <会话 tmp>` 必须晚于它（last-mount-wins）才能把该子树撬回可写；
 *   - `$TMPDIR` 必须等于该宿主真路径，否则围栏内的 `> "$TMPDIR/x"` 落到
 *     `/x`（guest 根）→ EACCES。
 * 缺任一条 → SC12 在该面上不成立（本文件即回归钉）。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { makeDefaultRunVerify } from "../../../src/harness/verify/sandbox-run.ts";

const scratchPaths: string[] = [];

function makeScratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

interface WorkspaceFixture {
  readonly homeRoot: string;
  /** 会话 tmp，**嵌套在 homeRoot 之下**（生产形态）。 */
  readonly sessionTmp: string;
  /** taskRoot（围栏 cwd）；home 之外，避免 home ro-bind 盖过 cwd bind。 */
  readonly taskRoot: string;
}

function makeWorkspaceFixture(): WorkspaceFixture {
  const homeRoot = makeScratch("verify-ws-home-");
  const taskRoot = makeScratch("verify-ws-task-");
  const sessionTmp = join(
    homeRoot,
    ".iknow",
    "projects",
    "slug",
    "conv1",
    "fence-tmp"
  );
  mkdirSync(sessionTmp, { recursive: true });
  writeFileSync(join(homeRoot, "readable.txt"), "home-visible", "utf8");
  return { homeRoot, sessionTmp, taskRoot };
}

describe("verify 命令面工作区档真实围栏（ADR-0092 SC11 / SC12）", () => {
  it.skipIf(!hasBwrap())(
    "$TMPDIR 指向会话 tmp 宿主真路径（嵌套在 home 之下也成立，SC12）",
    async () => {
      const { homeRoot, sessionTmp, taskRoot } = makeWorkspaceFixture();
      const runVerify = makeDefaultRunVerify({
        cwd: taskRoot,
        tmpDir: sessionTmp,
        fsMode: "workspace",
        homeRoot,
      });
      const result = await runVerify(`printf %s "$TMPDIR"`, {});
      assert.equal(
        result.stdout,
        sessionTmp,
        `$TMPDIR 必须等于会话 tmp 真路径；stderr=${result.stderr}`
      );
    }
  );

  it.skipIf(!hasBwrap())(
    "写 $TMPDIR 成功且落宿主会话 tmp（home 子树内唯一可写处，SC12）",
    async () => {
      const { homeRoot, sessionTmp, taskRoot } = makeWorkspaceFixture();
      const runVerify = makeDefaultRunVerify({
        cwd: taskRoot,
        tmpDir: sessionTmp,
        fsMode: "workspace",
        homeRoot,
      });
      const result = await runVerify(
        `printf sc12-marker > "$TMPDIR/sc12.txt" && cat "$TMPDIR/sc12.txt"`,
        {}
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, "sc12-marker");
      assert.equal(
        readFileSync(join(sessionTmp, "sc12.txt"), "utf8"),
        "sc12-marker",
        "会话 tmp 写必须落宿主真路径"
      );
    }
  );

  it.skipIf(!hasBwrap())(
    "写 home 下非白名单路径失败且不落盘（SC11，证明档位真的生效）",
    async () => {
      const { homeRoot, sessionTmp, taskRoot } = makeWorkspaceFixture();
      const forbidden = join(homeRoot, "forbidden.txt");
      const runVerify = makeDefaultRunVerify({
        cwd: taskRoot,
        tmpDir: sessionTmp,
        fsMode: "workspace",
        homeRoot,
      });
      const result = await runVerify(`printf deny > ${forbidden}`, {});
      assert.notEqual(
        result.exitCode,
        0,
        `workspace 档下写 home 必须失败；stderr=${result.stderr}`
      );
      assert.match(result.stderr, /Read-only file system/);
      assert.equal(existsSync(forbidden), false, "home forbidden.txt 不得落盘");
    }
  );

  it.skipIf(!hasBwrap())(
    "读 home 普通文件成功（home 可见但只读，SC11）",
    async () => {
      const { homeRoot, sessionTmp, taskRoot } = makeWorkspaceFixture();
      const runVerify = makeDefaultRunVerify({
        cwd: taskRoot,
        tmpDir: sessionTmp,
        fsMode: "workspace",
        homeRoot,
      });
      const result = await runVerify(
        `cat ${join(homeRoot, "readable.txt")}`,
        {}
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, "home-visible");
    }
  );

  it.skipIf(!hasBwrap())(
    "tmpDir 缺省（回退进程 tmpdir）时 $TMPDIR 仍可用 —— 未接线路径不静默坏",
    async () => {
      const { homeRoot, taskRoot } = makeWorkspaceFixture();
      const runVerify = makeDefaultRunVerify({
        cwd: taskRoot,
        // tmpDir 缺席 —— 回退分支（未接线调用方的 V1 形态）。
        fsMode: "workspace",
        homeRoot,
      });
      const result = await runVerify(`printf %s "$TMPDIR"`, {});
      assert.equal(
        result.stdout,
        tmpdir(),
        "缺省回退必须是进程 tmpdir()（fallback，不是目标态）"
      );
    }
  );
});
