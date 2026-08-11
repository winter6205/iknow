/**
 * #196 rev 2026-08-11 T12 — E2E: 首启引导文件驱动隐式完成。
 *
 * 全链路(隔离 HOME,不碰真实用户数据,直接调最低层装配函数避开
 * build-engine 跨分支未提交改动):
 * 1. initializeIknowWorkspace 首次 → seed user.md + state.json(bs=true)
 *    + ~/.iknow/BOOTSTRAP.md
 * 2. assembleIdentityContext(bootstrapActive=true) → system 含 "First Contact"
 * 3. 模拟 agent 引导对话完成:对文件系统操作 = bash 等价物(bwrap 把整个
 *    home --bind 进沙箱,bash 可自由写 ~/.iknow/)。
 *    写 ~/.iknow/user.md + rm ~/.iknow/BOOTSTRAP.md
 * 4. assembleIdentityContext 二次 → 不含 "First Contact"(BOOTSTRAP.md
 *    缺失 → 装配不注入 → 引导完成)
 * 5. user.md 内容 turn 级生效
 *
 * 断言点:
 *  - 首次 system 含 "First Contact" / "Goals"
 *  - user.md 内容 turn 级生效
 *  - 删 BOOTSTRAP.md 后二次 system 不含 bootstrap 段
 *  - state.json bootstrap_seeded=true(seed 即翻旗,可审计)
 *  - ask 入口(bootstrapActive=false)即使文件存在也不注入
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeIknowWorkspace,
  readIknowState,
  assembleIdentityContext,
} from "../../src/harness/identity/index.js";

let origHome: string | undefined;
let fakeHome: string;
let fakeIknow: string;

beforeAll(async () => {
  origHome = process.env.HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "iknow-bootstrap-e2e-"));
  fakeIknow = join(fakeHome, ".iknow");
  await mkdir(fakeIknow, { recursive: true });
  process.env.HOME = fakeHome;
});

afterAll(async () => {
  process.env.HOME = origHome;
  await rm(fakeHome, { recursive: true, force: true });
});

describe("#196 T12 E2E: bootstrap 文件驱动隐式完成", () => {
  it("首次 init → system 注入 BOOTSTRAP;写 user.md + rm BOOTSTRAP.md → 二次不注入", async () => {
    // 1. 首次初始化:seed user.md + state(bs=true) + BOOTSTRAP.md
    const init = await initializeIknowWorkspace({ workspace: fakeIknow });
    expect(init.state.bootstrap_seeded).toBe(true);
    const bootstrapContent = await readFile(
      join(fakeIknow, "BOOTSTRAP.md"),
      "utf8"
    );
    expect(bootstrapContent).toContain("First Contact");

    // 2. 首次装配 → system 注入 bootstrap 段
    const firstSystem =
      (await assembleIdentityContext({
        cwd: fakeHome,
        userHome: fakeHome,
        bootstrapActive: true,
        memoryEnabled: false,
      })) ?? "";
    expect(firstSystem).toContain("First Contact");
    expect(firstSystem).toContain("Goals");
    expect(firstSystem).toContain("User Profile");

    // 3. 模拟 agent 引导对话完成:bwrap 把整个 home --bind 进沙箱,bash 可
    //    自由读写 ~/.ikknow/(硬墙不拦 .iknow 路径,non-allowlisted 命令
    //    走 ask tier)。这里用文件系统操作等价模拟 bash 执行。
    const userProfile = join(fakeIknow, "user.md");
    await writeFile(
      userProfile,
      "# Profile\n- Name: E2E\n- Goal: test bootstrap\n",
      "utf8"
    );
    await unlink(join(fakeIknow, "BOOTSTRAP.md"));

    // 4. 二次装配 → user.md 内容生效 + bootstrap 段消失
    const secondSystem =
      (await assembleIdentityContext({
        cwd: fakeHome,
        userHome: fakeHome,
        bootstrapActive: true,
        memoryEnabled: false,
      })) ?? "";
    expect(secondSystem).toContain("- Name: E2E");
    expect(secondSystem).toContain("- Goal: test bootstrap");
    expect(secondSystem).not.toContain("First Contact");

    // 5. state 审计:bs=true(seed 即翻旗,可审计)
    const state = await readIknowState(fakeIknow);
    expect(state.bootstrap_seeded).toBe(true);
  });

  it("ask surface (bootstrapActive=false): 即使 BOOTSTRAP.md 存在也不注入", async () => {
    // 重建 BOOTSTRAP.md(模拟首次未完成)
    await writeFile(
      join(fakeIknow, "BOOTSTRAP.md"),
      "# BOOTSTRAP.md - First Contact\n\nnot done yet\n",
      "utf8"
    );
    const askSystem =
      (await assembleIdentityContext({
        cwd: fakeHome,
        userHome: fakeHome,
        bootstrapActive: false,
        memoryEnabled: false,
      })) ?? "";
    expect(askSystem).not.toContain("First Contact");
    // 清掉,留给其它测试干净状态
    await unlink(join(fakeIknow, "BOOTSTRAP.md")).catch(() => {});
  });
});
