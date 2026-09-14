/**
 * ADR-0092 / specs/fs-isolation-modes.md SC11 + SC12 — 工作区档真实围栏行为。
 *
 * 镜像 `tests/harness/aci/bash-main-session-fence-tmp.test.ts` 的形态（用
 * `it.skipIf(!hasBwrap())` 真实围栏跑测试，host 缺 bwrap 时整组跳过；本机
 * WSL 通常有 bwrap）。
 *
 * 验证以下真实围栏命题（不发黑盒 —— 文件都真写、错误码真读）：
 *   - workspace 档下写 home 普通文件失败（非零退出）；内核层 EROFS。
 *   - workspace 档下写 taskRoot 成功（写白名单 bind 覆盖回可写）。
 *   - workspace 档下写 $TMPDIR 成功（会话 tmp 写白名单）。
 *   - workspace 档下读 home 普通文件成功（home 可见但只读，非闭世界）。
 *   - global 档下写 home 成功（回归基线,与 V1 一致）。
 *
 * 形态对照：与 `bash-global-mode-visibility.test.ts` 平行 —— 该文件用 mock
 * 拦截 spawn 拿 argv,本文件用真实 bwrap 跑命令拿退出码。两组测试共同钉住
 * 「argv 形态」与「真实行为」,缺一不可。
 *
 * 路径取法:命令里用注入的 `homeRoot` 绝对路径,不写 `$HOME`。
 * `$HOME` 走 env 白名单从宿主 `process.env` 透传,指向真实用户 home;而
 * 本测试的 `homeRoot` 是 scratch fixture。生产装配下二者同值
 * (`homeRoot` 缺省即 `homedir()`),测试里必须显式用 fixture 绝对路径才能
 * 打到被 ro-bind 的那棵树 —— 否则断言会打到真实 home,既测不到围栏,
 * 又会污染宿主目录。
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

/** 装一个真实可用的小型 home:含一个可读文件 `readable.txt`。 */
function makeHomeFixture(): { readonly homeRoot: string } {
  const homeRoot = makeScratch("workspace-home-");
  writeFileSync(join(homeRoot, "readable.txt"), "home-visible", "utf8");
  return { homeRoot };
}

/**
 * 装一个真实 taskRoot + 会话 tmp。taskRoot 必须是 home 子树之外 —— 否则
 * home ro-bind 会盖过 taskRoot bind,bwrap last-mount-wins 会让 taskRoot
 * 不可写。两个 mkdtemp 各自独立,天然满足。
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
    // 透传 holder 与 homeRoot —— 装配期不读 holder,handler per-call 读
    // (`opts.fsMode?.get() ?? "global"`),与 liveTaskRoot 的 D2 batch
    // snapshot 纪律同款。
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
      // 文件不应该被造出来。
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
      // flip to workspace：下一次 handler 调用即按 workspace 档发 argv。
      ctx.set("workspace");
      const flipPath = join(homeRoot, "flip.txt");
      const writeHome = parseBash(
        await bash.handler({
          command: `printf deny > ${flipPath}`,
        })
      );
      assert.notEqual(writeHome.code, 0, "after flip, home must be read-only");
      assert.equal(existsSync(flipPath), false);
      // flip back：恢复 global 档可写。
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
 * S2 边界五类 —— **越界写**维度（不是 fence 入参维度）。
 *
 * 入参维度（homeRoot 缺席 / workspaceRoot-tmpRoot 缺席 / 非法 mode / 两 policy
 * 不同 tmp / 超长路径 argv 透传）在 `tests/harness/sandbox/fs-mode-workspace.test.ts`
 * 已覆盖；下面五组补的是「命令真的执行、写入真的发生/被拒、宿主侧真的不落盘」。
 *
 * 实测行为记录（bwrap 0.11.1 / 内核 EROFS）—— 注释只记测量结果，不写期望：
 *   - empty / negative / overflow 三类在围栏下由内核 EROFS 拒绝，退出码非零，
 *     宿主侧无新文件；`touch <home>` 连目录 mtime 都不变。
 *   - symlink 逃逸**不写穿**：taskRoot 内 symlink 指向 home 时，写入落在
 *     home ro-bind 覆盖层，内核回 EROFS；经同一 symlink 读 home 成功。
 *   - overflow 的 300 字符文件名在两种档下都是 ENAMETOOLONG（内核 NAME_MAX
 *     先于 mount 生效），故 overflow 用 255 字符边界名，才能让「档」成为
 *     判别条件。
 *   - exception：白名单根在装配后被删 → fence 装配期 fail-loud，
 *     `bash.handler` 抛 typed `server_unreachable`（bwrap 找不到 bind 源），
 *     不静默成功也不落盘。
 */
