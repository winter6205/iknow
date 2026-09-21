/**
 * tests/tui/run-errors.test.ts — start-up error paths E1/E2 (bun:test).
 *
 * Injection point: runTui accepts a createRenderer factory override
 * (test-only seam; production defaults to createCliRenderer).
 *
 * After the OSC-residue incident there are two error classes, pinned apart:
 *  - **assembly-chain throw** (typed plain object: provider_api_key_missing /
 *    WorkspaceRootError): the renderer factory **must never be called** —
 *    once a renderer exists it probes the terminal (OSC 10/11 capability
 *    queries + alternate screen), and a later throw leaves capability replies
 *    stranded in the terminal (the incident's OSC-residue shape).
 *  - **renderer's own throw** (E1/E2): factory is called; catch still emits
 *    the prefix + exit code 1.
 *
 * Why E1/E2 run as a subprocess hermetic fixture: the assembly chain runs
 * before the factory and reads real settings / homedir / cwd. Changing
 * process.env.HOME in-process does not affect bun's `homedir()` (cached,
 * verified), and multiple runTui calls in one process cross-pollute env /
 * module singletons — results would depend on whether a provider key is
 * configured on the machine. A subprocess with temp HOME + temp cwd is fully
 * isolated, and all three scenarios (assembly passes + factory throws /
 * assembly passes + invalid renderer / assembly chain throws a typed error)
 * run in **one spawn**, so assertions are environment-independent (the
 * fixture fabricates its own settings to sidestep local env differences).
 *
 * Terminal teardown: teardownTuiTerminal is exercised with a fake renderer +
 * fake stdin recording the operation order (bun test has no real TTY; real
 * escape-sequence evidence comes from the aiterm PTY side). A structural
 * pin additionally confirms all three exit paths share one funnel — same
 * rationale as quit-shutdown.test.ts: the full runTui path needs a real TTY +
 * runtime bundle, not injectable under bun test.
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
  // subprocess-fixture cases install no spy: restore must tolerate undefined
  // (otherwise the first failing case gets masked into a second fail by afterEach TypeError).
  stderrSpy?.mockRestore();
  stderrSpy = undefined;
});

// ---------------------------------------------------------------------------
// assembly-order invariant: subprocess hermetic fixture (temp HOME / temp cwd)
// ---------------------------------------------------------------------------

interface ChildScenario {
  readonly code: number;
  readonly factoryCalled: boolean;
  /** every byte runTui wrote to stderr for this scenario (intercepted in the driver). */
  readonly stderr: string;
}

