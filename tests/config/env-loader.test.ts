/**
 * EnvLoader factory + hot-reload integration.
 *
 * Covers:
 *  1. get() lazy-loads on first call; a second get() returns the same reference (cache hit).
 *  2. reload() forces a re-read and returns a new reference.
 *  3. after a watch fires, subscribers automatically receive the new env.
 *  4. reload throws (bad JSON) → cache unchanged + onError handlers get the error.
 *  5. after stop(), watch no longer fires + subscriber callbacks are not invoked.
 *  6. multiple createEnvLoader instances do not interfere.
 *
 * Discipline:
 *  - isolated home / cwd (tmp dirs injected); never touches the real ~/.iknow;
 *  - each case ends with an explicit stop() + rmSync (watcher handles + tmp cleanup);
 *  - vitest, consistent with the other tests/config suites.
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvLoader } from "../../src/config/env-loader.js";
import { hashSettingsContent } from "../../src/config/persist-settings.js";
import type { IknowEnv } from "../../src/config/env.js";
import {
  installTestProviderApiKey,
  llmSettingsJson,
} from "../_helpers/test-llm-settings.ts";

const TEST_TIMEOUT_MS = 3000;
/** Stable window for watcher events to arrive. Must be ≥ 750ms: fs.watch (the
 *  primary channel) is occasionally slow and the watchFile poll (interval=500ms)
 *  serves as the redundant fallback. */
const SETTLE_MS = 750;

interface Dirs {
  base: string;
  cwd: string;
  home: string;
  userFile: string;
  /** Project files never carry llm (not on the ADR-0084 allowlist) — used only for watcher/sentinel path assertions. */
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
    userFile: join(home, ".iknow", "settings.json"),
    projectFile: join(cwd, ".iknow", "settings.json"),
  };
}

/**
 * Writes the llm section. ADR-0084: llm is a user-layer key → always write the user
 * file; the same field in a project file is dropped by the allowlist. The watcher
 * still watches both files, so passing target routes the content to the project
 * path (for sentinel path assertions).
 */
function routeModel(model: string): string {
  return model.includes("/") ? model : `test/${model}`;
}

function settingsBytes(model: string): string {
  return `${JSON.stringify(llmSettingsJson({ model: routeModel(model) }))}\n`;
}

function writeSettings(
  dirs: Dirs,
  model: string,
  target: string = dirs.userFile
): void {
  installTestProviderApiKey();
  writeFileSync(target, settingsBytes(model), "utf8");
}

