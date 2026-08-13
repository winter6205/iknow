/**
 * T1: settings-watch 纯函数模块 —— 文件级事件 → 节流回调。
 *
 * 覆盖（plans/settings-hot-reload.md T1 验收，≥8 用例）：
 *  1. touch 现有 settings.json → onChange 触发，含 path + reason。
 *  2. 创建 settings.json（首次）→ onChange 触发。
 *  3. 100ms 内多次连续 write → onChange 只触发一次。
 *  4. stop() 后 write → 不触发。
 *  5. 两个文件都监听：user 改 → user path；project 改 → project path。
 *  6. onChange 回调内 throw → 不阻断后续事件。
 *  7. 文件 / 目录不存在 → 不抛错（启动期语义）。
 *  8. 停后重复 stop() 幂等（不抛错）。
 *
 * 纪律：
 *  - mkdtempSync + 测试结束显式 stop() + rmSync（计划风险清单）；
 *  - 超时放宽到 3000ms（fs.watch 在 WSL / CI 偶发慢）；
 *  - 框架用 vitest（与 tests/config 既有测试一致；pre-commit 的 vitest run
 *    --changed 会收集本文件，不能引入 bun:test）。bun test 亦可跑（兼容）。
 *  - home / cwd 都指向 tmp 隔离目录，绝不碰真实 ~/.iknow。
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEBOUNCE_MS,
  watchSettings,
  type SettingsChangeEvent,
} from "../../src/config/settings-watch.ts";

/** 每用例超时（fs.watch WSL/CI 偶发慢；vitest / bun 第三参同形）。 */
const TEST_TIMEOUT_MS = 3000;
/**
 * 等待 watcher 事件送达的稳定窗口。必须 ≥ 750ms（reviewer minor）：主通道
 * fs.watch 偶发慢时需靠 watchFile 轮询（interval=500ms）冗余兜底，窗口小于
 * 轮询间隔会让双通道冗余失效。
 */
const SETTLE_MS = DEBOUNCE_MS + 750;

/** 构造隔离的 tmp 目录对：return { base, cwd, home, userFile, projectFile }。 */
function makeDirs(): {
  base: string;
  cwd: string;
  home: string;
  userFile: string;
  projectFile: string;
} {
  const base = mkdtempSync(join(tmpdir(), "iknow-settings-watch-"));
  const home = join(base, "home");
  const cwd = join(base, "cwd");
  mkdirSync(join(home, ".iknow"), { recursive: true });
  mkdirSync(join(cwd, ".iknow"), { recursive: true });
  return {
    base,
    cwd,
    home,
    userFile: join(home, ".iknow", "settings.json"),
    projectFile: join(cwd, ".iknow", "settings.json"),
  };
}

