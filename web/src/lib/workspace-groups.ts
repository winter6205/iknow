/**
 * serve-workspace T4 — Sidebar 工作空间组折叠态 localStorage 持久化 + T7b 懒加载。
 *
 * 设计要点:
 *  - key 形如 `sidebar.workspaceGroups.<encoded>`，其中 `<encoded>` 是
 *    base64(workspaceRoot) 或 base64("(未绑定)") —— 路径内的 "/" 不会破坏
 *    localStorage 形态。
 *  - 仅持久化非活跃组的折叠态；活跃组永远展开，UI 层也不应写入（直接不调
 *    saveCollapsed）。这样刷新页面后用户不会把"我现在在哪儿"折叠掉。
 *  - 浏览器专用：btoa + TextEncoder 路径，Node 兜底 / Buffer 已删（T7b review
 *    fix M1）。Node 20+ 全局 btoa 存在，vitest 在 node env 下也走 btoa。
 *  - T7b: `CollapsedStateStore` 把"懒初始化 / 内存缓存 / 落盘"封进一个
 *    `useRef` 实例，让 `useWorkspaceGroups` 不再依赖 useEffect([groups])
 *    来 re-init，避免用户 toggle 状态被 groups 数组引用变化抹掉。
 */

const STORAGE_PREFIX = "sidebar.workspaceGroups.";

/**
 * Encode workspaceRoot into a stable localStorage key segment. Uses base64 so
 * POSIX paths and the unbound sentinel never contain characters that would
 * confuse the key shape (`/`, spaces). Two calls with the same root return
 * the same key.
 *
 * Browser-only path: `btoa(String.fromCharCode(...new TextEncoder().encode(root)))`.
 * `unescape` was deprecated (see MDN); TextEncoder produces UTF-8 bytes which
 * `String.fromCharCode` maps to a binary string, then `btoa` base64-encodes.
 */
export function collapseKey(root: string): string {
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(root)));
  return STORAGE_PREFIX + encoded;
}

/**
 * Read the persisted collapsed flag. Missing / corrupt storage → false. SSR /
 * privacy-mode → false. Never throws.
 */
export function loadCollapsed(root: string): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    const raw = localStorage.getItem(collapseKey(root));
    return raw === "true";
  } catch {
    return false;
  }
}

/**
 * Persist a collapsed flag. SSR / quota-exceeded → no-op. Never throws.
 * The UI is responsible for not calling this with `root === activeGroup.key`.
 */
export function saveCollapsed(root: string, collapsed: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(collapseKey(root), collapsed ? "true" : "false");
  } catch {
    // localStorage may be disabled (privacy mode, quota); UI state still works.
  }
}

/**
 * 折叠态懒初始化存储（T7b review fix M3）。
 *
 * 关键契约：
 *  - 首次观察到 key 时，从 localStorage 读默认值（活跃组强制 false）；之后
 *    保留内存值，不再 re-read。
 *  - `toggle(key, isActive)` 翻转并落盘（活跃组也写盘 — UI 不暴露给活跃组的
 *    toggle 入口，但保险起见保持原行为）。
 *
 * 设计动机：原先 `useWorkspaceGroups` 依赖 `useEffect([groups])` 在 groups
 * 数组引用变化时重置整个折叠态 map；这导致用户刚刚 toggle 的非活跃组在
 * refresh（groups 重新计算）后丢失状态。改为在 `useRef` 里持有本 store 实例，
 * 配合 render-time 的 lazy 初始化（O(1) per key after first sight），groups
 * 引用变化不再触发状态重置。
 *
 * 纯 JS class，React-free，可在 node vitest 直接单测（参考
 * `tests/web/workspace-groups-storage.test.ts` 中的 CollapsedStateStore 段）。
 */
export class CollapsedStateStore {
  private readonly seen = new Map<string, boolean>();

  /**
   * 首次访问某 key 时从 localStorage 读取默认值（活跃组固定 false）；
   * 后续访问直接返回内存值。SSR / privacy-mode 下首次返回 false。
   */
  lookup(key: string, isActive: boolean): boolean {
    const cached = this.seen.get(key);
    if (cached !== undefined) return cached;
    const initial = isActive ? false : loadCollapsed(key);
    this.seen.set(key, initial);
    return initial;
  }

  /**
   * 翻转并落盘（仅写一次 localStorage；活跃组也写 — 防御性，UI 不暴露给
   * 活跃组的 toggle）。返回新状态供 React 更新 override map。
   */
  toggle(key: string, isActive: boolean): boolean {
    const cur = this.lookup(key, isActive);
    const next = !cur;
    this.seen.set(key, next);
    saveCollapsed(key, next);
    return next;
  }
}
