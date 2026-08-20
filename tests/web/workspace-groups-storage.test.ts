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
  CollapsedStateStore,
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

/**
 * serve-workspace T7b — CollapsedStateStore 单测（M3 lazy init）。
 *
 * 关键契约：
 *  - 首次 `lookup(key)` 从 localStorage 读默认值（活跃组强制 false），之后
 *    保留内存值，不再 re-read localStorage。
 *  - `toggle(key)` 翻转内存值 + 落盘；返回新状态供 React overrides 用。
 *  - 多个 key 之间独立 — 第二次 lookup 不同 key 也会读 localStorage。
 *
 * 这是 useWorkspaceGroups React hook 的纯逻辑底座；hook 在 useRef 里持有
 * store 实例，配合 overrides state 让 groups 数组引用变化不再触发状态重置。
 */
describe("CollapsedStateStore — lazy per-key init (T7b M3)", () => {
  it("首次 lookup 一个 key → 从 localStorage 读默认值", () => {
    const fake = installLocalStorage();
    fake.data.set(collapseKey("/a"), "true");
    const store = new CollapsedStateStore();
    assert.equal(store.lookup("/a", false), true);
  });

  it("活跃组 lookup → 首次即返回 false（不读 localStorage）", () => {
    const fake = installLocalStorage();
    fake.data.set(collapseKey("/a"), "true");
    const store = new CollapsedStateStore();
    assert.equal(store.lookup("/a", true), false);
  });

  it("同一 key 二次 lookup → 保留内存值，不重读 localStorage", () => {
    // 模拟"toggle 后立即 refresh"：用户先 toggle 把状态改成 true 落盘，
    // 然后某种操作让 localStorage 里的值被改成 false。如果 store 在二次
    // lookup 时重读 localStorage，会丢用户的 toggle。T7b 修这个 bug。
    const fake = installLocalStorage();
    fake.data.set(collapseKey("/a"), "true");
    const store = new CollapsedStateStore();
    assert.equal(store.lookup("/a", false), true);
    // 用户 toggle：内存值翻转 + 落盘
    const next = store.toggle("/a", false);
    assert.equal(next, false); // 从 true 翻到 false
    assert.equal(store.lookup("/a", false), false); // 内存值是 false
    // 模拟外部因素（用户清缓存 / 别的 tab 写入）让 localStorage 与内存值反向
    fake.data.set(collapseKey("/a"), "true");
    // 二次 lookup 必须仍返回内存值（false），不能被 localStorage 反向覆盖
    assert.equal(store.lookup("/a", false), false);
  });

  it("toggle 翻转 + 落盘", () => {
    installLocalStorage();
    const store = new CollapsedStateStore();
    assert.equal(store.lookup("/a", false), false); // 初始 false
    const next = store.toggle("/a", false);
    assert.equal(next, true);
    assert.equal(store.lookup("/a", false), true);
    assert.equal(loadCollapsed("/a"), true); // 落盘
  });

  it("toggle 反向 — 回到 false", () => {
    installLocalStorage();
    const store = new CollapsedStateStore();
    store.toggle("/a", false); // false → true
    const next = store.toggle("/a", false); // true → false
    assert.equal(next, false);
    assert.equal(loadCollapsed("/a"), false);
  });

  it("不同 key 之间独立 — lookup A 不会污染 lookup B 的初始读取", () => {
    const fake = installLocalStorage();
    fake.data.set(collapseKey("/a"), "true");
    fake.data.set(collapseKey("/b"), "false");
    const store = new CollapsedStateStore();
    assert.equal(store.lookup("/a", false), true);
    assert.equal(store.lookup("/b", false), false);
    // toggle /a 不应影响 /b
    store.toggle("/a", false);
    assert.equal(store.lookup("/b", false), false);
  });

  it("新 key 首次 lookup（active=false）→ localStorage 缺席时返回 false", () => {
    // 不注入 localStorage — 模拟 SSR / privacy mode
    const store = new CollapsedStateStore();
    assert.equal(store.lookup("/never/seen", false), false);
  });

  it("用 vi.useFakeTimers 不影响 lazy init 语义", () => {
    // bullet 要求 fake-timer 覆盖；新实现无 setTimeout/setInterval，但
    // 仍然跑一遍 fake timer 走读，确认不会因 timing 退化到旧 useEffect
    // wipe-out 路径。
    installLocalStorage();
    saveCollapsed("/a", true);
    vi.useFakeTimers();
    try {
      const store = new CollapsedStateStore();
      assert.equal(store.lookup("/a", false), true);
      store.toggle("/a", false);
      vi.advanceTimersByTime(1000);
      // 状态保留 + 落盘
      assert.equal(store.lookup("/a", false), false);
      assert.equal(loadCollapsed("/a"), false);
    } finally {
      vi.useRealTimers();
    }
  });
});
