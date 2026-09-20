/**
 * ADR-0092 — real fence behavior in workspace mode.
 *
 * Mirrors the shape of `tests/harness/aci/bash-main-session-fence-tmp.test.ts`
 * (runs under a real fence via `it.skipIf(!hasBwrap())`; the whole group is
 * skipped when the host lacks bwrap; WSL usually has it).
 *
 * Verifies the fence with real effects (files really written, exit codes really read):
 *   - writing a plain home file under workspace mode fails (nonzero exit; kernel EROFS).
 *   - writing taskRoot under workspace mode succeeds (the writable allow-list bind re-covers it).
 *   - writing $TMPDIR under workspace mode succeeds (session tmp allow-list).
 *   - reading a plain home file under workspace mode succeeds (home visible but read-only, not closed-world).
 *   - writing home under global mode succeeds (regression baseline).
 *
 * Companion shape: parallel to `bash-global-mode-visibility.test.ts` — that file
 * mocks spawn to capture argv; this one runs real bwrap commands to capture exit
 * codes. Both together pin "argv shape" and "real behavior"; neither alone suffices.
 *
 * Path choice: commands use the injected absolute `homeRoot`, never `$HOME`.
 * `$HOME` passes through the env allow-list from the host `process.env` and
 * points at the real user home, while this test's `homeRoot` is a scratch
 * fixture. In production they coincide (`homeRoot` defaults to `homedir()`),
 * but the test must name the fixture's absolute path to actually hit the
 * ro-bound tree — otherwise the assertions would target the real home, testing
 * nothing and polluting the host.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../src/harness/errors.js";
import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import {
  createFsModeContext,
  parseFsModeFlag,
  type FsModeContext,
} from "../../../src/harness/sandbox/fs-mode.js";

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

interface BashEnvelope {
  readonly output: string;
}

function parseBash(envelope: unknown): {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  return JSON.parse((envelope as BashEnvelope).output) as {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
  };
}

/** A small real, usable home fixture containing one readable file `readable.txt`. */
function makeHomeFixture(): { readonly homeRoot: string } {
  const homeRoot = makeScratch("workspace-home-");
  writeFileSync(join(homeRoot, "readable.txt"), "home-visible", "utf8");
  return { homeRoot };
}

/**
 * Real taskRoot + session tmp fixtures. taskRoot must live outside the home
 * subtree — otherwise the home ro-bind would cover the taskRoot bind and
 * bwrap's last-mount-wins would make taskRoot unwritable. Two independent
 * mkdtemp calls satisfy this naturally.
 */
function makeWorkspaceFixture(): {
  readonly taskRoot: string;
  readonly sessionTmp: string;
  readonly marker: string;
} {
  return {
    taskRoot: makeScratch("workspace-task-"),
    sessionTmp: makeScratch("workspace-session-tmp-"),
    marker: "sc11-workspace-marker",
  };
}

interface RunOptions {
  readonly fsMode: FsModeContext;
  readonly homeRoot: string;
  readonly workspaceRoot: string;
  readonly tmpDir: string;
}

function buildBash(opts: RunOptions): ReturnType<typeof createBashTool> {
  return createBashTool(opts.workspaceRoot, {
    // Pass the holder and homeRoot through; nothing reads the holder at
    // assembly time — the handler reads it per call
    // (`opts.fsMode?.get() ?? "global"`), the same per-call snapshot
    // discipline as liveTaskRoot.
    fsMode: opts.fsMode,
    homeRoot: opts.homeRoot,
    tmpDir: opts.tmpDir,
  });
}