/**
 * Runs three scenarios inside a subprocess, reporting per-scenario exit code /
 * whether the factory was called / stderr:
 *  - `E1`: assembly passes, factory throws;
 *  - `E2`: assembly passes, factory returns an unusable renderer;
 *  - `ORDER`: provider key removed → assembly chain throws a typed plain object, factory must stay uncalled.
 * One spawn covers all three (~2s assembly each), avoiding triple subprocess cost.
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
    // register one provider: resolveLlmTransport checks apiKeyEnv only after
    // a table hit; removing the key yields a provider_api_key_missing thrown by the **real assembly chain**.
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
    // the driver intercepts process.stderr.write per scenario: runTui's stderr is mixed
    // with build-engine assembly warnings, so per-scenario assertions can't be satisfied by another scenario.
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

// E1: factory throws after assembly passes (simulates a missing Zig native binary).
await scenario("E1", async () => {
  throw new Error("zig native binary load failure");
});

// E2: factory returns an unusable renderer after assembly passes (throws at run time).
await scenario("E2", async () => ({ isDestroyed: false, destroy() {} }));

// ORDER: provider key removed → assembly chain throws provider_api_key_missing; factory must not be called.
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
      // exceeding the driver's own limit yields status=null, surfaced as an assertion failure rather than a test timeout.
      timeout: 100_000,
    });
    const scenarios: Record<string, ChildScenario> = {};
    // the driver's SCENARIO lines go to stderr (runTui writes stderr too); scan stdout as well
    // in case the driver reroutes later — neither stream has other lines matching this prefix.
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

  // E1: factory throws after assembly passes → typed stderr + exit code 1 (cause not lossy).
  expect(e1.code).toBe(1);
  expect(e1.factoryCalled).toBe(true);
  expect(e1.stderr).toContain(TUI_RENDERER_ERROR_PREFIX);
  expect(e1.stderr).toContain("zig native binary load failure");
  expect(e1.stderr).toContain("npm ci");

  // E2: invalid renderer (throws at run time) → same teardown path.
  expect(e2.code).toBe(1);
  expect(e2.factoryCalled).toBe(true);
  expect(e2.stderr).toContain(TUI_RENDERER_ERROR_PREFIX);
  expect(e2.stderr).toContain("npm ci");

  // assembly-order invariant (incident root cause): assembly chain throws → factory never called.
  // renderer never created = no OSC 10/11 capability queries sent / never entered alternate screen.
  expect(order.code).toBe(1);
  expect(order.factoryCalled).toBe(false);
  // error body not lossy: kind / env name visible, never the incident's `[object Object]`.
  expect(order.stderr).toContain(TUI_RENDERER_ERROR_PREFIX);
  expect(order.stderr).toContain("provider_api_key_missing");
  expect(order.stderr).toContain("T2_TEST_KEY");
  expect(order.stderr).not.toContain("[object Object]");
}, 120_000);

test("无 TTY 且无注入工厂 → 类型化 stderr + 退出码 1（测试环境不挂起）", async () => {
  // bun test is non-TTY: runTui's entry fail-fast guard intercepts (before any assembly and
  // renderer, not entering catch). New OpenTUI can build a renderer successfully under non-TTY, so without the guard
  // it would hang in whenDestroyed — this case also guarantees runTui does not hang in non-interactive environments.
  stderrSpy = spyOn(process.stderr, "write");
  const code = await runTui({});
  expect(code).toBe(1);
  expect(capturedStderr()).toContain(TUI_RENDERER_ERROR_PREFIX);
});

// ---------------------------------------------------------------------------
// typed-error rendering (pure function, discriminated-union priority = cli.ts printCliError)
// ---------------------------------------------------------------------------

test("T2：provider_api_key_missing → kind + provider + env 名，无 [object Object]", () => {
  const out = describeTuiStartError({
    kind: "provider_api_key_missing",
    providerId: "volcengine-ark",
    apiKeyEnv: "VOLCENGINE_ARK_API_KEY",
  });
  // the incident's literal text was `[object Object]`: kind / provider / env must not be dropped.
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
  // unknown-shape plain object: full JSON passthrough, no field dropped.
  expect(describeTuiStartError({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
  // circular reference: JSON.stringify throws → constructor-name fallback, still no [object Object].
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const rendered = describeTuiStartError(circular);
  expect(rendered).not.toContain("[object Object]");
  expect(rendered).toContain("Object");
  expect(describeTuiStartError("plain")).toBe("plain");
  expect(describeTuiStartError(undefined)).toBe("undefined");
});

// ---------------------------------------------------------------------------
// terminal teardown (fake renderer + fake stdin record the operation order)
// ---------------------------------------------------------------------------

/** fake renderer / stdin that records operation order; `log` is the contract sequence. */
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
  // disabling mouse comes **before** destroy (raw mode still on): OpenTUI #904 class — destroy
  // internally restores cooked mode first, then the native layer emits the mouse-disable sequence; in-flight mouse
  // reports in that window get echoed by the shell as `35;83;40M`-style garbage.
  // drain comes **after** destroy: by then stdin listeners are removed and the stream paused, reads don't
  // race the parser for data, and bytes arriving during the destroy window are still collected.
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
  // 2 reply chunks + trailing null = 3 reads: the loop keeps reading until null.
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
  // after destroy throws, the raw-mode fallback still runs (terminal must not stay in raw).
  expect(broken.log).toContain("raw=false");
  expect(broken.isRaw()).toBe(false);

  const mouseBroken = makeTerminalSpies({ mouseThrows: true });
  expect(() =>
    teardownTuiTerminal(mouseBroken.renderer, mouseBroken.stdin)
  ).not.toThrow();
  // a failing mouse-disable does not short-circuit: destroy and the raw fallback still run.
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
  // terminal never probed → no mouse/destroy calls, and no overreaching consumption of the caller's stdin.
  expect(log).toEqual([]);
});

