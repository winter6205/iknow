/**
 * tests/tui/run-errors.test.ts — #343 T1 错误路径 E1/E2（bun:test）。
 *
 * 诱导方式：runTui 接受 createRenderer 工厂注入（测试专用注入口，生产路径
 * 缺省走 createCliRenderer）。
 *  - E1：工厂直接抛错（模拟 Zig 原生二进制缺失 / core 初始化失败）；
 *  - E2：工厂返回非法 renderer（createRoot/render 阶段失败）。
 * 两者都应收口到 run.tsx 单一 catch：stderr 类型化消息 + 返回退出码 1
 *（cli.ts 将其落为 process.exitCode）。
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import type { CliRenderer } from "@opentui/core";
import { runTui, TUI_RENDERER_ERROR_PREFIX } from "../../src/tui/run.js";

let stderrSpy: ReturnType<typeof spyOn<typeof process.stderr, "write">>;

function capturedStderr(): string {
  return stderrSpy.mock.calls.map((call) => String(call[0])).join("");
}

afterEach(() => {
  stderrSpy.mockRestore();
});

test("E1：渲染器工厂抛错 → 类型化 stderr + 退出码 1", async () => {
  stderrSpy = spyOn(process.stderr, "write");
  const code = await runTui({
    createRenderer: async () => {
      throw new Error("zig native binary load failure");
    },
  });
  expect(code).toBe(1);
  const out = capturedStderr();
  expect(out).toContain(TUI_RENDERER_ERROR_PREFIX);
  expect(out).toContain("zig native binary load failure");
  expect(out).toContain("npm ci");
});

test("E2：非法 renderer（构造成功但不可用）→ 类型化 stderr + 退出码 1", async () => {
  stderrSpy = spyOn(process.stderr, "write");
  const fake = { isDestroyed: false, destroy() {} } as unknown as CliRenderer;
  const code = await runTui({
    createRenderer: async () => fake,
  });
  expect(code).toBe(1);
  const out = capturedStderr();
  expect(out).toContain(TUI_RENDERER_ERROR_PREFIX);
  expect(out).toContain("npm ci");
});

test("无 TTY 且无注入工厂 → 类型化 stderr + 退出码 1（测试环境不挂起）", async () => {
  // bun test 非 TTY：runTui 入口 fail-fast 守卫拦截（不进 catch，不创建
  // 渲染器）。新版 OpenTUI 非 TTY 下能成功建 renderer，无守卫会挂死在
  // whenDestroyed —— 本用例同时保证 runTui 在无交互环境不挂起。
  stderrSpy = spyOn(process.stderr, "write");
  const code = await runTui({});
  expect(code).toBe(1);
  expect(capturedStderr()).toContain(TUI_RENDERER_ERROR_PREFIX);
});