describe("工作区档围栏真实行为（ADR-0092 SC11 / SC12）", () => {
  it.skipIf(!hasBwrap())(
    "workspace 档下读 home 普通文件成功（home 可见但只读）",
    async () => {
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp } = makeWorkspaceFixture();
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      const read = parseBash(
        await bash.handler({ command: `cat ${join(homeRoot, "readable.txt")}` })
      );
      assert.equal(read.code, 0, read.stderr);
      assert.equal(read.stdout, "home-visible");
    }
  );

  it.skipIf(!hasBwrap())(
    "workspace 档下写 home 普通文件失败（EROFS, 非零退出）",
    async () => {
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp } = makeWorkspaceFixture();
      const forbidden = join(homeRoot, "forbidden.txt");
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      const write = parseBash(
        await bash.handler({
          command: `printf deny > ${forbidden}`,
        })
      );
      assert.notEqual(
        write.code,
        0,
        `writing home under workspace mode must fail; code=${write.code}, stderr=${write.stderr}`
      );
      assert.match(
        write.stderr,
        /Read-only file system/,
        `kernel-level EROFS expected; stderr=${write.stderr}`
      );
      // the file must not have been created at all.
      assert.equal(
        existsSync(forbidden),
        false,
        "home forbidden.txt must not be created on disk"
      );
    }
  );

  it.skipIf(!hasBwrap())(
    "workspace 档下写 taskRoot 成功（写白名单覆盖回可写）",
    async () => {
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp, marker } = makeWorkspaceFixture();
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      const write = parseBash(
        await bash.handler({
          command: `printf ${marker} > "$PWD/sc11-task.txt" && cat "$PWD/sc11-task.txt"`,
        })
      );
      assert.equal(write.code, 0, write.stderr);
      assert.equal(write.stdout, marker);
      assert.equal(
        readFileSync(join(taskRoot, "sc11-task.txt"), "utf8"),
        marker,
        "taskRoot write must land on the host"
      );
    }
  );

  it.skipIf(!hasBwrap())(
    "workspace 档下写会话 tmp 成功（$TMPDIR 写白名单,SC12）",
    async () => {
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp, marker } = makeWorkspaceFixture();
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      const write = parseBash(
        await bash.handler({
          command: `printf ${marker} > "$TMPDIR/sc12.txt" && cat "$TMPDIR/sc12.txt"`,
        })
      );
      assert.equal(write.code, 0, write.stderr);
      assert.equal(write.stdout, marker);
      assert.equal(
        readFileSync(join(sessionTmp, "sc12.txt"), "utf8"),
        marker,
        "session tmp write must land on the host"
      );
    }
  );

  it.skipIf(!hasBwrap())(
    "global 档下写 home 成功（回归基线,与 V1 一致）",
    async () => {
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp } = makeWorkspaceFixture();
      const okPath = join(homeRoot, "global-ok.txt");
      const bash = buildBash({
        fsMode: createFsModeContext("global"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      const write = parseBash(
        await bash.handler({
          command: `printf global-home-ok > ${okPath} && cat ${okPath}`,
        })
      );
      assert.equal(write.code, 0, write.stderr);
      assert.equal(write.stdout, "global-home-ok");
      assert.equal(readFileSync(okPath, "utf8"), "global-home-ok");
    }
  );

  it.skipIf(!hasBwrap())(
    "holder 就地翻:flip global→workspace 后下一调用 argv 即改变（D2 纪律:per-call 读 holder）",
    async () => {
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp } = makeWorkspaceFixture();
      const ctx = createFsModeContext("global");
      const bash = buildBash({
        fsMode: ctx,
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      // flip to workspace: the next handler call already ships workspace argv.
      ctx.set("workspace");
      const flipPath = join(homeRoot, "flip.txt");
      const writeHome = parseBash(
        await bash.handler({
          command: `printf deny > ${flipPath}`,
        })
      );
      assert.notEqual(writeHome.code, 0, "after flip, home must be read-only");
      assert.equal(existsSync(flipPath), false);
      // flip back: global mode restores writability.
      ctx.set("global");
      const flip2Path = join(homeRoot, "flip2.txt");
      const writeHome2 = parseBash(
        await bash.handler({
          command: `printf global-again > ${flip2Path} && cat ${flip2Path}`,
        })
      );
      assert.equal(writeHome2.code, 0, writeHome2.stderr);
      assert.equal(writeHome2.stdout, "global-again");
      assert.equal(readFileSync(flip2Path, "utf8"), "global-again");
    }
  );
});

/**
 * Boundary-class suite for the **out-of-bounds write** dimension (not the
 * fence input-parameter dimension).
 *
 * The input dimension (homeRoot absent / workspaceRoot-tmpRoot absent /
 * illegal mode / two policies with different tmp / overlong-path argv
 * pass-through) is already covered by
 * `tests/harness/sandbox/fs-mode-workspace.test.ts`; the groups below verify
 * that commands really execute, writes really happen or are refused, and
 * nothing lands on the host.
 *
 * Measured behavior (bwrap 0.11.1 / kernel EROFS) — records observations,
 * not expectations:
 *   - empty / negative / overflow are refused by kernel EROFS under the
 *     fence: nonzero exit, no new host files; `touch <home>` does not even
 *     update the directory mtime.
 *   - symlink escape does **not** write through: a taskRoot symlink pointing
 *     into home resolves onto the home ro-bind overlay and gets EROFS;
 *     reading home through the same symlink succeeds.
 *   - a 300-char file name is ENAMETOOLONG in both modes (kernel NAME_MAX
 *     applies before mounts), so the overflow case uses a 255-char
 *     boundary-length name to make the fs-mode the discriminating factor.
 *   - exception: an allow-listed root deleted after assembly → the fence
 *     fails loudly: `bash.handler` throws typed `server_unreachable` (bwrap
 *     cannot find the bind source), never silent success, nothing lands.
 */
describe("工作区档围栏真实行为 — S2 empty：退化写目标", () => {
  it.skipIf(!hasBwrap())(
    "empty：touch 裸 home 目录失败（EROFS）且宿主 mtime 不变",
    async () => {
      // A bare home dir (no file name) is a degenerate write target: under
      // workspace mode it must EROFS without even updating the dir mtime —
      // hard host-side proof that the write really did not happen.
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp } = makeWorkspaceFixture();
      const before = statSync(homeRoot).mtimeMs;
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      const touch = parseBash(
        await bash.handler({ command: `touch ${homeRoot}` })
      );
      assert.notEqual(
        touch.code,
        0,
        `touch bare home must fail; code=${touch.code}, stderr=${touch.stderr}`
      );
      assert.match(touch.stderr, /Read-only file system/, touch.stderr);
      assert.equal(
        statSync(homeRoot).mtimeMs,
        before,
        "home mtime must not change (write really did not happen)"
      );
    }
  );

  it.skipIf(!hasBwrap())(
    "empty：global 档下同一 touch 成功且 mtime 前进（对照组）",
    async () => {
      // Discriminating control: the same command must succeed under global
      // mode and really modify the host — otherwise the previous EROFS could
      // be a syntax/permission problem of the command, not a mode difference.
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp } = makeWorkspaceFixture();
      const before = statSync(homeRoot).mtimeMs;
      const bash = buildBash({
        fsMode: createFsModeContext("global"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      const touch = parseBash(
        await bash.handler({ command: `touch ${homeRoot}` })
      );
      assert.equal(touch.code, 0, touch.stderr);
      assert.notEqual(
        statSync(homeRoot).mtimeMs,
        before,
        "global mode must actually update the host dir mtime"
      );
    }
  );

  it.skipIf(!hasBwrap())(
    "empty：touch 裸 home / home/ / home/. 均 EROFS，宿主 mtime 与条目不变",
    async () => {
      // All three degenerate forms target the home directory inode itself.
      // Measured: all three get EROFS (the mount layer refuses metadata
      // writes); host dir mtime unchanged, no new entries. The probe is
      // touch rather than `> <dir>`: the latter yields EISDIR in both modes
      // (kernel rejects first), so it cannot discriminate modes.
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp } = makeWorkspaceFixture();
      const beforeMtime = statSync(homeRoot).mtimeMs;
      const beforeEntries = (readdirSync(homeRoot) as string[]).sort();
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      for (const target of [homeRoot, `${homeRoot}/`, `${homeRoot}/.`]) {
        const write = parseBash(
          await bash.handler({ command: `touch ${target}` })
        );
        assert.notEqual(
          write.code,
          0,
          `touch ${target} must fail; code=${write.code}, stderr=${write.stderr}`
        );
        assert.match(write.stderr, /Read-only file system/, write.stderr);
      }
      assert.equal(
        statSync(homeRoot).mtimeMs,
        beforeMtime,
        "home mtime must not change after any degenerate touch"
      );
      assert.deepEqual(
        (readdirSync(homeRoot) as string[]).sort(),
        beforeEntries,
        "no new entry may appear in home"
      );
    }
  );
});

describe("工作区档围栏真实行为 — S2 negative：白名单外 home 子路径", () => {
  it.skipIf(!hasBwrap())(
    "negative：写 ~/.iknow/settings.json 失败且宿主内容逐字节不变",
    async () => {
      // In production home, `~/.iknow` is exactly the config tree; writes to
      // non-taskRoot locations inside it (e.g. settings.json) must be refused.
      // Asserting the content byte-for-byte unchanged is stronger than
      // existsSync — it catches partial writes like "truncate first, then EROFS".
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp } = makeWorkspaceFixture();
      mkdirSync(join(homeRoot, ".iknow"), { recursive: true });
      const settings = join(homeRoot, ".iknow", "settings.json");
      writeFileSync(settings, '{"seed":true}', "utf8");
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      const write = parseBash(
        await bash.handler({ command: `printf deny > ${settings}` })
      );
      assert.notEqual(write.code, 0, write.stderr);
      assert.match(write.stderr, /Read-only file system/, write.stderr);
      assert.equal(
        readFileSync(settings, "utf8"),
        '{"seed":true}',
        "~/.iknow/settings.json must keep its host content"
      );
    }
  );

  it.skipIf(!hasBwrap())(
    "negative：写 ~/.bashrc 失败且不落盘（新增 home 根文件）",
    async () => {
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp } = makeWorkspaceFixture();
      const bashrc = join(homeRoot, ".bashrc");
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      const write = parseBash(
        await bash.handler({ command: `printf deny > ${bashrc}` })
      );
      assert.notEqual(write.code, 0, write.stderr);
      assert.match(write.stderr, /Read-only file system/, write.stderr);
      assert.equal(existsSync(bashrc), false, "~/.bashrc must not be created");
    }
  );

  it.skipIf(!hasBwrap())(
    "negative：写 ~/.iknow 下新建子目录失败（EROFS，无目录落地）",
    async () => {
      // Creating a directory outside the allow-list is also a write:
      // `~/.iknow/newdir` sits inside the home ro-bind, so mkdir must EROFS.
      // The failure must be EROFS, not EEXIST (the fixture has no such dir).
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp } = makeWorkspaceFixture();
      mkdirSync(join(homeRoot, ".iknow"), { recursive: true });
      const newDir = join(homeRoot, ".iknow", "brand-new-dir");
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      const mkdir = parseBash(
        await bash.handler({ command: `mkdir ${newDir}` })
      );
      assert.notEqual(mkdir.code, 0, mkdir.stderr);
      assert.match(mkdir.stderr, /Read-only file system/, mkdir.stderr);
      assert.equal(existsSync(newDir), false, "no directory may land in home");
    }
  );

  it.skipIf(!hasBwrap())(
    "negative：写 ~/.ssh 下文件在 handler 层被 typed 拒绝（不 spawn）",
    async () => {
      // `.ssh/` hits commandContainsSensitivePath — the rejection happens
      // before the fence and is a ToolExecutionError, not a fence exit code.
      // Pins that the sensitive-subpath rejection is typed (discriminated by
      // name, not by message-string matching).
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp } = makeWorkspaceFixture();
      mkdirSync(join(homeRoot, ".ssh"), { recursive: true });
      const authorized = join(homeRoot, ".ssh", "authorized_keys");
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      await assert.rejects(
        () => bash.handler({ command: `printf deny > ${authorized}` }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          error.name === "ToolExecutionError",
        "sensitive-path write must be a typed pre-spawn rejection"
      );
      assert.equal(
        existsSync(authorized),
        false,
        "~/.ssh/authorized_keys must not be created"
      );
    }
  );

  it.skipIf(!hasBwrap())(
    "negative：taskRoot 内 symlink 指向 home 时经链接写 —— 实测 EROFS 不写穿",
    async () => {
      // Measured (bwrap 0.11.1): no write-through — refused with EROFS. The
      // home ro-bind is a mount-level subtree overlay: path resolution
      // landing inside it is read-only, and a symlink's target inode is not
      // an escape surface. Each of the three link shapes is verified;
      // reading home through the same symlink succeeds, proving the link is
      // live and the write fails due to read-only, not a broken link.
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp } = makeWorkspaceFixture();
      mkdirSync(join(homeRoot, "target-dir"), { recursive: true });
      writeFileSync(join(homeRoot, "target-file"), "orig", "utf8");
      symlinkSync(
        join(homeRoot, "target-dir"),
        join(taskRoot, "link-dir"),
        "dir"
      );
      symlinkSync(
        join(homeRoot, "target-file"),
        join(taskRoot, "link-file"),
        "file"
      );
      symlinkSync(homeRoot, join(taskRoot, "link-home"), "dir");
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      const viaDir = parseBash(
        await bash.handler({
          command: `printf x > ${join(taskRoot, "link-dir", "new.txt")}`,
        })
      );
      assert.notEqual(viaDir.code, 0, viaDir.stderr);
      assert.match(viaDir.stderr, /Read-only file system/, viaDir.stderr);
      const viaFile = parseBash(
        await bash.handler({
          command: `printf x > ${join(taskRoot, "link-file")}`,
        })
      );
      assert.notEqual(viaFile.code, 0, viaFile.stderr);
      assert.match(viaFile.stderr, /Read-only file system/, viaFile.stderr);
      const viaHome = parseBash(
        await bash.handler({
          command: `printf x > ${join(taskRoot, "link-home", "new-root.txt")}`,
        })
      );
      assert.notEqual(viaHome.code, 0, viaHome.stderr);
      assert.match(viaHome.stderr, /Read-only file system/, viaHome.stderr);
      // Host side: none of the three targets was touched.
      assert.equal(existsSync(join(homeRoot, "target-dir", "new.txt")), false);
      assert.equal(existsSync(join(homeRoot, "new-root.txt")), false);
      assert.equal(
        readFileSync(join(homeRoot, "target-file"), "utf8"),
        "orig",
        "symlinked home file must keep its content"
      );
      // Reads through the same symlink work — proof the links are valid and
      // the failure comes from the read-only layer.
      const read = parseBash(
        await bash.handler({ command: `cat ${join(taskRoot, "link-file")}` })
      );
      assert.equal(read.code, 0, read.stderr);
      assert.equal(read.stdout, "orig");
    }
  );
});

