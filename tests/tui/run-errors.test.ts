/**
 * tests/tui/run-errors.test.ts — #343 T1 错误路径 E1/E2（bun:test）+ T2/T6。
 *
 * 诱导方式：runTui 接受 createRenderer 工厂注入（测试专用注入口，生产路径
 * 缺省走 createCliRenderer）。
 *
 * T2（2026-09-14 事故）后错误分成两类，本文件分别钉住：
 *  - **装配链抛错**（typed plain object：provider_api_key_missing /
 *    WorkspaceRootError）：渲染器工厂**必须未被调用** —— 渲染器一旦创建就
 *    会探测终端（OSC 10/11 能力查询 + alternate screen），抛错后终端残留
 *    能力应答（事故的 OSC 残留形态）。
 *  - **渲染器自身抛错**（E1/E2）：工厂被调用；catch 仍出前缀 + 退出码 1。
 *
 * 为什么 E1/E2 走子进程 hermetic fixture：T2 重排后装配链在工厂之前跑，
 * 而装配链读真实 settings / homedir / cwd。in-process 改 process.env.HOME
 * 对 bun 的 `homedir()` 无效（bun 缓存，实测），且同进程多次 runTui 会互相
 * 污染 env / 模块单例 —— 结果依机器上是否配好 provider key 而变。子进程用
 * temp HOME + temp cwd 完全隔离，三个场景（装配通过 + 工厂抛错 / 装配通过 +
 * 非法 renderer / 装配链抛 typed 错）在**同一次 spawn** 里跑完，断言因此
 * 与环境无关（本机已实测：装配链在本 worktree 会抛 provider_api_key_missing，
 * 子进程 fixture 用自造 settings 绕开该环境差异）。
 *
 * T6 终端收口：teardownTuiTerminal 取 fake renderer + fake stdin 记操作序
 * （bun test 无真实 TTY，真实转义序列证据由 aiterm PTY 侧提供）；另加结构
 * 钉子确认三条退出路径共用同一 funnel —— 结构性钉子的理由同
 * quit-shutdown.test.ts：runTui 全路径需真实 TTY + runtime bundle，bun test
 * 环境不可注入。
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import type { CliRenderer } from "@opentui/core";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeTuiStartError,
  runTui,
  teardownTuiTerminal,
  TUI_RENDERER_ERROR_PREFIX,
  type TuiTerminalStdin,
} from "../../src/tui/run.js";

let stderrSpy:
  ReturnType<typeof spyOn<typeof process.stderr, "write">> | undefined;

function capturedStderr(): string {
  return (stderrSpy?.mock.calls ?? [])
    .map((call: unknown[]) => String(call[0]))
    .join("");
}

afterEach(() => {
  // 子进程 fixture 用例不装 spy：restore 需容忍 undefined（否则首个失败
  // 用例会被 afterEach 的 TypeError 掩盖成第二个 fail）。
  stderrSpy?.mockRestore();
  stderrSpy = undefined;
});

// ---------------------------------------------------------------------------
// E1/E2 + T2 顺序不变式：子进程 hermetic fixture（temp HOME / temp cwd）
// ---------------------------------------------------------------------------

interface ChildScenario {
  readonly code: number;
  readonly factoryCalled: boolean;
  /** 该场景 runTui 写给 stderr 的全部字节（driver 内拦截）。 */
  readonly stderr: string;
}

/**
 * 子进程内跑三个场景并回报每个场景的退出码 / 工厂是否被调用 / stderr：
 *  - `E1`：装配通过，工厂抛错；
 *  - `E2`：装配通过，工厂返回不可用 renderer；
 *  - `ORDER`：撤掉 provider key → 装配链抛 typed plain object，工厂必须未调用。
 * 一次 spawn 跑完（每场景 ~2s 装配），避免三份子进程开销。
 */
