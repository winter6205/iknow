/**
 * T2: EnvLoader 工厂 + 热更新集成。
 *
 * 覆盖（plans/settings-hot-reload.md T2 验收，≥6 用例）：
 *  1. get() 首次 lazy load；再次 get() 返回同一引用（缓存命中）。
 *  2. reload() 强制重读返回新引用。
 *  3. watch 触发后 subscriber 自动收到新 env。
 *  4. reload 抛错（坏 JSON）→ 缓存不变 + onError 注册收到错。
 *  5. stop() 后 watch 不再触发 + subscribe 的回调不被调用。
 *  6. createEnvLoader 多次实例化互不干扰。
 *
 * 纪律：
 *  - 隔离 home / cwd（tmp 目录注入），不碰真实 ~/.iknow；
 *  - 每个用例结束显式 stop() + rmSync（watcher 句柄 + tmp 清理）；
 *  - 测试框架 vitest（与 tests/config 既有测试一致；bun 亦可跑）。
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvLoader } from "../../src/config/env-loader.js";
import type { IknowEnv } from "../../src/config/env.js";

const TEST_TIMEOUT_MS = 3000;
/** 等待 watcher 事件送达的稳定窗口。必须 ≥ 750ms（reviewer minor）：主通道
 *  fs.watch 偶发慢时需靠 watchFile 轮询（interval=500ms）冗余兜底。 */
const SETTLE_MS = 750;

interface Dirs {
  base: string;
  cwd: string;
  home: string;
  projectFile: string;
}

function makeDirs(): Dirs {
  const base = mkdtempSync(join(tmpdir(), "iknow-env-loader-"));
  const home = join(base, "home");
  const cwd = join(base, "cwd");
  mkdirSync(join(home, ".iknow"), { recursive: true });
  mkdirSync(join(cwd, ".iknow"), { recursive: true });
  return {
    base,
    cwd,
    home,
    projectFile: join(cwd, ".iknow", "settings.json"),
  };
}

function writeSettings(dirs: Dirs, model: string, apiKey?: string): void {
  writeFileSync(
    dirs.projectFile,
    JSON.stringify({
      llm: { model, ...(apiKey !== undefined ? { apiKey } : {}) },
    }) + "\n",
    "utf8"
  );
}

/** 等待条件成立（poll），超时抛错。 */
async function waitUntil(
  cond: () => boolean,
  msg: string,
  timeoutMs = SETTLE_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe("createEnvLoader", () => {
  test(
    "get() 首次 lazy load；再次 get() 返回同一引用（缓存命中）",
    async () => {
      const dirs = makeDirs();
      writeSettings(dirs, "model-a");
      const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
      try {
        const env1: IknowEnv = loader.get();
        expect(env1.llm.model).toBe("model-a");
        const env2: IknowEnv = loader.get();
        expect(env2).toBe(env1); // 同一引用（缓存命中）
      } finally {
        loader.stop();
        rmSync(dirs.base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "reload() 强制重读返回新引用",
    async () => {
      const dirs = makeDirs();
      writeSettings(dirs, "model-a");
      const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
      try {
        const env1 = loader.get();
        writeSettings(dirs, "model-b");
        const env2 = loader.reload();
        expect(env2).not.toBe(env1); // 新引用
        expect(env2.llm.model).toBe("model-b");
        expect(loader.get()).toBe(env2); // reload 后缓存 = 新 env
      } finally {
        loader.stop();
        rmSync(dirs.base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "watch 触发后 subscriber 自动收到新 env",
    async () => {
      const dirs = makeDirs();
      writeSettings(dirs, "model-a");
      const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
      try {
        const received: string[] = [];
        loader.subscribe((env) => received.push(env.llm.model));
        loader.get(); // 确保 watcher 就绪后才有后续事件
        await new Promise((r) => setTimeout(r, 80));
        writeSettings(dirs, "model-b");
        await waitUntil(() => received.length >= 1, "subscriber 收到 model-b");
        expect(received[0]).toBe("model-b");
        // 缓存也已更新（subscriber 拿到的是 reload 后的新 env）。
        expect(loader.get().llm.model).toBe("model-b");
      } finally {
        loader.stop();
        rmSync(dirs.base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "reload 抛错（坏 JSON）→ 缓存不变 + onError 收到错",
    async () => {
      const dirs = makeDirs();
      writeSettings(dirs, "model-a");
      const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
      try {
        const env1 = loader.get();
        const errors: unknown[] = [];
        loader.onError((err) => errors.push(err));
        // 写坏 JSON → watcher 触发 → reload 抛错 → 缓存保持旧值。
        writeFileSync(dirs.projectFile, "{ not-json", "utf8");
        await waitUntil(() => errors.length >= 1, "onError 收到坏 JSON 错误");
        expect(loader.get()).toBe(env1); // 缓存不变（旧引用）
        expect(loader.get().llm.model).toBe("model-a");
      } finally {
        loader.stop();
        rmSync(dirs.base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "stop() 后 watch 不再触发 + subscribe 回调不被调用",
    async () => {
      const dirs = makeDirs();
      writeSettings(dirs, "model-a");
      const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
      try {
        const received: string[] = [];
        loader.subscribe((env) => received.push(env.llm.model));
        loader.get();
        await new Promise((r) => setTimeout(r, 80));
        loader.stop();
        writeSettings(dirs, "model-b");
        // 窗口内不应有新通知。
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        expect(received.length).toBe(0);
        // stop() 幂等（可重复调，不抛错）。
        loader.stop();
      } finally {
        rmSync(dirs.base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "createEnvLoader 多次实例化互不干扰",
    async () => {
      const dirsA = makeDirs();
      const dirsB = makeDirs();
      writeSettings(dirsA, "model-a");
      writeSettings(dirsB, "model-b");
      const loaderA = createEnvLoader({
        cwd: dirsA.cwd,
        home: dirsA.home,
      });
      const loaderB = createEnvLoader({
        cwd: dirsB.cwd,
        home: dirsB.home,
      });
      try {
        expect(loaderA.get().llm.model).toBe("model-a");
        expect(loaderB.get().llm.model).toBe("model-b");
        // A 的 watcher 事件不通知 B 的 subscriber。
        const bReceived: string[] = [];
        loaderB.subscribe((env) => bReceived.push(env.llm.model));
        writeSettings(dirsA, "model-a2");
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        expect(bReceived.length).toBe(0);
        expect(loaderA.get().llm.model).toBe("model-a2");
        expect(loaderB.get().llm.model).toBe("model-b");
      } finally {
        loaderA.stop();
        loaderB.stop();
        rmSync(dirsA.base, { recursive: true, force: true });
        rmSync(dirsB.base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );
});
