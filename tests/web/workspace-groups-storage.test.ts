/**
 * serve-workspace T4 — workspace 组折叠态 localStorage 模块单测 (node + vitest)。
 *
 * 镜像 `tests/web/thinking-settings.test.ts` 模式。覆盖：
 * - key 编码（base64 包含 workspaceRoot，避免路径含 "/" 破坏 localStorage 形态）
 * - loadCollapsed 默认值（未存 / 解析失败 → false）
 * - saveCollapsed 落盘正确（仅非活跃组）
 * - SSR-safe（window/localStorage 缺席时 no-op / 返回默认值）
 *
 * 通过 `globalThis.localStorage` 注入 fake store（node env 无 localStorage）。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import {
  collapseKey,
  loadCollapsed,
  saveCollapsed,
} from "../../web/src/lib/workspace-groups.ts";

type FakeStorage = {
  data: Map<string, string>;
  failNext?: boolean;
};

function installLocalStorage(): FakeStorage {
  const fake: FakeStorage = { data: new Map() };
  const stub: Storage = {
    getItem: (k) => fake.data.get(k) ?? null,
    setItem: (k, v) => {
      if (fake.failNext) {
        fake.failNext = false;
        throw new Error("QuotaExceeded");
      }
      fake.data.set(k, v);
    },
    removeItem: (k) => {
      fake.data.delete(k);
    },
    clear: () => fake.data.clear(),
    key: (i) => Array.from(fake.data.keys())[i] ?? null,
    get length() {
      return fake.data.size;
    },
  };
  vi.stubGlobal("localStorage", stub);
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collapseKey — 编码（避免 '/' 破坏 key 形态）", () => {
  it("典型 workspaceRoot → 完整前缀 + base64(root)", () => {
    const k = collapseKey("/home/winner/projects/iknow");
    assert.ok(k.startsWith("sidebar.workspaceGroups."), `key prefix: ${k}`);
    assert.ok(k.length > "sidebar.workspaceGroups.".length);
    // base64 中不含 '/'（即 root 内的 '/' 不会破坏 key 解析）
    const tail = k.slice("sidebar.workspaceGroups.".length);
    assert.ok(!tail.includes("/"), `tail should not contain '/': ${tail}`);
    assert.ok(!tail.includes(" "), `tail should not contain ' ': ${tail}`);
  });

  it("(未绑定) sentinel → 编码同样走 base64 通道", () => {
    const k = collapseKey("(未绑定)");
    assert.ok(k.startsWith("sidebar.workspaceGroups."));
  });

  it("两次相同 root → 相同 key（稳定 / cache 友好）", () => {
    assert.equal(collapseKey("/x/y"), collapseKey("/x/y"));
  });

  it("不同 root → 不同 key", () => {
    assert.notEqual(collapseKey("/x/y"), collapseKey("/x/z"));
  });
});

describe("loadCollapsed — 读取（SSR-safe / 容错）", () => {
  it("localStorage 缺席 → 默认 false", () => {
    // 不注入 localStorage, 模拟 SSR/Node
    assert.equal(loadCollapsed("/x"), false);
  });

  it("未存 → 默认 false", () => {
    installLocalStorage();
    assert.equal(loadCollapsed("/x/y"), false);
  });

  it("存的是 'true' → true", () => {
    const fake = installLocalStorage();
    fake.data.set(collapseKey("/x/y"), "true");
    assert.equal(loadCollapsed("/x/y"), true);
  });

  it("存的是 'false' → false", () => {
    const fake = installLocalStorage();
    fake.data.set(collapseKey("/x/y"), "false");
    assert.equal(loadCollapsed("/x/y"), false);
  });

  it("存的不是 boolean 字面量 (e.g. '1' / 'yes') → 容错回落 false", () => {
    const fake = installLocalStorage();
    fake.data.set(collapseKey("/x/y"), "1");
    assert.equal(loadCollapsed("/x/y"), false);
  });

  it("localStorage.getItem 抛错 → 容错回落 false", () => {
    const fake = installLocalStorage();
    // 让 getItem 抛错
    const stub: Storage = {
      getItem: () => {
        throw new Error("boom");
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      get length() {
        return 0;
      },
    };
    vi.stubGlobal("localStorage", stub);
    assert.equal(loadCollapsed("/x/y"), false);
    // 恢复
    void fake;
  });
});

describe("saveCollapsed — 落盘（仅非活跃组 / 容错）", () => {
  it("存 true → localStorage 写入 'true'", () => {
    const fake = installLocalStorage();
    saveCollapsed("/x/y", true);
    assert.equal(fake.data.get(collapseKey("/x/y")), "true");
  });

  it("存 false → 显式写 'false' (以便明确覆写历史)", () => {
    const fake = installLocalStorage();
    saveCollapsed("/x/y", false);
    assert.equal(fake.data.get(collapseKey("/x/y")), "false");
  });

  it("localStorage.setItem 抛错 (quota) → no-op 不抛", () => {
    const fake = installLocalStorage();
    fake.failNext = true;
    // 不应抛
    saveCollapsed("/x/y", true);
  });

  it("localStorage 缺席 → no-op 不抛", () => {
    // 不注入 localStorage
    saveCollapsed("/x/y", true);
  });
});
