/**
 * web/src/lib/permission-mode.ts
 *
 * Permission mode 显示标签（镜像 TUI/REPL 口径）。
 *
 * 跨 package 镜像约束：标签与 src/harness/permission/modes.ts `modeLabel`
 * 同值（Default / Plan Mode / Auto）—— 修改任一侧必须同步另一侧。
 * 模式枚举与循环语义不在 web 侧重复：切换走 POST /api/v1/permission-mode，
 * cycle 语义由后端 SSOT `nextShiftTabMode` 裁决。
 */
import type { PermissionMode } from "../api/types";

export function permissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case "default":
      return "Default";
    case "plan":
      return "Plan Mode";
    case "full_auto":
      return "Auto";
  }
}
