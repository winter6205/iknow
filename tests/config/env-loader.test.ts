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
import { hashSettingsContent } from "../../src/config/persist-settings.js";
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
    "opts 缺省（cwd/home 均未注入）→ 构造可用且 stop() 幂等",
    async () => {
      // 不调 get()（避免触碰真实 ~/.iknow / <cwd>/.iknow 读取）；仅验证缺省
      // 路径下 watcher 构造 + markSelfWrite（纯内存 LRU）+ stop() 幂等。
      const loader = createEnvLoader({});
      expect(typeof loader.get).toBe("function");
      expect(() =>
        loader.markSelfWrite("/tmp/iknow-sentinel-unused.json", "{}")
      ).not.toThrow();
      expect(() => loader.stop()).not.toThrow();
      expect(() => loader.stop()).not.toThrow(); // stop() 幂等
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
        loader.subscribe((env) => {
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
        expect(received[0]).toBe("model-b");
        expect(loader.get().llm.model).toBe("model-b"); // 缓存已更新
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
        expect(() => unsubscribe()).not.toThrow(); // 退订闭包幂等
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
        writeFileSync(dirs.projectFile, "{ not-json", "utf8"); // 坏 JSON → reload 抛错
        await waitUntil(() => errors.length >= 1, "第二个 onError 收到错误");
        expect(loader.get().llm.model).toBe("model-a"); // 缓存保持旧值
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

/**
 * T2 self-write 哨兵：写回登记 → 相同内容命中 → 跳过 reload（写回不回环）。
 *
 * 基于既有 watcher 集成路径断言（事件经 settings-watch 真实到达 onChange，
 * 判定逻辑 = 读文件 + 哈希比对，不经任何 mock）：
 *  - 命中 → subscriber 不被调 + 缓存引用不变（跳过 reload）；
 *  - 未命中（外部内容）→ subscriber 正常收到新 env（PR #413 行为不变）；
 *  - 一次性消费：相同登记只吞第一次，第二次按外部 reload；
 *  - LRU 容量 8：第 9 条挤掉最旧路径，旧路径登记不再命中；
 *  - 读失败（目标被删）→ 按外部走 reload（保守，不吞事件）。
 *
 * 注意 watchFile 兜底（interval 500ms）会掩盖事件缺失，故正向跳过断言仍需
 * SETTLE_MS 窗口内的「引用不变」，而非无通知。
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
        // 模拟一次写回：内容写入文件 + 登记同一 bytes（run.tsx 写回后的接线）。
        const bytes = `${JSON.stringify({ llm: { model: "model-a" } })}\n`;
        writeFileSync(dirs.projectFile, bytes, "utf8");
        loader.markSelfWrite(dirs.projectFile, bytes);
        // 同一内容稳定窗口内不得触发 reload（跳过）。
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        expect(received.length).toBe(0);
        expect(loader.get()).toBe(env1); // 缓存引用不变（未 reload）
        expect(loader.get().llm.model).toBe("model-a");
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
        // 同一路径登记两个不同内容（thinking 面板 + effort 面板两次写回）。
        const bytesX = `${JSON.stringify({ llm: { model: "model-x" } })}\n`;
        const bytesY = `${JSON.stringify({ llm: { model: "model-y" } })}\n`;
        loader.markSelfWrite(dirs.projectFile, bytesX);
        loader.markSelfWrite(dirs.projectFile, bytesY);
        // 写回内容 X → 命中登记（Set 剩 Y）→ 跳过 reload。
        writeFileSync(dirs.projectFile, bytesX, "utf8");
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        expect(received.length).toBe(0);
        expect(loader.get()).toBe(env1);
        // 写回内容 Y → 命中剩余登记（Set 清空）→ 跳过 reload。
        writeFileSync(dirs.projectFile, bytesY, "utf8");
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
        // 登记一个「当前文件」的哨兵，但外部写的内容不同 → 不该被吞。
        loader.markSelfWrite(
          dirs.projectFile,
          `${JSON.stringify({ llm: { model: "model-ghost" } })}\n`
        );
        writeSettings(dirs, "model-b"); // 外部改动：内容 ≠ 登记内容
        await waitUntil(() => received.length >= 1, "subscriber 收到 model-b");
        expect(received[0]).toBe("model-b");
        expect(loader.get()).not.toBe(env1);
        expect(loader.get().llm.model).toBe("model-b");
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
        const bytes = `${JSON.stringify({ llm: { model: "model-b" } })}\n`;
        // 第一次写回：写盘后登记（100ms debounce 窗口内登记必先于 onChange 到达，
        // 与 run.tsx 的 persist → markSelfWrite 时序一致）→ 哨兵命中吞掉。
        writeFileSync(dirs.projectFile, bytes, "utf8");
        loader.markSelfWrite(dirs.projectFile, bytes);
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        expect(received.length).toBe(0);
        expect(loader.get()).toBe(env1); // 未 reload（缓存引用不变）
        // 同一内容再次出现（外部重复写，无新登记）→ 哨兵已一次性消费 → 按外部 reload。
        writeFileSync(dirs.projectFile, bytes, "utf8");
        await waitUntil(
          () => received.length >= 1,
          "第二次同内容被外部 reload"
        );
        expect(received[0]).toBe("model-b");
        expect(loader.get()).not.toBe(env1);
        expect(loader.get().llm.model).toBe("model-b");
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
        // 登记 9 条不同路径 → 第 1 条（projectFile）被 LRU 挤掉。
        const filler = (i: number): string =>
          `${JSON.stringify({ llm: { model: `filler-${i}` } })}\n`;
        loader.markSelfWrite(dirs.projectFile, filler(0));
        for (let i = 1; i < 9; i++) {
          loader.markSelfWrite(join(dirs.base, `other-${i}.json`), filler(i));
        }
        // projectFile 是最旧路径 → 被挤掉 → 同内容事件按外部 reload。
        writeFileSync(dirs.projectFile, filler(0), "utf8");
        await waitUntil(() => received.length >= 1, "旧路径不再命中 → reload");
        expect(received[0]).toBe("filler-0");
        expect(loader.get()).not.toBe(env1);
        expect(loader.get().llm.model).toBe("filler-0");
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
        // 登记当前内容 → 删除文件（外部操作）→ watcher 事件触发时读失败 →
        // consumeSelfWrite 返回 false → 照常 reload（模型缺失 → onError）。
        loader.markSelfWrite(
          dirs.projectFile,
          `${JSON.stringify({ llm: { model: "model-a" } })}\n`
        );
        rmSync(dirs.projectFile);
        const errors: unknown[] = [];
        loader.onError((err) => errors.push(err));
        await waitUntil(() => errors.length >= 1, "onError 收到模型缺失错误");
        expect(loader.get()).toBe(env1); // 缓存不变（reload 抛错降级语义）
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
