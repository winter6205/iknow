/**
 * Unit tests for the workspace-group collapsed-state localStorage module (node + vitest).
 *
 * Mirrors `tests/web/thinking-settings.test.ts`. Covers:
 * - key encoding (workspaceRoot is base64'd so "/" in paths cannot break the
 *   localStorage key shape)
 * - loadCollapsed defaults (unset / parse failure → false)
 * - saveCollapsed persistence correctness (non-active groups only)
 * - SSR-safety (no-op / default values when window/localStorage are absent)
 *
 * A fake store is injected via `globalThis.localStorage` (node env has none).
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
    // base64 output contains no '/', so slashes inside the root cannot break key parsing
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
    // no localStorage injected — simulates SSR/Node
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
    // make getItem throw
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
    // restore happens in afterEach
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
    // must not throw
    saveCollapsed("/x/y", true);
  });

  it("localStorage 缺席 → no-op 不抛", () => {
    // no localStorage injected
    saveCollapsed("/x/y", true);
  });
});

/**
 * CollapsedStateStore unit tests (lazy per-key init).
 *
 * Key contracts:
 *  - The first `lookup(key)` reads the default from localStorage (active groups
 *    forced to false); afterwards the in-memory value is kept and localStorage
 *    is never re-read.
 *  - `toggle(key)` flips the in-memory value and persists it; returns the new
 *    state for the React overrides.
 *  - Keys are independent — a second lookup on a different key still reads localStorage.
 *
 * This is the pure-logic base of the useWorkspaceGroups React hook; the hook
 * holds the store instance in a useRef, and together with overrides state this
 * stops groups-array reference changes from resetting collapse state.
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
    // Scenario "toggle then immediate refresh": the user toggles to true (persisted),
    // then something rewrites the localStorage value to false. If the second lookup
    // re-read localStorage, the user's toggle is lost — lazy per-key init prevents it.
    const fake = installLocalStorage();
    fake.data.set(collapseKey("/a"), "true");
    const store = new CollapsedStateStore();
    assert.equal(store.lookup("/a", false), true);
    // user toggle: flip in-memory value + persist
    const next = store.toggle("/a", false);
    assert.equal(next, false); // flipped true → false
    assert.equal(store.lookup("/a", false), false); // in-memory value is false
    // simulate an external actor (cache clear / another tab) driving localStorage against memory
    fake.data.set(collapseKey("/a"), "true");
    // second lookup must still return the in-memory value (false), not be overwritten by localStorage
    assert.equal(store.lookup("/a", false), false);
  });

  it("toggle 翻转 + 落盘", () => {
    installLocalStorage();
    const store = new CollapsedStateStore();
    assert.equal(store.lookup("/a", false), false); // starts false
    const next = store.toggle("/a", false);
    assert.equal(next, true);
    assert.equal(store.lookup("/a", false), true);
    assert.equal(loadCollapsed("/a"), true); // persisted
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
    // toggling /a must not affect /b
    store.toggle("/a", false);
    assert.equal(store.lookup("/b", false), false);
  });

  it("新 key 首次 lookup（active=false）→ localStorage 缺席时返回 false", () => {
    // no localStorage injected — simulates SSR / privacy mode
    const store = new CollapsedStateStore();
    assert.equal(store.lookup("/never/seen", false), false);
  });

  it("用 vi.useFakeTimers 不影响 lazy init 语义", () => {
    // fake-timer coverage: the implementation has no setTimeout/setInterval, but we
    // still walk fake timers to confirm timing never regresses to the old useEffect
    // wipe-out path.
    installLocalStorage();
    saveCollapsed("/a", true);
    vi.useFakeTimers();
    try {
      const store = new CollapsedStateStore();
      assert.equal(store.lookup("/a", false), true);
      store.toggle("/a", false);
      vi.advanceTimersByTime(1000);
      // state retained + persisted
      assert.equal(store.lookup("/a", false), false);
      assert.equal(loadCollapsed("/a"), false);
    } finally {
      vi.useRealTimers();
    }
  });
});