describe("工作区档围栏真实行为 — S2 overflow：超长路径真写", () => {
  it.skipIf(!hasBwrap())(
    "overflow：255 字符文件名写 home 失败（EROFS）而 global 档成功",
    async () => {
      // 255 = the NAME_MAX boundary on ext4/xfs, the only length where the
      // kernel allows the name and the fs-mode decides the outcome. Unlike
      // the argv pass-through case elsewhere, this one really executes.
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp } = makeWorkspaceFixture();
      const longName = "z".repeat(255);
      const target = join(homeRoot, longName);
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      const blocked = parseBash(
        await bash.handler({ command: `printf deny > ${target}` })
      );
      assert.notEqual(blocked.code, 0, blocked.stderr);
      assert.match(blocked.stderr, /Read-only file system/, blocked.stderr);
      assert.equal(existsSync(target), false, "long-name file must not land");
      // Control: the same command succeeds and lands on disk under global
      // mode — the discrimination comes from the mode, not the name length.
      const globalBash = buildBash({
        fsMode: createFsModeContext("global"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      const allowed = parseBash(
        await globalBash.handler({ command: `printf ok > ${target}` })
      );
      assert.equal(allowed.code, 0, allowed.stderr);
      assert.equal(readFileSync(target, "utf8"), "ok");
    }
  );

  it.skipIf(!hasBwrap())(
    "overflow：300 字符文件名两种档下都失败（内核 ENAMETOOLONG，无文件落地）",
    async () => {
      // Beyond NAME_MAX the kernel rejects first, so the mode is no longer
      // the discriminator — pin this ceiling as measured and confirm no
      // leftover entries in home (distinguishing kernel refusal from fence refusal).
      const { homeRoot } = makeHomeFixture();
      const { taskRoot, sessionTmp } = makeWorkspaceFixture();
      const tooLong = join(homeRoot, "y".repeat(300));
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      const write = parseBash(
        await bash.handler({ command: `printf deny > ${tooLong}` })
      );
      assert.notEqual(write.code, 0, write.stderr);
      assert.match(write.stderr, /File name too long/, write.stderr);
      assert.deepEqual(
        readdirSync(homeRoot),
        ["readable.txt"],
        "home must contain only the fixture file after the overflow write"
      );
    }
  );
});

describe("工作区档围栏真实行为 — S2 concurrent：两个身份并行", () => {
  it.skipIf(!hasBwrap())(
    "concurrent：两个身份同写 home 同一文件 —— 都失败且宿主内容不变",
    async () => {
      // Two fence assemblies (different taskRoot / tmpRoot, same homeRoot)
      // write the same target concurrently. Core evidence: the content is
      // still "original" — a write-through by either side would change it.
      const { homeRoot } = makeHomeFixture();
      const taskA = makeScratch("workspace-task-a-");
      const taskB = makeScratch("workspace-task-b-");
      const tmpA = makeScratch("workspace-tmp-a-");
      const tmpB = makeScratch("workspace-tmp-b-");
      const shared = join(homeRoot, "shared.txt");
      writeFileSync(shared, "original", "utf8");
      const bashA = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskA,
        tmpDir: tmpA,
      });
      const bashB = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskB,
        tmpDir: tmpB,
      });
      const [resA, resB] = await Promise.all([
        bashA.handler({ command: `printf a > ${shared}` }).then(parseBash),
        bashB.handler({ command: `printf b > ${shared}` }).then(parseBash),
      ]);
      assert.notEqual(resA.code, 0, `identity A must fail; ${resA.stderr}`);
      assert.notEqual(resB.code, 0, `identity B must fail; ${resB.stderr}`);
      assert.match(resA.stderr, /Read-only file system/, resA.stderr);
      assert.match(resB.stderr, /Read-only file system/, resB.stderr);
      assert.equal(
        readFileSync(shared, "utf8"),
        "original",
        "neither identity may overwrite the host file"
      );
    }
  );

  it.skipIf(!hasBwrap())(
    "concurrent：一写白名单一写 home —— 前者成功后者失败（互不串档）",
    async () => {
      // Mode isolation under concurrency: A writes its own taskRoot (must
      // land), B concurrently writes elsewhere in home (must EROFS, nothing
      // lands). Proves concurrency never drifts "whose fence applies".
      const { homeRoot } = makeHomeFixture();
      const taskA = makeScratch("workspace-task-a2-");
      const taskB = makeScratch("workspace-task-b2-");
      const tmpA = makeScratch("workspace-tmp-a2-");
      const tmpB = makeScratch("workspace-tmp-b2-");
      const allowedPath = join(taskA, "allowed.txt");
      const forbiddenPath = join(homeRoot, "forbidden-parallel.txt");
      const bashA = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskA,
        tmpDir: tmpA,
      });
      const bashB = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskB,
        tmpDir: tmpB,
      });
      const [resA, resB] = await Promise.all([
        bashA
          .handler({ command: `printf ok > ${allowedPath}` })
          .then(parseBash),
        bashB
          .handler({ command: `printf deny > ${forbiddenPath}` })
          .then(parseBash),
      ]);
      assert.equal(resA.code, 0, resA.stderr);
      assert.equal(readFileSync(allowedPath, "utf8"), "ok");
      assert.notEqual(resB.code, 0, resB.stderr);
      assert.match(resB.stderr, /Read-only file system/, resB.stderr);
      assert.equal(
        existsSync(forbiddenPath),
        false,
        "home write must not land while a sibling identity writes its taskRoot"
      );
    }
  );
});