// ---------------------------------------------------------------------------
// structural pin — all three exit paths share one teardown funnel
// ---------------------------------------------------------------------------

const runSrc = readFileSync(
  join(import.meta.dirname, "..", "..", "src", "tui", "run.tsx"),
  "utf8"
);

test("T6：catch / /quit / 正常退出三路都经唯一 teardownTerminal 闭包", () => {
  // single closure definition (late-bound renderer: the closure is created before the factory call and reads `let renderer`).
  expect(runSrc).toContain(
    "const teardownTerminal = (): void => teardownTuiTerminal(renderer);"
  );
  // three exit paths call it once each: onQuitBridge.destroy / after whenDestroyed / catch tail.
  expect(runSrc.match(/teardownTerminal\(\);/g)?.length).toBe(3);
});

test("T2：渲染器工厂调用点在装配链之后（prepareRuntime 之前不得出现）", () => {
  const prepareIdx = runSrc.indexOf("await prepareRuntime()");
  const factoryIdx = runSrc.indexOf(
    "renderer = await factory(RENDERER_CONFIG);"
  );
  expect(prepareIdx).toBeGreaterThan(-1);
  expect(factoryIdx).toBeGreaterThan(prepareIdx);
  // non-TTY fail-fast still first (before any assembly and renderer).
  expect(runSrc.indexOf("!process.stdin.isTTY")).toBeLessThan(prepareIdx);
});

// ---------------------------------------------------------------------------
// structural pin — stderr gate 生命周期接线（输入框漏字修复）
// ---------------------------------------------------------------------------

test("T7：stderr gate begin 落在 renderer 创建之后、mountApp 之前", () => {
  const factoryIdx = runSrc.indexOf(
    "renderer = await factory(RENDERER_CONFIG);"
  );
  const beginIdx = runSrc.indexOf("beginStderrGate();");
  const mountIdx = runSrc.indexOf("mountApp();");
  expect(factoryIdx).toBeGreaterThan(-1);
  // alt-screen 自 factory 起生效：门必须在此之后立刻武装，且在首帧挂载前
  expect(beginIdx).toBeGreaterThan(factoryIdx);
  expect(mountIdx).toBeGreaterThan(beginIdx);
});

test("T7：两条 runTui 退出口都 endStderrGate，且都在 teardownTerminal 之后", () => {
  expect(runSrc.match(/endStderrGate\(\);/g)?.length).toBe(2);
  // 正常路径：whenDestroyed → teardownTerminal → end（回放落主屏）
  const whenIdx = runSrc.indexOf("await whenDestroyed(renderer);");
  const normalEnd = runSrc.indexOf(
    "endStderrGate();",
    runSrc.indexOf("teardownTerminal();", whenIdx)
  );
  expect(normalEnd).toBeGreaterThan(whenIdx);
  // catch 路径：end 在 teardownTerminal 之后、shutdownExtensions 之前
  const catchTeardown = runSrc.lastIndexOf("teardownTerminal();");
  const catchEnd = runSrc.indexOf("endStderrGate();", catchTeardown);
  expect(catchEnd).toBeGreaterThan(catchTeardown);
  expect(
    runSrc.indexOf("await shutdownExtensions();", catchEnd)
  ).toBeGreaterThan(catchEnd);
});
