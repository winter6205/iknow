/**
 * scripts/tui-binding-probe.ts — #365 P0 TUI binding 自检探针。
 *
 * 背景：@opentui/core 的 platform 子包（@opentui/core-linux-x64 / -musl 等）
 * 是 optionalDependencies；首次 npm install 若未显式 `--include=optional`，
 * 子包不入 node_modules，TUI 启动即崩（"OpenTUI native FFI is not available"）。
 *
 * 本探针 6 类检查，全部走真实 CliRenderer 构造/销毁路径，不污染终端：
 *   - stdin/stdout 用 in-memory PassThrough/Writable（不碰 process.stdin/out），
 *   - bufferedOutput: "memory"（渲染字节不出 terminal），
 *   - consoleMode: "disabled"（避免 console 被 OpenTUI overlay 劫持），
 *   - try/finally destroy 收口。
 *
 * 运行环境：**bun**（TUI 测试与产品 TTY 入口都在 bun 上；node 无 node:ffi，
 * FFI 层必 FAIL，见测试规范 tests/tui/）。故 package.json 的 probe:tui-binding
 * 脚本用 `$HOME/.bun/bin/bun run`，与 scripts.test 的 bun test 路径同源。
 *
 * 退出码：6 类全绿 → 0；任一红 → 1。
 *
 * 输出格式（#365 验收规格；对齐 sandbox-probe 的 ✓/✗ 表意）：
 *   [PASS] binding loadable          ← 导航空行（不计入 6 类）
 *   [PASS] renderer-construct        ← 第 1/6 类
 *   [FAIL] <class>: <reason>
 *   ...
 *   all green (6/6)
 */

import {
  createCliRenderer,
  TextRenderable,
  type CliRenderer,
  type CliRendererConfig,
} from "@opentui/core";
import { createMockKeys } from "@opentui/core/testing";
import { PassThrough, Writable } from "node:stream";

/** 每类探针返回 ok + detail（reason 会附到 FAIL 行）。 */
interface ProbeResult {
  ok: boolean;
  detail: string;
}

const WIDTH = 80;
const HEIGHT = 24;

/**
 * in-memory stdin/stdout：避免探针碰 process.stdin/out（不污染终端）。
 * PassThrough/Writable 结构上不满足 NodeJS.ReadStream/WriteStream 全签名，
 * 经 asCliStreams 断言补足（本探针只走 createCliRenderer 的 stdin/stdout
 * 消费者路径，无需真实 TTY 语义）。
 */
function asCliStreams(config: {
  stdin: PassThrough;
  stdout: Writable;
}): Pick<CliRendererConfig, "stdin" | "stdout"> {
  (config.stdin as PassThrough & { isTTY: boolean }).isTTY = true;
  (config.stdout as Writable & { isTTY: boolean }).isTTY = true;
  return {
    stdin: config.stdin as unknown as CliRendererConfig["stdin"],
    stdout: config.stdout as unknown as CliRendererConfig["stdout"],
  };
}

function makeConfig(exitOnCtrlC: boolean): CliRendererConfig {
  return {
    ...asCliStreams({
      stdin: new PassThrough(),
      stdout: new Writable({
        write(_chunk, _enc, cb) {
          cb();
        },
      }),
    }),
    width: WIDTH,
    height: HEIGHT,
    bufferedOutput: "memory",
    screenMode: "alternate-screen",
    exitOnCtrlC,
    consoleMode: "disabled",
    // Writable 非 TTY，需显式给 width/height（否则 terminalWidth 归 0）。
  };
}

/** 装配真实 CliRenderer；失败 = FFI/binding 缺失的最直接信号。 */
async function construct(): Promise<CliRenderer> {
  return createCliRenderer(makeConfig(false));
}