function spawnTuiChild(): {
  status: number | null;
  scenarios: Record<string, ChildScenario>;
} {
  const root = mkdtempSync(join(tmpdir(), "iknow-tui-run-errors-"));
  try {
    const home = join(root, "home");
    const work = join(root, "work");
    mkdirSync(join(home, ".iknow"), { recursive: true });
    mkdirSync(work, { recursive: true });
    // provider 注册一条：装配期 resolveLlmTransport 查表命中后才校验
    // apiKeyEnv；撤掉 key 即得一条**真实装配链**抛出的 provider_api_key_missing。
    writeFileSync(
      join(home, ".iknow", "settings.json"),
      JSON.stringify({
        llm: {
          model: "testp/testm",
          providers: [
            {
              id: "testp",
              baseUrl: "http://127.0.0.1:1",
              apiKeyEnv: "T2_TEST_KEY",
              models: [{ id: "testm" }],
            },
          ],
        },
      })
    );
    const runTuiPath = join(
      import.meta.dirname,
      "..",
      "..",
      "src",
      "tui",
      "run.tsx"
    );
    const driverPath = join(root, "driver.ts");
    // driver 拦截 process.stderr.write 逐场景记账：runTui 的 stderr 与
    // build-engine 的装配告警混在一起，分场景断言才不被别的场景满足。
    writeFileSync(
      driverPath,
      `import { runTui } from ${JSON.stringify(runTuiPath)};

const realWrite = process.stderr.write.bind(process.stderr);

async function scenario(label, factory) {
  let captured = "";
  process.stderr.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  let code = -1;
  let factoryCalled = false;
  try {
    code = await runTui({
      createRenderer: (...args) => {
        factoryCalled = true;
        return factory(...args);
      },
    });
  } finally {
    process.stderr.write = realWrite;
  }
  realWrite(
    "SCENARIO " + label + " code=" + code + " factoryCalled=" + factoryCalled +
      " stderr=" + JSON.stringify(captured) + "\\n"
  );
}

// E1：装配通过后工厂抛错（模拟 Zig 原生二进制缺失）。
await scenario("E1", async () => {
  throw new Error("zig native binary load failure");
});

// E2：装配通过后工厂返回不可用 renderer（run 阶段抛）。
await scenario("E2", async () => ({ isDestroyed: false, destroy() {} }));

// ORDER：撤掉 provider key → 装配链抛 provider_api_key_missing，工厂不得被调用。
delete process.env.T2_TEST_KEY;
await scenario("ORDER", async () => ({ isDestroyed: false, destroy() {} }));

process.exit(0);
`
    );
    const res = spawnSync(process.execPath, [driverPath], {
      cwd: work,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        T2_TEST_KEY: "sk-test-sentinel",
      },
      encoding: "utf8",
      // 超过 driver 自身时限会得到 status=null，以断言形式暴露而非测试超时。
      timeout: 100_000,
    });
    const scenarios: Record<string, ChildScenario> = {};
    // driver 的 SCENARIO 行走 stderr（runTui 自身也写 stderr），stdout 一起扫
    // 以防将来 driver 改道；两路都不会有别的行匹配该前缀。
    for (const line of `${res.stdout ?? ""}\n${res.stderr ?? ""}`.split("\n")) {
      const match =
        /^SCENARIO (\w+) code=(-?\d+) factoryCalled=(\w+) stderr=(.*)$/.exec(
          line.trim()
        );
      if (!match) continue;
      scenarios[match[1]] = {
        code: Number(match[2]),
        factoryCalled: match[3] === "true",
        stderr: JSON.parse(match[4]) as string,
      };
    }
    return { status: res.status, scenarios };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("E1/E2 + T2：装配链抛 typed 错时工厂未被调用；装配通过后工厂抛错仍出前缀 + 退出码 1", () => {
  const { status, scenarios } = spawnTuiChild();
  expect(status).toBe(0);
  const e1 = scenarios.E1;
  const e2 = scenarios.E2;
  const order = scenarios.ORDER;
  expect(e1).toBeDefined();
  expect(e2).toBeDefined();
  expect(order).toBeDefined();

  // E1：装配通过后被工厂抛错 → 类型化 stderr + 退出码 1（cause 非有损）。
  expect(e1.code).toBe(1);
  expect(e1.factoryCalled).toBe(true);
  expect(e1.stderr).toContain(TUI_RENDERER_ERROR_PREFIX);
  expect(e1.stderr).toContain("zig native binary load failure");
  expect(e1.stderr).toContain("npm ci");

  // E2：非法 renderer（run 阶段抛）→ 同款收口。
  expect(e2.code).toBe(1);
  expect(e2.factoryCalled).toBe(true);
  expect(e2.stderr).toContain(TUI_RENDERER_ERROR_PREFIX);
  expect(e2.stderr).toContain("npm ci");

  // T2 顺序不变式（事故根因）：装配链抛错 → 工厂一次都没被调用。
  // renderer 从未创建 = 从未发出 OSC 10/11 能力查询 / 从未进 alternate screen。
  expect(order.code).toBe(1);
  expect(order.factoryCalled).toBe(false);
  // 错误体非有损：kind / env 名可见，绝不是事故原文的 [object Object]。
  expect(order.stderr).toContain(TUI_RENDERER_ERROR_PREFIX);
  expect(order.stderr).toContain("provider_api_key_missing");
  expect(order.stderr).toContain("T2_TEST_KEY");
  expect(order.stderr).not.toContain("[object Object]");
}, 120_000);

test("无 TTY 且无注入工厂 → 类型化 stderr + 退出码 1（测试环境不挂起）", async () => {
  // bun test 非 TTY：runTui 入口 fail-fast 守卫拦截（在任何装配与渲染器之前，
  // 不进 catch）。新版 OpenTUI 非 TTY 下能成功建 renderer，无守卫会挂死在
  // whenDestroyed —— 本用例同时保证 runTui 在无交互环境不挂起。
  stderrSpy = spyOn(process.stderr, "write");
  const code = await runTui({});
  expect(code).toBe(1);
  expect(capturedStderr()).toContain(TUI_RENDERER_ERROR_PREFIX);
});

// ---------------------------------------------------------------------------
// T2：typed-error 错误体渲染（纯函数，判别联合优先级 = cli.ts printCliError）
// ---------------------------------------------------------------------------

test("T2：provider_api_key_missing → kind + provider + env 名，无 [object Object]", () => {
  const out = describeTuiStartError({
    kind: "provider_api_key_missing",
    providerId: "volcengine-ark",
    apiKeyEnv: "VOLCENGINE_ARK_API_KEY",
  });
  // 事故原文就是 `[object Object]`：kind / provider / env 一个都不能丢。
  expect(out).toContain("provider_api_key_missing");
  expect(out).toContain("volcengine-ark");
  expect(out).toContain("VOLCENGINE_ARK_API_KEY");
  expect(out).not.toContain("[object Object]");
});

test("T2：provider_model_not_registered → kind + model，无 [object Object]", () => {
  const out = describeTuiStartError({
    kind: "provider_model_not_registered",
    model: "ghost/model",
  });
  expect(out).toContain("provider_model_not_registered");
  expect(out).toContain("ghost/model");
  expect(out).not.toContain("[object Object]");
});

test("T2：WorkspaceRootError → 走 workspace-root 渲染（非 Error 分支）", () => {
  const out = describeTuiStartError({ kind: "not_found", path: "/nope" });
  expect(out).toContain("workspace_root");
  expect(out).toContain("/nope");
  expect(out).not.toContain("[object Object]");
});

test("T2：Error / 普通对象 / 循环对象 / 原始值 一律非有损", () => {
  expect(describeTuiStartError(new Error("boom"))).toBe("boom");
  // 未知形状的 plain object：JSON 全量透出，不丢字段。
  expect(describeTuiStartError({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
  // 循环引用：JSON.stringify 抛错 → 构造器名兜底，仍不产生 [object Object]。
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const rendered = describeTuiStartError(circular);
  expect(rendered).not.toContain("[object Object]");
  expect(rendered).toContain("Object");
  expect(describeTuiStartError("plain")).toBe("plain");
  expect(describeTuiStartError(undefined)).toBe("undefined");
});

// ---------------------------------------------------------------------------
// T6：终端收口（fake renderer + fake stdin 记操作序）
// ---------------------------------------------------------------------------

/** 记录操作顺序的 fake renderer / stdin；`log` 即契约顺序。 */
function makeTerminalSpies(opts?: {
  rendererDestroyed?: boolean;
  destroyThrows?: boolean;
  mouseThrows?: boolean;
  chunks?: Array<string | null>;
}) {
  const log: string[] = [];
  let destroyed = opts?.rendererDestroyed ?? false;
  let raw = true;
  const chunks = [...(opts?.chunks ?? [])];
  const renderer = {
    get isDestroyed() {
      return destroyed;
    },
    set useMouse(value: boolean) {
      log.push(`mouse=${value}`);
      if (opts?.mouseThrows) throw new Error("renderer loop is gone");
    },
    destroy() {
      log.push("destroy");
      if (opts?.destroyThrows) throw new Error("destroy failed");
      destroyed = true;
    },
  } as unknown as CliRenderer;
  const stdin: TuiTerminalStdin = {
    get isRaw() {
      return raw;
    },
    read: () => {
      log.push("read");
      return chunks.length > 0 ? chunks.shift() : null;
    },
    setRawMode(mode: boolean) {
      log.push(`raw=${mode}`);
      raw = mode;
      return stdin;
    },
  };
  return { log, renderer, stdin, isRaw: () => raw };
}

test("T6：收口顺序 = 关鼠标 → destroy → drain 能力应答 → raw 兜底", () => {
  const { log, renderer, stdin } = makeTerminalSpies({
    chunks: ["\x1b]10;rgb:aaaa/bbbb/cccc\x1b\\", "\x1b[?2026$y"],
  });
  teardownTuiTerminal(renderer, stdin);
  // 关鼠标在 destroy **之前**（raw mode 仍开）：OpenTUI #904 类 —— destroy
  // 内部先恢复 cooked mode，之后原生层才发鼠标关闭序列，中间窗口的在途
  // 鼠标报告会被 shell 回显成 `35;83;40M` 类垃圾。
  // drain 在 destroy **之后**：此时 stdin 监听已摘除、流已 pause，读取不
  // 与解析器抢数据，且能收下 destroy 窗口期到达的字节。
  expect(log).toEqual([
    "mouse=false",
    "destroy",
    "read",
    "read",
    "read",
    "raw=false",
  ]);
});

test("T6：能力应答被丢弃、不残留（OSC 10/11 rgb + DECRQM $y）", () => {
  const renderer = {
    isDestroyed: false,
    destroy() {},
  } as unknown as CliRenderer;
  const chunks: Array<string | null> = [
    "\x1b]10;rgb:1111/2222/3333\x1b\\",
    "\x1b[?2026$y",
  ];
  const seen: unknown[] = [];
  teardownTuiTerminal(renderer, {
    get isRaw() {
      return false;
    },
    read: () => {
      const next = chunks.length > 0 ? chunks.shift() : null;
      seen.push(next ?? null);
      return next;
    },
  });
  // 2 块应答 + 末尾 null = 3 次 read，说明循环一直读到 null 才停。
  expect(seen).toEqual([
    "\x1b]10;rgb:1111/2222/3333\x1b\\",
    "\x1b[?2026$y",
    null,
  ]);
});

test("T6：已 destroy 的 renderer 不重复 release native（/quit 与 whenDestroyed 二次进入）", () => {
  const { log, renderer, stdin } = makeTerminalSpies({
    rendererDestroyed: true,
  });
  teardownTuiTerminal(renderer, stdin);
  expect(log).toEqual(["read", "raw=false"]);
  expect(log).not.toContain("mouse=false");
  expect(log).not.toContain("destroy");
});

test("T6：destroy / 关鼠标抛错不上抛，raw mode 仍被兜底恢复", () => {
  const broken = makeTerminalSpies({ destroyThrows: true });
  expect(() =>
    teardownTuiTerminal(broken.renderer, broken.stdin)
  ).not.toThrow();
  // destroy 抛错后 raw 兜底仍执行（终端不能留在 raw）。
  expect(broken.log).toContain("raw=false");
  expect(broken.isRaw()).toBe(false);

  const mouseBroken = makeTerminalSpies({ mouseThrows: true });
  expect(() =>
    teardownTuiTerminal(mouseBroken.renderer, mouseBroken.stdin)
  ).not.toThrow();
  // 关鼠标失败不短路后续：destroy 与 raw 兜底照跑。
  expect(mouseBroken.log).toContain("destroy");
  expect(mouseBroken.log).toContain("raw=false");
});

test("T6：read() 抛错（流已 close）不短路收口", () => {
  const renderer = {
    isDestroyed: false,
    destroy() {},
  } as unknown as CliRenderer;
  const log: string[] = [];
  const stdin: TuiTerminalStdin = {
    get isRaw() {
      return true;
    },
    read: () => {
      log.push("read");
      throw new Error("stream closed");
    },
    setRawMode: (mode: boolean) => {
      log.push(`raw=${mode}`);
      return stdin;
    },
  };
  expect(() => teardownTuiTerminal(renderer, stdin)).not.toThrow();
  expect(log).toEqual(["read", "raw=false"]);
});

test("T6：renderer 未创建（T2 顺序不变式下的装配失败）→ 收口为 no-op", () => {
  const { log, stdin } = makeTerminalSpies({ chunks: ["\x1b]10;rgb:x\x1b\\"] });
  teardownTuiTerminal(undefined, stdin);
  // 从未探测终端 → 既无 mouse/destroy，也不越权消费调用方 stdin。
  expect(log).toEqual([]);
});

// ---------------------------------------------------------------------------
// T6 / T2：结构性钉子 —— 三条退出路径共用一个收口 funnel
// ---------------------------------------------------------------------------

const runSrc = readFileSync(
  join(import.meta.dirname, "..", "..", "src", "tui", "run.tsx"),
  "utf8"
);

test("T6：catch / /quit / 正常退出三路都经唯一 teardownTerminal 闭包", () => {
  // 唯一闭包定义（renderer 晚绑定：闭包在工厂调用前创建，读的是 `let renderer`）。
  expect(runSrc).toContain(
    "const teardownTerminal = (): void => teardownTuiTerminal(renderer);"
  );
  // 三条退出路径各调一次：onQuitBridge.destroy / whenDestroyed 之后 / catch 尾部。
  expect(runSrc.match(/teardownTerminal\(\);/g)?.length).toBe(3);
});

test("T2：渲染器工厂调用点在装配链之后（prepareRuntime 之前不得出现）", () => {
  const prepareIdx = runSrc.indexOf("await prepareRuntime()");
  const factoryIdx = runSrc.indexOf(
    "renderer = await factory(RENDERER_CONFIG);"
  );
  expect(prepareIdx).toBeGreaterThan(-1);
  expect(factoryIdx).toBeGreaterThan(prepareIdx);
  // 非 TTY fail-fast 仍在最前（任何装配与渲染器之前）。
  expect(runSrc.indexOf("!process.stdin.isTTY")).toBeLessThan(prepareIdx);
});
