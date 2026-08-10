/**
 * src/tui/version.ts — #146 TUI 展示用版本号（SSOT = package.json）。
 * 构建期不做版本注入；读取器复用 cli/usage.ts 的 getVersion()（同源读
 * package.json + 同一 fallback，避免两份版本读取实现漂移）。
 */
import { getVersion } from "../cli/usage.js";

export const VERSION: string = getVersion();
