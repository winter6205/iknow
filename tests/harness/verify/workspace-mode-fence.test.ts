/**
 * ADR-0092 — real workspace-mode fence behaviour on the **verify command face**.
 *
 * Mirrors `tests/harness/aci/bash-workspace-mode-fence.test.ts` (real bwrap,
 * `it.skipIf(!hasBwrap())`, whole group skipped when the host lacks bwrap),
 * but the subject under test is `makeDefaultRunVerify` (the verify loop's
 * default executor), not the bash tool.
 *
 * Why a separate file: `tests/harness/verify/sandbox-run.test.ts` vi.mocks
 * `createBwrapFence` / `runInSandbox` at file scope (to capture opts), so real
 * fences cannot run in the same file. argv shape and real behaviour must be
 * pinned by both files together (same split of duties as the bash face).
 *
 * Key shape: **the session tmp nests under homeRoot** (production shape — a
 * chat/hub session folder is `<home>/.iknow/projects/<slug>/<convId>/fence-tmp`).
 * That is the discriminating part:
 *   - `--ro-bind <home> <home>` covers the whole home tree first;
 *   - `--bind <session tmp>` must come after it (last-mount-wins) to pry that
 *     subtree writable again;
 *   - `$TMPDIR` must equal that host real path, otherwise `> "$TMPDIR/x"`
 *     inside the fence lands on `/x` (guest root) → EACCES.
 * Miss any one and the contract fails on this face (this file is the regression pin).
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
  /** Session tmp, **nested under homeRoot** (production shape). */
  readonly sessionTmp: string;
  /** taskRoot (fence cwd); outside home so the home ro-bind never covers the cwd bind. */
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
        // tmpDir absent — the fallback branch (V1 shape of unwired callers).
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
