/**
 * 跨平台打开浏览器（T7 自动 open，零新增 runtime deps）。
 *
 * 用 node:child_process.spawn 调各平台默认打开命令：
 *   - macOS   `open <url>`
 *   - Windows `cmd /c start "" <url>`（start 内建，需经 cmd）
 *   - Linux/其他 UN*X `xdg-open <url>`
 *
 * fail-fast 由调用方 runTrace 负责（检测到旧 ./trace.jsonl 就抛错不启动）；
 * 这里只做 fire-and-forget 打开，spawn 失败（如 headless 无 xdg-open、WSL 无
 * 图形环境）静默忽略 —— 自动 open 是启动体验的锦上添花，不应让 CLI 因打不开
 * 浏览器而崩。spawn 失败分两种：同步 throw（spawn 同步段）与异步 'error' 事件
 * （如 EACCES 找不到可执行文件）—— 两者都要兜住，缺一都会把 CLI 带崩。
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

/** 打开 url；spawn 失败静默 ignore（不 throw、不崩进程）。 */
export function openBrowser(url: string, opts: OpenBrowserOptions = {}): void {
  if (opts.enabled === false) return;
  const { cmd, args } = openCommandForPlatform();
  const doSpawn = opts.spawnProcess ?? spawn;
  try {
    const child = doSpawn(cmd, [...args, url], {
      stdio: "ignore",
      detached: true,
    });
    // EACCES / ENOENT 等以异步 'error' 事件发射，不监听会变成 unhandled
    // error 把整个 CLI 带崩（trace 已在服务，不应因开浏览器而死）。fail-safe：
    // 吞掉错误，浏览器打不开就静默放弃，与下方同步 catch 语义一致。
    child.on("error", () => {});
    // unref：打开浏览器是 fire-and-forget，不持有事件循环，trace 进程
    // Ctrl+C 后不会因 child 挂起阻止退出。
    child.unref();
  } catch {
    // spawn 同步段失败（如 spawn 本身 throw）→ 不打开，不阻塞 CLI 启动。
  }
}