// 6 类探针（#365 plan 一致）。binding loadable 是导航空行，在循环前打印、
// 不计入 6 类——import 成功不等于 dlopen 可用（FFI 惰性加载），真正的 binding
// 验证落在 renderer-construct（FFIRenderLib 构造即 dlopen）。
const checks: ReadonlyArray<readonly [string, () => Promise<ProbeResult>]> = [
  [
    "renderer-construct",
    async (): Promise<ProbeResult> => {
      let r: CliRenderer | undefined;
      try {
        r = await construct();
        return {
          ok: r.width === WIDTH && r.height === HEIGHT,
          detail: `w=${r.width} h=${r.height}`,
        };
      } finally {
        if (r && !r.isDestroyed) r.destroy();
      }
    },
  ],
  [
    "renderer-destroy",
    async (): Promise<ProbeResult> => {
      let r: CliRenderer | undefined;
      try {
        r = await construct();
        r.destroy();
        return { ok: r.isDestroyed, detail: `isDestroyed=${r.isDestroyed}` };
      } finally {
        if (r && !r.isDestroyed) r.destroy();
      }
    },
  ],
  [
    "render-mount",
    async (): Promise<ProbeResult> => {
      let r: CliRenderer | undefined;
      try {
        r = await construct();
        // mount：root.add + requestRender + idle 收帧，验证原生渲染管线可用。
        r.root.add(new TextRenderable(r, { content: "tui-binding-probe" }));
        r.requestRender();
        await r.idle();
        return { ok: true, detail: "root.add + idle OK" };
      } finally {
        if (r && !r.isDestroyed) r.destroy();
      }
    },
  ],
  [
    "ctrl-c-path",
    async (): Promise<ProbeResult> => {
      let r: CliRenderer | undefined;
      try {
        r = await construct();
        // Ctrl+C 语义：exitOnCtrlC=false 下 keypress 事件（ctrl+c）必须派发到
        // keyInput——TUI 靠它打断前台 turn（#146 Q1a），binding 缺失时该路径不
        // 可达。pressCtrlC 走 renderer.stdin.emit("data", \x03) → 异步解析。
        const mock = createMockKeys(r);
        let sawCtrlC = false;
        r.keyInput.on("keypress", (ev) => {
          if (ev.ctrl && ev.name === "c") sawCtrlC = true;
        });
        mock.pressCtrlC();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { ok: sawCtrlC, detail: `sawCtrlC=${sawCtrlC}` };
      } finally {
        if (r && !r.isDestroyed) r.destroy();
      }
    },
  ],
  [
    "multi-line-render",
    async (): Promise<ProbeResult> => {
      let r: CliRenderer | undefined;
      try {
        r = await construct();
        // 多行渲染 = TextBuffer 分行 + 原生排版路径。
        const text = new TextRenderable(r, {
          content: "line one\nline two\nline three",
        });
        r.root.add(text);
        r.requestRender();
        await r.idle();
        return { ok: true, detail: "3-line TextRenderable OK" };
      } finally {
        if (r && !r.isDestroyed) r.destroy();
      }
    },
  ],
  [
    "alt-screen",
    async (): Promise<ProbeResult> => {
      let r: CliRenderer | undefined;
      try {
        r = await construct();
        // 全屏 alt-screen：构造时 screenMode 已生效，读回即验证（TUI 主入口
        // RENDERER_CONFIG 用 alternate-screen，scrollback 收口 #321 问题 1）。
        return {
          ok: r.screenMode === "alternate-screen",
          detail: `screenMode=${r.screenMode}`,
        };
      } finally {
        if (r && !r.isDestroyed) r.destroy();
      }
    },
  ],
];

let passed = 0;
const total = checks.length;
console.log("[PASS] binding loadable (import(@opentui/core) OK)");
for (const [name, check] of checks) {
  try {
    const result = await check();
    if (result.ok) passed++;
    console.log(
      `${result.ok ? "[PASS]" : "[FAIL]"} ${name}${result.detail ? `: ${result.detail}` : ""}`
    );
  } catch (error) {
    console.log(
      `[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
console.log(
  `\n${passed === total ? "all green" : "failures"} (${passed}/${total})`
);
process.exit(passed === total ? 0 : 1);
