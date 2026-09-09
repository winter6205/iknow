/**
 * scripts/sandbox-probe-closed-world.ts 的纯逻辑契约（T1，plans/closed-world-bash-fence.md）。
 *
 * 为什么只测纯函数:探针本体是 bwrap 围栏的实测（ground truth = 真跑），
 * 测试钉住的是判定与 argv 装配的可复现面——skip 判定不把主机上就不存在的
 * 工具伪装成断链、闭世界 argv 里不出现任何 home bind（整个 T1 的前提）。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  buildClosedWorldArgv,
  buildClosedWorldBaseArgs,
  buildPathProbeCommand,
  buildRcProbeCommand,
  buildScenarios,
  classifyOutcome,
  formatOutcomeLine,
  summarizeBreakCandidates,
  summarizeText,
  type InventoryOutcome,
  type InventoryScenario,
} from "../../scripts/sandbox-probe-closed-world.ts";

function scenario(
  overrides: Partial<InventoryScenario> = {}
): InventoryScenario {
  return {
    name: "s",
    command: "cmd",
    expect: "break-candidate",
    group: "toolchain",
    suggestion: "建议",
    ...overrides,
  };
}

function outcome(overrides: Partial<InventoryOutcome> = {}): InventoryOutcome {
  return {
    scenario: scenario(),
    status: "ok",
    exitCode: 0,
    hostExitCode: 0,
    detail: "",
    candidate: false,
    ...overrides,
  };
}

describe("closed-world inventory classifyOutcome", () => {
  it("主机基线即失败(非 0 或 null)= skip,不伪装成 ok/BREAK", () => {
    for (const expect of ["works", "break-candidate", "hidden"] as const) {
      assert.deepEqual(classifyOutcome(expect, 1, 0), {
        status: "skip",
        candidate: false,
      });
      assert.deepEqual(classifyOutcome(expect, 127, 127), {
        status: "skip",
        candidate: false,
      });
      assert.deepEqual(classifyOutcome(expect, null, 0), {
        status: "skip",
        candidate: false,
      });
    }
  });

  it("works/break-candidate:主机 ok + 围栏失败 = BREAK 且进候选(含 spawn 层 null)", () => {
    assert.deepEqual(classifyOutcome("works", 0, 1), {
      status: "BREAK",
      candidate: true,
    });
    assert.deepEqual(classifyOutcome("break-candidate", 0, 127), {
      status: "BREAK",
      candidate: true,
    });
    assert.deepEqual(classifyOutcome("works", 0, null), {
      status: "BREAK",
      candidate: true,
    });
  });

  it("works/break-candidate:主机 ok + 围栏 ok = ok 不进候选", () => {
    assert.deepEqual(classifyOutcome("works", 0, 0), {
      status: "ok",
      candidate: false,
    });
    assert.deepEqual(classifyOutcome("break-candidate", 0, 0), {
      status: "ok",
      candidate: false,
    });
  });

  it("hidden:围栏内不可见(非 0)= by-design,可见(0)= 围栏形态异常 BREAK", () => {
    // ~/.ssh 不可见是设计意图:ls 失败 = 按设计,不算断链。
    assert.deepEqual(classifyOutcome("hidden", 0, 2), {
      status: "by-design",
      candidate: false,
    });
    // 本应不可见却成功可见 = 假设围栏装配错了,如实标 BREAK 但不进读白名单候选。
    assert.deepEqual(classifyOutcome("hidden", 0, 0), {
      status: "BREAK",
      candidate: false,
    });
    assert.deepEqual(classifyOutcome("hidden", 0, null), {
      status: "BREAK",
      candidate: false,
    });
  });
});

describe("closed-world inventory 文本工具", () => {
  it("summarizeText 折叠空白并截断,空输入返空串", () => {
    assert.equal(summarizeText(undefined), "");
    assert.equal(summarizeText("   \n\t "), "");
    assert.equal(summarizeText("a\n  b\tc"), "a b c");
    assert.equal(summarizeText("x".repeat(200)), "x".repeat(200));
    const truncated = summarizeText("y".repeat(201));
    assert.equal(truncated.length, 201);
    assert.ok(truncated.endsWith("…"));
  });

  it("formatOutcomeLine 按票面格式输出,null 退出码显式呈现", () => {
    assert.equal(
      formatOutcomeLine(
        outcome({
          status: "BREAK",
          exitCode: 127,
          detail: "bash: node: command not found",
        })
      ),
      "[BREAK] s — cmd — exit 127 — bash: node: command not found"
    );
    assert.equal(
      formatOutcomeLine(outcome({ status: "ok", exitCode: null })),
      "[ok] s — cmd — exit null"
    );
  });

  it("summarizeBreakCandidates 空候选给出明示行,不输出空汇总", () => {
    assert.match(
      summarizeBreakCandidates([outcome({ status: "ok" })]),
      /无 BREAK 候选/
    );
  });

  it("summarizeBreakCandidates 按 group 分组,只含 BREAK 且 candidate 的条目", () => {
    const text = summarizeBreakCandidates([
      outcome({
        scenario: scenario({ name: "node 运行", group: "toolchain" }),
        status: "BREAK",
        exitCode: 127,
        candidate: true,
      }),
      outcome({
        scenario: scenario({ name: "skip 项", group: "toolchain" }),
        status: "skip",
      }),
      outcome({
        scenario: scenario({ name: "by-design 项", group: "security" }),
        status: "by-design",
      }),
      outcome({
        scenario: scenario({ name: "异常可见", group: "security" }),
        status: "BREAK",
        candidate: false,
      }),
      outcome({
        scenario: scenario({
          name: "git 全局 config 读取",
          group: "git-identity",
        }),
        status: "BREAK",
        exitCode: 1,
        candidate: true,
      }),
    ]);
    assert.match(text, /\[BREAK\] node 运行 — cmd — exit 127/);
    assert.match(text, /# toolchain/);
    assert.match(text, /# git-identity/);
    assert.match(text, /建议:/);
    assert.match(text, /共 2 条 BREAK 候选/);
    assert.doesNotMatch(text, /skip 项|by-design 项|异常可见/);
  });
});

describe("closed-world 假设围栏 argv", () => {
  const base = {
    cwd: "/home/u/proj",
    tmpDir: "/tmp",
    tmpSize: 1073741824,
    existingOptionalPrefixes: ["/opt"] as readonly string[],
  };

  it("没有 home bind、没有 SENSITIVE_PATHS 罩——闭世界前提由形态本身钉住", () => {
    const args = buildClosedWorldBaseArgs({ ...base, tmpSize: 1 << 30 });
    // 可写 --bind 只允许 cwd 与 tmp 垫底(home bind token 不存在);
    // 无 --tmpfs;没有 ~/.ssh / ~/.iknow / ~/.bashrc 等敏感路径罩。
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--bind") {
        assert.ok(
          args[i + 1] === base.cwd || args[i + 1] === base.tmpDir,
          `可写 bind 只许是 cwd 或 tmp 垫底,看到: ${args[i + 1]}`
        );
      }
      assert.notEqual(args[i], "--tmpfs", "per-invocation tmpfs is retired");
    }
  });

  it("系统 ro-bind + 可选前缀 + cwd 可写 + tmpfs/proc/dev,顺序对齐生产 baseArgs", () => {
    const args = buildClosedWorldBaseArgs(base);
    const expected = [
      "--unshare-user-try",
      "--unshare-net",
      "--die-with-parent",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/bin",
      "/bin",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--ro-bind",
      "/etc",
      "/etc",
      "--ro-bind",
      "/opt",
      "/opt",
      "--bind",
      base.tmpDir,
      base.tmpDir,
      "--bind",
      base.cwd,
      base.cwd,
      "--bind",
      base.tmpDir,
      "/tmp",
      "--proc",
      "/proc",
      "--dev-bind",
      "/dev",
      "/dev",
    ];
    assert.deepEqual(args, expected);
  });

  it("cwd 在 /tmp 下时按生产 isTmpDescendant 语义后置重绑;否则无重绑", () => {
    const under = buildClosedWorldBaseArgs({ ...base, cwd: "/tmp/ws-x" });
    const rebindIdx = under.lastIndexOf("--bind");
    assert.equal(under[rebindIdx + 1], "/tmp/ws-x");
    // 重绑必须在 `--bind <pad> /tmp` 之后(挂 /tmp 会遮蔽先挂的 bind)。
    const guestTmpIdx = under.findIndex(
      (a, i) => a === "--bind" && under[i + 2] === "/tmp"
    );
    assert.ok(rebindIdx > guestTmpIdx);
    // 桌面常规路径(不在 /tmp 下)不产生重绑(仅 tmp + cwd + pad@/tmp)。
    const outside = buildClosedWorldBaseArgs(base);
    assert.equal(outside.filter((a) => a === "--bind").length, 3);
  });

  it("完整 argv:bwrap 打头,--clearenv 先于全部 --setenv,命令段在 -- 之后", () => {
    const argv = buildClosedWorldArgv({
      ...base,
      env: { PATH: "/usr/bin", HOME: "/home/u", SKIP: undefined },
      command: "bash",
      args: ["-c", "node -v"],
    });
    assert.equal(argv[0], "bwrap");
    const clearenv = argv.indexOf("--clearenv");
    assert.ok(clearenv > 0);
    // #225 合同:--clearenv 必须先于全部 --setenv(否则宿主 env 整体漏进围栏)。
    const firstSetenv = argv.indexOf("--setenv");
    assert.ok(firstSetenv > clearenv, "--clearenv 必须先于全部 --setenv");
    const setenvs: string[] = [];
    // 每个 --setenv 占 3 个槽位(--setenv name value)。
    for (let i = firstSetenv; i < argv.length; i += 3) {
      if (argv[i] !== "--setenv") break;
      setenvs.push(argv[i + 1] as string);
    }
    assert.ok(setenvs.includes("PATH"));
    assert.ok(setenvs.includes("HOME"));
    assert.ok(!setenvs.includes("SKIP"), "undefined 值不注入");
    const sep = argv.indexOf("--");
    assert.deepEqual(argv.slice(sep + 1), ["bash", "-c", "node -v"]);
    assert.equal(argv[argv.indexOf("--chdir") + 1], base.cwd);
  });
});

describe("closed-world 场景清单", () => {
  const cwd = "/home/u/proj";
  const all = buildScenarios({
    cwd,
    rcFiles: ["~/.bashrc", "~/.profile"],
    pathDirs: ["/home/u/node/bin", "/usr/bin"],
  });

  it("票面点名的场景全部在场(命令逐字对齐)", () => {
    const commands = all.map((s) => s.command);
    for (const required of [
      "which node",
      "node -v",
      "npm -v",
      "npx --version",
      "git config --global --list",
      "git config --global user.name",
      `git -C ${cwd} var GIT_COMMITTER_IDENT`,
      "ls ~/.iknow",
      "cat ~/.iknow/init.sh",
      "ls ~/.claude",
      "bash -lc 'echo ok'",
      "ls ~/.ssh",
    ]) {
      assert.ok(commands.includes(required), `缺场景命令: ${required}`);
    }
    // 缓存场景以存在性探测形态在场(命令成功不代表目录可达,须 test -d)。
    assert.ok(
      commands.some((c) => c.includes("npm config get cache")),
      "缺 npm 缓存场景"
    );
    assert.ok(
      commands.some((c) => c.includes("pip3 cache dir")),
      "缺 pip 缓存场景"
    );
  });

  it("~/.ssh 是唯一 hidden 场景(设计意图,不进断链候选);其余均为 works/break-candidate", () => {
    const hidden = all.filter((s) => s.expect === "hidden");
    assert.deepEqual(
      hidden.map((s) => s.command),
      ["ls ~/.ssh"]
    );
    for (const s of all) {
      if (s.expect !== "hidden") {
        assert.ok(s.suggestion.length > 0, `${s.name} 缺读白名单建议`);
      }
    }
  });

  it("rc / PATH 场景按主机存在性条件装配,条件为空时缺席", () => {
    assert.ok(all.some((s) => s.command.includes("[ -r ~/.bashrc ]")));
    assert.ok(all.some((s) => s.command.includes("/home/u/node/bin")));
    const bare = buildScenarios({ cwd, rcFiles: [], pathDirs: [] });
    assert.ok(!bare.some((s) => s.name.includes("rc")));
    assert.ok(!bare.some((s) => s.name.includes("PATH")));
    assert.ok(bare.length > 0);
  });

  it("login shell rc / PATH 探测命令生成形态", () => {
    assert.equal(
      buildRcProbeCommand(["~/.bashrc", "~/.profile"]),
      "[ -r ~/.bashrc ] && [ -r ~/.profile ]"
    );
    const cmd = buildPathProbeCommand(["/a", "/b c"]);
    assert.equal(
      cmd,
      `missing=0; for d in "/a" "/b c"; do [ -d "$d" ] || { echo "missing:$d"; missing=1; }; done; exit $missing`
    );
  });
});
