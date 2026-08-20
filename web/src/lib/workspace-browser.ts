/**
 * serve-workspace T3 — picker 子目录浏览器的纯逻辑层。
 *
 * 把 React 组件里"决定 base 默认值"与"路径切面包屑"两条决策抽出来, 让
 * 单测在 node 环境直接覆盖, 不依赖 jsdom / fetch。组件只负责渲染与副作用,
 * 行为契约都在这里。
 *
 * 命名: "Browser" 而非 "Browse" — `browse` 是动词(`listWorkspaceSubdirs`),
 * `browser` 是组件/纯函数层。
 */

/**
 * 探测 WSL 的最小可用方案 — 简单 hardcode `/home/winner`。WSL 互转
 * (\\wsl$\Ubuntu\... ↔ /home/winner/...) 显式 out of scope (plan §Out of
 * scope)。后续 v2 想要动态探测 (`navigator.userAgent` 含 "Linux" 或经后端
 * 读 /proc/version) 时只需替换该常量, 调用点不动。
 */
export const WSL_DEFAULT_BASE = "/home/winner";

/**
 * Picker mount 时 base 默认值决议:
 *  - currentRoot 优先 (已绑定则用户想换才改, 不要每次开 picker 都跳回 default)。
 *  - 缺 currentRoot → WSL_DEFAULT_BASE。
 *
 * 传入空串 / 纯空白视为缺席 (currentRoot 经 `?? ""` 规范化, "" / "   " 走 fallback)。
 */
export function resolveBrowserRoot(
  currentRoot: string | null,
  defaultBase: string = WSL_DEFAULT_BASE
): string {
  if (currentRoot && currentRoot.trim().length > 0) return currentRoot;
  return defaultBase;
}

/** breadcrumb 单段: name (展示) + path (点击后调 browse 的绝对路径)。 */
export interface BreadcrumbSegment {
  readonly name: string;
  readonly path: string;
}

/**
 * 把绝对路径切成 breadcrumb 段 ([/, home, winner, projects, iknow])。
 *  - POSIX `/a/b/c` → 5 段含根 `/`。
 *  - 根 `/` → 单段 `{"name":"/", "path":"/"}` (picker 永远至少展示一段)。
 *  - 空串 → 同上 (兜底, 与 WorkspaceChip.basename 行为对齐)。
 *  - Windows 反斜杠按 `\\` 切 (WSL 路径不通, 但 Picker basename 兼容, 这里也兼容, 避免 Picker 内出现双形态不一致)。
 *
 * 失败段 (`/foo/..` / 含双斜杠) 保留原始片段, 不做 normalize — browse 失败时
 * 由后端 422 走 onNotice 通道, 不在前端悄悄修。
 */
export function breadcrumbs(path: string): ReadonlyArray<BreadcrumbSegment> {
  const trimmed = path.trim();
  if (trimmed === "") {
    return [{ name: "/", path: "/" }];
  }
  const isWindows = path.includes("\\") && !path.startsWith("/");
  // 统一用 "/" 做切分, 反斜杠先替换为正斜杠
  const normalized = isWindows ? trimmed.replace(/\\/g, "/") : trimmed;
  const parts = normalized.split("/").filter((p) => p.length > 0);
  // 根: "/"
  const segs: BreadcrumbSegment[] = [{ name: "/", path: "/" }];
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    segs.push({ name: p, path: acc });
  }
  return segs;
}

/**
 * 给定子目录 entry (`{name, path}`), 用户点击后应该替换到 input 的值。
 * 直接取 `path` (后端给的绝对路径) — 这是 SSOT, 不重新 `join` 防 split 误差。
 */
export function entryToInputPath(entry: {
  readonly name: string;
  readonly path: string;
}): string {
  return entry.path;
}