/** 等待 watcher 触发：poll `events.length` 达到目标长度。 */
async function waitForEvents(
  events: SettingsChangeEvent[],
  count: number,
  timeoutMs: number = SETTLE_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (events.length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `timeout waiting for ${count} events, got ${events.length}`
      );
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** 静默窗口：确认在窗口内没有任何新事件。 */
async function assertQuiet(
  events: SettingsChangeEvent[],
  count: number
): Promise<void> {
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  expect(events.length).toBe(count);
}

describe("watchSettings", () => {
  test(
    "touch 现有 settings.json → onChange 触发，含 path + reason",
    async () => {
      const { base, cwd, home, projectFile } = makeDirs();
      // 先建文件（watcher 注册前已存在 → 无启动回显）。
      writeFileSync(projectFile, JSON.stringify({ llm: { model: "m1" } }));
      const events: SettingsChangeEvent[] = [];
      const w = watchSettings({
        cwd,
        home,
        onChange: (e) => events.push(e),
      });
      try {
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "m2" } }));
        await waitForEvents(events, 1);
        expect(events[0]!.path).toBe(projectFile);
        expect(events[0]!.reason).toBe("change");
      } finally {
        w.stop();
        rmSync(base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "创建 settings.json（首次）→ onChange 触发",
    async () => {
      const { base, cwd, home, projectFile } = makeDirs();
      rmSync(projectFile, { force: true });
      const events: SettingsChangeEvent[] = [];
      const w = watchSettings({
        cwd,
        home,
        onChange: (e) => events.push(e),
      });
      try {
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "m1" } }));
        await waitForEvents(events, 1);
        expect(events[0]!.path).toBe(projectFile);
        // reviewer minor:锁定首次创建 → reason === "rename" 契约（dir fs.watch
        // 对 create 发 rename；watchFile 从「不存在→存在」跃迁也是 rename）。
        expect(events[0]!.reason).toBe("rename");
      } finally {
        w.stop();
        rmSync(base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "100ms 内多次连续 write → onChange 只触发一次",
    async () => {
      const { base, cwd, home, projectFile } = makeDirs();
      writeFileSync(projectFile, JSON.stringify({ llm: { model: "m0" } }));
      const events: SettingsChangeEvent[] = [];
      const w = watchSettings({
        cwd,
        home,
        onChange: (e) => events.push(e),
      });
      try {
        // 等 watcher 就绪，避免「注册前写」漏触发。
        await new Promise((r) => setTimeout(r, 80));
        for (let i = 1; i <= 5; i++) {
          writeFileSync(
            projectFile,
            JSON.stringify({ llm: { model: `m${i}` } })
          );
        }
        await waitForEvents(events, 1);
        // 窗口后仍保持 1 条（无重复上报）。
        await assertQuiet(events, 1);
      } finally {
        w.stop();
        rmSync(base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "debounce 边界：相隔 >100ms 的两次 write → 触发两次",
    async () => {
      const { base, cwd, home, projectFile } = makeDirs();
      writeFileSync(projectFile, JSON.stringify({ llm: { model: "m0" } }));
      const events: SettingsChangeEvent[] = [];
      const w = watchSettings({
        cwd,
        home,
        onChange: (e) => events.push(e),
      });
      try {
        await new Promise((r) => setTimeout(r, 80));
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "m1" } }));
        await waitForEvents(events, 1);
        // 跨过 debounce 窗口后再写 → 应作为独立事件上报。
        await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200));
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "m2" } }));
        await waitForEvents(events, 2);
        expect(events[1]!.path).toBe(projectFile);
      } finally {
        w.stop();
        rmSync(base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "stop() 后 write → 不触发",
    async () => {
      const { base, cwd, home, projectFile } = makeDirs();
      writeFileSync(projectFile, JSON.stringify({ llm: { model: "m1" } }));
      const events: SettingsChangeEvent[] = [];
      const w = watchSettings({
        cwd,
        home,
        onChange: (e) => events.push(e),
      });
      try {
        await new Promise((r) => setTimeout(r, 80));
        w.stop();
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "m2" } }));
        await assertQuiet(events, 0);
      } finally {
        w.stop(); // 幂等（第二次 stop 不抛错）
        rmSync(base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "两个文件都监听：user 改 → user 路径；project 改 → project 路径",
    async () => {
      const { base, cwd, home, userFile, projectFile } = makeDirs();
      writeFileSync(userFile, JSON.stringify({ llm: { model: "u0" } }));
      writeFileSync(projectFile, JSON.stringify({ llm: { model: "p0" } }));
      const events: SettingsChangeEvent[] = [];
      const w = watchSettings({
        cwd,
        home,
        onChange: (e) => events.push(e),
      });
      try {
        await new Promise((r) => setTimeout(r, 80));
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "p1" } }));
        await waitForEvents(events, 1);
        expect(events[0]!.path).toBe(projectFile);

        writeFileSync(userFile, JSON.stringify({ llm: { model: "u1" } }));
        await waitForEvents(events, 2);
        expect(events[1]!.path).toBe(userFile);
      } finally {
        w.stop();
        rmSync(base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "onChange 回调内 throw → 不阻断后续事件",
    async () => {
      const { base, cwd, home, projectFile } = makeDirs();
      writeFileSync(projectFile, JSON.stringify({ llm: { model: "m1" } }));
      const events: SettingsChangeEvent[] = [];
      let callCount = 0;
      const w = watchSettings({
        cwd,
        home,
        onChange: (e) => {
          callCount++;
          events.push(e);
          if (callCount === 1) throw new Error("boom from callback");
        },
      });
      try {
        await new Promise((r) => setTimeout(r, 80));
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "m2" } }));
        await waitForEvents(events, 1);
        // 第一次回调抛错后，后续写入仍能触发（不阻断）。
        await new Promise((r) => setTimeout(r, 150));
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "m3" } }));
        await waitForEvents(events, 2);
        expect(callCount).toBe(2);
      } finally {
        w.stop();
        rmSync(base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "文件 / 目录不存在 → 不抛错（启动期常见）",
    async () => {
      const { base, home } = makeDirs();
      // 全新 home / cwd：.iknow 目录都不存在。
      const emptyHome = join(base, "empty-home");
      const emptyCwd = join(base, "empty-cwd");
      const events: SettingsChangeEvent[] = [];
      const w = watchSettings({
        cwd: emptyCwd,
        home: emptyHome,
        onChange: (e) => events.push(e),
      });
      // 构造本身不抛错（启动期语义）：
      expect(typeof w.stop).toBe("function");
      w.stop();
      rmSync(base, { recursive: true, force: true });
      void home;
    },
    TEST_TIMEOUT_MS
  );
});
