/**
 * web/src/lib/permission-mode.ts
 *
 * Permission-mode display labels (mirrors the TUI/REPL wording).
 *
 * Cross-package mirror constraint: labels must stay equal to
 * src/harness/permission/modes.ts `modeLabel` (Default / Plan Mode / Auto) —
 * change one side, sync the other. The mode enum and cycling are not
 * duplicated on the web side: switching goes through
 * POST /api/v1/permission-mode and the backend SSOT `nextShiftTabMode`
 * decides cycle semantics.
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
