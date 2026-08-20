/**
 * serve-workspace T4 — Sidebar 工作空间组折叠态 localStorage 持久化。
 *
 * 设计要点:
 *  - key 形如 `sidebar.workspaceGroups.<encoded>`，其中 `<encoded>` 是
 *    base64(workspaceRoot) 或 base64("(未绑定)") —— 路径内的 "/" 不会破坏
 *    localStorage 形态。
 *  - 仅持久化非活跃组的折叠态；活跃组永远展开，UI 层也不应写入（直接不调
 *    saveCollapsed）。这样刷新页面后用户不会把"我现在在哪儿"折叠掉。
 *  - SSR-safe：localStorage 缺席（Node 测试 / 隐私模式 / 禁用）一律 no-op，
 *    不抛错，让 UI 仍能 work。
 */

const STORAGE_PREFIX = "sidebar.workspaceGroups.";

/**
 * Encode workspaceRoot into a stable localStorage key segment. Uses base64 so
 * POSIX paths and the unbound sentinel never contain characters that would
 * confuse the key shape (`/`, spaces). Two calls with the same root return
 * the same key.
 */
export function collapseKey(root: string): string {
  const encoded =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(root)))
      : Buffer.from(root, "utf8").toString("base64");
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