describe("工作区档围栏真实行为 — S2 empty：退化写目标", () => {
  it.skipIf(!hasBwrap())(
    "empty：touch 裸 home 目录失败（EROFS）且宿主 mtime 不变",
    async () => {
      // 裸 home（无文件名）是退化写目标：workspace 档下 EROFS，连目录
      // mtime 都不该被更新 —— 这是「写没发生」的宿主侧硬证据。
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
      // 判别力对照：同一条命令在 global 档必须成功并真的改到宿主 —— 否则
      // 上一条「EROFS」可能只是命令本身语法/权限问题，而非档位差异。
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
      // 三种退化形态都指向 home 目录 inode 本身。实测：三种都 EROFS（挂载层
      // 拒绝元数据写），宿主侧目录 mtime 不变、无新条目。判别名是 touch 而非
      // `> <dir>`：后者在两种档下都 EISDIR（内核先拒），不具档位判别力。
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
      // 生产 home 里 `~/.iknow` 恰是配置树；其中的非 taskRoot 位置（如
      // settings.json）必须拒绝。断言内容逐字节不变 —— 比 existsSync 更强，
      // 能抓住「先截断再 EROFS」这类部分写。
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
      // 白名单外的新建目录也是写：`~/.iknow/newdir` 在 home ro-bind 内，
      // mkdir 必须 EROFS。首条断言失败本因 EROFS 而非 EEXIST（fixture 里无此目录）。
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
      // `.ssh/` 命中 commandContainsSensitivePath —— 拒绝发生在 fence 之前，
      // 是 ToolExecutionError 而非围栏退出码。这条覆盖「敏感子路径」这一类，
      // 并钉住拒绝是 typed 的（name 判别，不靠消息字符串匹配）。
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
      // 实测结论（bwrap 0.11.1）：**不写穿，被 EROFS 拒绝**。home ro-bind 是
      // mount 层子树覆盖，路径解析落在覆盖层内即受只读约束，symlink 的
      // 目标 inode 不构成逃逸面。三种链接形态各验一次；同时经同一 symlink
      // 读 home 成功（证明链接本身有效，写入失败确因只读而非断链）。
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
      // 宿主侧：三个目标都没被动过。
      assert.equal(existsSync(join(homeRoot, "target-dir", "new.txt")), false);
      assert.equal(existsSync(join(homeRoot, "new-root.txt")), false);
      assert.equal(
        readFileSync(join(homeRoot, "target-file"), "utf8"),
        "orig",
        "symlinked home file must keep its content"
      );
      // 同一链接读得通 —— 证明链接有效、失败确因只读层。
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
      // 255 = ext4/xfs 的 NAME_MAX 边界，是「内核允许、档位决定成败」的
      // 唯一可判别长度。与既有 :352 的 argv 透传用例不同，这里真的执行。
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
      // 对照组：同一条命令 global 档成功并落盘 —— 判别力来自档位而非长度。
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
      // 超出 NAME_MAX 后内核先拒，档位不再是判别条件 —— 如实钉住这个上限，
      // 并确认 home 下没有残留条目（把「内核拒绝」与「围栏拒绝」区分开）。
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
      // 两次 fence 装配（不同 taskRoot / tmpRoot、同一 homeRoot）并发写同一
      // 目标。核心证据是内容仍是 original：任何一方写穿都会改到它。
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
      // 并发下的档位隔离：A 写自己 taskRoot（应成功落盘），B 同时写 home 其它
      // 位置（应 EROFS 不落盘）。证明并发不产生「谁的 fence 生效」漂移。
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
      // fence 装配本身无错（argv 里白名单路径是字面量），但 bind 源消失后
      // bwrap 起不来 → server 抛 typed `server_unreachable`。钉两点：抛的是
      // typed 错误（kind 判别，不是字符串）、home 侧不落盘。
      const { homeRoot } = makeHomeFixture();
      const taskRoot = makeScratch("workspace-task-exc-");
      const sessionTmp = makeScratch("workspace-tmp-exc-");
      const bash = buildBash({
        fsMode: createFsModeContext("workspace"),
        homeRoot,
        workspaceRoot: taskRoot,
        tmpDir: sessionTmp,
      });
      // 装配完成后删除白名单根。
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
      // 重建 taskRoot 供 afterEach 清理（rmSync 已幂等，此处仅为可读性）。
      mkdirSync(taskRoot, { recursive: true });
    }
  );

  it.skipIf(!hasBwrap())(
    "exception：taskRoot 存在但不可写（chmod 0555）—— 白名单失守仍不削弱 home 保护",
    async () => {
      // 对偶场景：bind 源存在、装配成功，写白名单内文件被 DAC 拒绝（该腿
      // 与档位无关）。真正由档位决定的是后半段：白名单失效时 home 仍必须是
      // EROFS —— 否则「白名单坏了」会退化成「哪都能写」。
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
        // 同一身份下 home 依旧不可写：白名单根不可写不构成越权面。
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
