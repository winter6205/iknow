/**
 * 跨平台打开浏览器（T7 自动 open，零新增 runtime deps）。
 *
 * 用 node:child_process.spawn 调各平台默认打开命令：
 *   - macOS   `open <url>`
 *   - Windows `cmd /c start "" <url>`（start 内建，需经 cmd）
 *   - Linux/其他 UN*X `xdg-open <url>`
 *
 * fail-fast 由调用方 runTrace 负责（检测到旧 ./trace.jsonl 就抛错不启动）；
 * 这里只做 fire-and-forget 打开，spawn 失败（如 headless 无 xdg-open）静默
 * 忽略 —— 自动 open 是启动体验的锦上添花，不应让 CLI 因打不开浏览器而崩。
 */
import { spawn } from "node:child_process";

export interface OpenBrowserOptions {
  /** 测试 seam：注入假 spawn，避免 CI 真开浏览器。缺省用 node 实现。 */
  readonly spawnProcess?: typeof spawn;
  /** 是否真正打开（false 时 no-op）。缺省 true。 */
  readonly enabled?: boolean;
}

/** 解析当前平台对应的打开命令（cmd + args，不含 URL）。测试可注入 spawn 以断言。 */
export function openCommandForPlatform(
  platform: NodeJS.Platform = process.platform
): { cmd: string; args: string[] } {
  if (platform === "darwin") {
    return { cmd: "open", args: [] };
  }
  if (platform === "win32") {
    // `start` 是 cmd 内建，必须经 cmd /c 调用；首个 "" 是窗口标题占位。
    return { cmd: "cmd", args: ["/c", "start", ""] };
  }
  // linux / freebsd / 其他 UN*X
  return { cmd: "xdg-open", args: [] };
}

/** 打开 url；spawn 失败静默 ignore（不 throw）。 */
export function openBrowser(url: string, opts: OpenBrowserOptions = {}): void {
  if (opts.enabled === false) return;
  const { cmd, args } = openCommandForPlatform();
  const doSpawn = opts.spawnProcess ?? spawn;
  try {
    const child = doSpawn(cmd, [...args, url], {
      stdio: "ignore",
      detached: true,
    });
    // unref：打开浏览器是 fire-and-forget，不持有事件循环，trace 进程
    // Ctrl+C 后不会因 child 挂起阻止退出。
    child.unref();
  } catch {
    // headless（CI / 无 xdg-open）→ 不打开，不阻塞 CLI 启动。
  }
}