describe("工作区档围栏真实行为 — S2 exception：装配后白名单根失效", () => {
  it.skipIf(!hasBwrap())(
    "exception：taskRoot 在装配后被删 —— handler 抛 typed 失败，不静默成功",
    async () => {
      // Fence assembly itself is fine (allow-list paths in argv are
      // literals), but once the bind source disappears bwrap cannot start →
      // the server throws typed `server_unreachable`. Two pins: the thrown
      // error is typed (discriminated by kind, not string) and nothing lands
      // in home.
      const { homeRoot } = makeHomeFixture();
      const taskRoot = makeScratch("workspace-task-exc-");
      const sessionTmp = makeScratch("workspace-tmp-exc-");
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      // Delete the allow-listed root after assembly.
      rmSync(taskRoot, { recursive: true, force: true });
      const forbidden = join(homeRoot, "must-not-exist.txt");
      await assert.rejects(
        () => bash.handler({ command: `printf deny > ${forbidden}` }),
        (error: unknown) => {
          const typed = error as { kind?: string };
          return (
            typeof typed === "object" &&
            typed !== null &&
            typed.kind === "server_unreachable"
          );
        },
        "missing bind source must surface as typed server_unreachable, never silent success"
      );
      assert.equal(
        existsSync(forbidden),
        false,
        "failed fence assembly must not write into home"
      );
      // Recreate taskRoot for afterEach cleanup (rmSync is already
      // idempotent; this is only for readability).
      mkdirSync(taskRoot, { recursive: true });
    }
  );

  it.skipIf(!hasBwrap())(
    "exception：taskRoot 存在但不可写（chmod 0555）—— 白名单失守仍不削弱 home 保护",
    async () => {
      // Dual scenario: the bind source exists and assembly succeeds, but
      // writing a file inside the allow-list is refused by DAC (that leg is
      // mode-independent). What the mode really decides is the second half:
      // even with a broken allow-list root, home must still be EROFS —
      // otherwise "allow-list broken" would degrade into "writable anywhere".
      const { homeRoot } = makeHomeFixture();
      const taskRoot = makeScratch("workspace-task-ro-");
      const sessionTmp = makeScratch("workspace-tmp-ro-");
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      chmodSync(taskRoot, 0o555);
      try {
        const target = join(taskRoot, "cannot.txt");
        const write = parseBash(
          await bash.handler({ command: `printf deny > ${target}` })
        );
        assert.notEqual(write.code, 0, write.stderr);
        assert.equal(existsSync(target), false);
        // Home stays unwritable for the same identity: an unwritable
        // allow-list root does not create an escape surface.
        const homeTarget = join(homeRoot, "still-blocked.txt");
        const homeWrite = parseBash(
          await bash.handler({ command: `printf deny > ${homeTarget}` })
        );
        assert.notEqual(homeWrite.code, 0, homeWrite.stderr);
        assert.match(
          homeWrite.stderr,
          /Read-only file system/,
          homeWrite.stderr
        );
        assert.equal(existsSync(homeTarget), false);
      } finally {
        chmodSync(taskRoot, 0o755);
      }
    }
  );
});

describe("parseFsModeFlag + createFsModeContext — holder 接口层", () => {
  it("parseFsModeFlag 与 settings 段非法值 fail-closed 纪律同款", () => {
    assert.equal(parseFsModeFlag("global"), "global");
    assert.equal(parseFsModeFlag("workspace"), "workspace");
    assert.equal(parseFsModeFlag(""), undefined);
    assert.equal(parseFsModeFlag("true"), undefined);
  });

  it("createFsModeContext('workspace') 初值工作区档", () => {
    const ctx = createFsModeContext("workspace");
    assert.equal(ctx.get(), "workspace");
    ctx.set("global");
    assert.equal(ctx.get(), "global");
  });
});