/** Polls until the condition holds; throws on timeout. */
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
        expect(env1.llm.model).toBe("test/model-a");
        const env2: IknowEnv = loader.get();
        expect(env2).toBe(env1); // same reference (cache hit)
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
        expect(env2).not.toBe(env1); // new reference
        expect(env2.llm.model).toBe("test/model-b");
        expect(loader.get()).toBe(env2); // after reload the cache = the new env
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
        loader.get(); // make sure the watcher is up before later events
        await new Promise((r) => setTimeout(r, 80));
        writeSettings(dirs, "model-b");
        await waitUntil(() => received.length >= 1, "subscriber 收到 model-b");
        expect(received[0]).toBe("test/model-b");
        // Cache is updated too (the subscriber got the post-reload env).
        expect(loader.get().llm.model).toBe("test/model-b");
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
        // Write bad JSON → watcher fires → reload throws → cache keeps the old value.
        writeFileSync(dirs.userFile, "{ not-json", "utf8");
        await waitUntil(() => errors.length >= 1, "onError 收到坏 JSON 错误");
        expect(loader.get()).toBe(env1); // cache unchanged (old reference)
        expect(loader.get().llm.model).toBe("test/model-a");
      } finally {
        loader.stop();
        rmSync(dirs.base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "opts 缺省（cwd/home 均未注入）→ 构造可用且 stop() 幂等",
    async () => {
      // Deliberately no get() (avoids reading the real ~/.iknow / <cwd>/.iknow);
      // verify only that on the default path the watcher constructs,
      // markSelfWrite (pure in-memory LRU) works, and stop() is idempotent.
      const loader = createEnvLoader({});
      expect(typeof loader.get).toBe("function");
      expect(() =>
        loader.markSelfWrite("/tmp/iknow-sentinel-unused.json", "{}")
      ).not.toThrow();
      expect(() => loader.stop()).not.toThrow();
      expect(() => loader.stop()).not.toThrow(); // stop() is idempotent
    },
    TEST_TIMEOUT_MS
  );

  test(
    "notify 吞 observer 异常：单个 subscriber 抛错不阻断 reload（其余 subscriber 仍收到新 env）",
    async () => {
      const dirs = makeDirs();
      writeSettings(dirs, "model-a");
      const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
      try {
        const received: string[] = [];
        loader.subscribe(() => {
          throw new Error("observer boom");
        });
        loader.subscribe((env) => received.push(env.llm.model));
        loader.get();
        await new Promise((r) => setTimeout(r, 80));
        writeSettings(dirs, "model-b");
        await waitUntil(
          () => received.length >= 1,
          "第二个 subscriber 收到 model-b"
        );
        expect(received[0]).toBe("test/model-b");
        expect(loader.get().llm.model).toBe("test/model-b"); // cache updated
      } finally {
        loader.stop();
        rmSync(dirs.base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "subscribe 返回的退订函数可调（stop() 后调用不抛错）",
    async () => {
      const dirs = makeDirs();
      writeSettings(dirs, "model-a");
      const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
      try {
        loader.get();
        const unsubscribe = loader.subscribe(() => {});
        loader.stop();
        expect(() => unsubscribe()).not.toThrow(); // unsubscribe closure is idempotent
      } finally {
        rmSync(dirs.base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "notifyError 吞错误处理器异常：单个 onError 抛错不阻断其它处理器",
    async () => {
      const dirs = makeDirs();
      writeSettings(dirs, "model-a");
      const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
      try {
        const errors: unknown[] = [];
        loader.onError(() => {
          throw new Error("error-handler boom");
        });
        loader.onError((err) => errors.push(err));
        loader.get();
        await new Promise((r) => setTimeout(r, 80));
        writeFileSync(dirs.userFile, "{ not-json", "utf8"); // bad JSON → reload throws
        await waitUntil(() => errors.length >= 1, "第二个 onError 收到错误");
        expect(loader.get().llm.model).toBe("test/model-a"); // cache keeps the old value
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
        // No new notification should arrive within the window.
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        expect(received.length).toBe(0);
        // stop() is idempotent (callable repeatedly, no throw).
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
        expect(loaderA.get().llm.model).toBe("test/model-a");
        expect(loaderB.get().llm.model).toBe("test/model-b");
        // A's watcher events must not notify B's subscribers.
        const bReceived: string[] = [];
        loaderB.subscribe((env) => bReceived.push(env.llm.model));
        writeSettings(dirsA, "model-a2");
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        expect(bReceived.length).toBe(0);
        expect(loaderA.get().llm.model).toBe("test/model-a2");
        expect(loaderB.get().llm.model).toBe("test/model-b");
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

/**
 * Self-write sentinel: write-back registration → same content hits → reload skipped
 * (a write-back never loops back into itself).
 *
 * Asserted over the real watcher integration path (events reach onChange through
 * settings-watch; the decision = read file + hash compare, no mocks):
 *  - hit → subscriber not called + cache reference unchanged (reload skipped);
 *  - miss (external content) → subscriber still receives the new env;
 *  - one-shot consumption: a registration swallows only the first matching event,
 *    the second is treated as an external reload;
 *  - LRU capacity 8: the 9th entry evicts the oldest path, whose registration no longer hits;
 *  - read failure (target deleted) → treated as external reload (conservative; never swallow events).
 *
 * Note: the watchFile fallback (interval 500ms) can mask a missing event, so the
 * positive skip assertion relies on "reference unchanged" within the SETTLE_MS
 * window, not on absence of notifications.
 */
describe("createEnvLoader self-write 哨兵 (T2)", () => {
  test(
    "markSelfWrite 后模拟自写 → onChange 触发但不 reload（subscriber 不被调，缓存引用不变）",
    async () => {
      const dirs = makeDirs();
      writeSettings(dirs, "model-a");
      const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
      try {
        const env1 = loader.get();
        const received: string[] = [];
        loader.subscribe((env) => received.push(env.llm.model));
        await new Promise((r) => setTimeout(r, 80));
        // Simulate one write-back: content written to file + same bytes registered
        // (mirrors the wiring after run.tsx's write-back; ADR-0084: the write-back
        // target is the user file).
        const bytes = settingsBytes("model-a");
        writeFileSync(dirs.userFile, bytes, "utf8");
        loader.markSelfWrite(dirs.userFile, bytes);
        // The same content must not trigger a reload within the settle window (skipped).
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        expect(received.length).toBe(0);
        expect(loader.get()).toBe(env1); // cache reference unchanged (no reload)
        expect(loader.get().llm.model).toBe("test/model-a");
      } finally {
        loader.stop();
        rmSync(dirs.base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "同路径多次登记 + 多哈希消费：两内容各自命中后剩条目保留（多面板连续写回）",
    async () => {
      const dirs = makeDirs();
      writeSettings(dirs, "model-a");
      const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
      try {
        const env1 = loader.get();
        const received: string[] = [];
        loader.subscribe((env) => received.push(env.llm.model));
        await new Promise((r) => setTimeout(r, 80));
        // Register two different contents on the same path (thinking panel + effort panel write-backs).
        const bytesX = settingsBytes("model-x");
        const bytesY = settingsBytes("model-y");
        loader.markSelfWrite(dirs.userFile, bytesX);
        loader.markSelfWrite(dirs.userFile, bytesY);
        // Write back content X → hits the registration (Set keeps Y) → reload skipped.
        writeFileSync(dirs.userFile, bytesX, "utf8");
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        expect(received.length).toBe(0);
        expect(loader.get()).toBe(env1);
        // Write back content Y → hits the remaining registration (Set emptied) → reload skipped.
        writeFileSync(dirs.userFile, bytesY, "utf8");
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        expect(received.length).toBe(0);
        expect(loader.get()).toBe(env1);
      } finally {
        loader.stop();
        rmSync(dirs.base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "外部写（内容 ≠ 登记过）→ 照常 reload（subscriber 收到新 env）",
    async () => {
      const dirs = makeDirs();
      writeSettings(dirs, "model-a");
      const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
      try {
        const env1 = loader.get();
        const received: string[] = [];
        loader.subscribe((env) => received.push(env.llm.model));
        await new Promise((r) => setTimeout(r, 80));
        // Register a sentinel for the "current file", but the external write differs → must not be swallowed.
        loader.markSelfWrite(dirs.userFile, settingsBytes("model-ghost"));
        writeSettings(dirs, "model-b"); // external change: content ≠ registered content
        await waitUntil(() => received.length >= 1, "subscriber 收到 model-b");
        expect(received[0]).toBe("test/model-b");
        expect(loader.get()).not.toBe(env1);
        expect(loader.get().llm.model).toBe("test/model-b");
      } finally {
        loader.stop();
        rmSync(dirs.base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "一次性消费：登记一次 + 两次同内容事件 → 只吞第一次（第二次按外部 reload）",
    async () => {
      const dirs = makeDirs();
      writeSettings(dirs, "model-a");
      const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
      try {
        const env1 = loader.get();
        const received: string[] = [];
        loader.subscribe((env) => received.push(env.llm.model));
        await new Promise((r) => setTimeout(r, 80));
        const bytes = settingsBytes("model-b");
        // First write-back: register after writing to disk (within the 100ms debounce
        // window the registration always arrives before onChange, matching run.tsx's
        // persist → markSelfWrite ordering) → sentinel hit swallows the event.
        // Path = write-back target (ADR-0084: user-layer keys write the user file).
        writeFileSync(dirs.userFile, bytes, "utf8");
        loader.markSelfWrite(dirs.userFile, bytes);
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        expect(received.length).toBe(0);
        expect(loader.get()).toBe(env1); // no reload (cache reference unchanged)
        // Same content appears again (external repeat write, no new registration) →
        // sentinel already consumed one-shot → treated as external reload.
        writeFileSync(dirs.userFile, bytes, "utf8");
        await waitUntil(
          () => received.length >= 1,
          "第二次同内容被外部 reload"
        );
        expect(received[0]).toBe("test/model-b");
        expect(loader.get()).not.toBe(env1);
        expect(loader.get().llm.model).toBe("test/model-b");
      } finally {
        loader.stop();
        rmSync(dirs.base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "LRU 容量 8：第 9 条挤掉最旧路径，旧路径登记不再命中",
    async () => {
      const dirs = makeDirs();
      writeSettings(dirs, "model-a");
      const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
      try {
        const env1 = loader.get();
        const received: string[] = [];
        loader.subscribe((env) => received.push(env.llm.model));
        await new Promise((r) => setTimeout(r, 80));
        // Register 9 distinct paths → the 1st (userFile, the write-back target) is evicted by the LRU.
        const filler = (i: number): string => settingsBytes(`filler-${i}`);
        loader.markSelfWrite(dirs.userFile, filler(0));
        for (let i = 1; i < 9; i++) {
          loader.markSelfWrite(join(dirs.base, `other-${i}.json`), filler(i));
        }
        // userFile is the oldest path → evicted → same-content event goes through external reload.
        writeFileSync(dirs.userFile, filler(0), "utf8");
        await waitUntil(() => received.length >= 1, "旧路径不再命中 → reload");
        expect(received[0]).toBe("test/filler-0");
        expect(loader.get()).not.toBe(env1);
        expect(loader.get().llm.model).toBe("test/filler-0");
      } finally {
        loader.stop();
        rmSync(dirs.base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "读文件失败（markSelfWrite 后文件被删）→ 按外部走 reload（不吞事件）",
    async () => {
      const dirs = makeDirs();
      writeSettings(dirs, "model-a");
      const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
      try {
        const env1 = loader.get();
        const received: string[] = [];
        loader.subscribe((env) => received.push(env.llm.model));
        await new Promise((r) => setTimeout(r, 80));
        // Register current content → delete the file (external action) → read fails when
        // the watcher event arrives → consumeSelfWrite returns false → reload proceeds as
        // external (missing model → onError).
        loader.markSelfWrite(dirs.userFile, settingsBytes("model-a"));
        rmSync(dirs.userFile);
        const errors: unknown[] = [];
        loader.onError((err) => errors.push(err));
        await waitUntil(() => errors.length >= 1, "onError 收到模型缺失错误");
        expect(loader.get()).toBe(env1); // cache unchanged (reload-throws degradation semantics)
        expect(received.length).toBe(0);
      } finally {
        loader.stop();
        rmSync(dirs.base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );
});

describe("hashSettingsContent 兼容 (T2)", () => {
  test(
    "同串同哈希 / 异串异哈希（self-write 哨兵内容比对基础）",
    async () => {
      const bytesA = '{"llm":{"model":"m"}}\n';
      const bytesB = '{"llm":{"model":"m2"}}\n';
      expect(hashSettingsContent(bytesA)).toBe(hashSettingsContent(bytesA));
      expect(hashSettingsContent(bytesA)).not.toBe(hashSettingsContent(bytesB));
    },
    TEST_TIMEOUT_MS
  );
});
