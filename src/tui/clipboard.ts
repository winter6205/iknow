/**
 * src/tui/clipboard.ts
 *
 * #343 T5：迁移自 archive/tui-ink/src/clipboard.ts（#238 鼠标拖选复制
 * fallback 链）。T0 归档后从 src/tui/ 重建此文件——逻辑、平台探测、PATH
 * 隔离、超时都保持不动（语义对齐 ink 版 #238 copy-flow 契约）：
 *  1. macOS pbcopy
 *  2. Linux wl-copy（Wayland）
 *  3. Linux xclip -selection clipboard（X11）
 *  4. Linux xsel --clipboard（X11 退化）
 *  5. Windows clip.exe
 *  6. 退化：写 <dataDir>/last_copy.txt
 *
 * T5 调用入口：app.tsx 的 `doCopySelection`（OSC52 不可用 / 不可达时
 * 走此 fallback 链）。T5 优先路径是 `renderer.copyToClipboardOSC52`
 * （@opentui/core 内置 OSC52 写入），仅当终端不支持 OSC52 时退回
 * 本文件的 platform 探测链——D3 裁决保留两条路径，OSC52 失败不会
 * 静默。
 *
 * 不引外部依赖：复制实现 100 行出头可控，pyperclip 倒退在 ts-paths
 * 之外、对单仓库 lockfile 还要加一依赖，违反 #238 的最小改动目标。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CopyResult =
  | { kind: "ok"; method: ClipboardMethod }
  | { kind: "fallback"; path: string; bytes: number }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export type ClipboardMethod =
  "pyperclip" | "pbcopy" | "wl-copy" | "xclip" | "xsel" | "clip.exe";

interface CommandCandidate {
  readonly method: ClipboardMethod;
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * 按平台挑出命令候选。Linux 同时备好 wl-copy / xclip / xsel；
 * 哪个在 PATH 真正命中由 copyToClipboard 试到。
 *
 * 为什么 Linux 同时列三个：headless 服务器（CI、纯 SSH）PATH 里
 * 通常一个都没有；普通桌面 X11 = xclip，Wayland = 后两者。三选
 * 一概率比单一 win/mac 都低。Mac/Win 不走 Linux 路径。
 */
function candidatesForPlatform(): ReadonlyArray<CommandCandidate> {
  if (process.platform === "darwin") {
    return [{ method: "pbcopy", cmd: "pbcopy", args: [] }];
  }
  if (process.platform === "win32") {
    return [{ method: "clip.exe", cmd: "clip", args: [] }];
  }
  // linux / freebsd / 其他 UN*X
  return [
    { method: "wl-copy", cmd: "wl-copy", args: [] },
    { method: "xclip", cmd: "xclip", args: ["-selection", "clipboard"] },
    { method: "xsel", cmd: "xsel", args: ["--clipboard", "--input"] },
  ];
}

function tryCommand(
  candidate: CommandCandidate,
  text: string,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(candidate.cmd, [...candidate.args], {
      stdio: ["pipe", "pipe", "pipe"],
      // detached: false → child 不脱离父进程
      windowsHide: true,
      env,
    });
    // unref：挂起的剪贴板 daemon（wl-copy 等阻塞在 compositor）忽略 SIGTERM
    // 时，不持有事件循环 — 否则 /quit 后 Node 永不退出（exit() 只 unmount 不
    // process.exit）。写系统剪贴板是 fire-and-forget，不阻塞 TUI 关闭。
    child.unref();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // 已被自然结束
      }
      resolve(false);
    }, 1500);
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.stdin?.on("error", () => {
      // EPIPE → 子进程提前退出。spawn 仍会触发 close，我们等 close 监听收尾。
    });
    child.stdin?.end(text, "utf8");
  });
}

/**
 * 必须先判二进制是否在 PATH——直接 spawn 失败有 stderr 噪音。node 20
 * 之前 hasbin 需要 child_process 用 && 命令探测；这里用一个 50ms 超
 * 时的 'which' 替代。Windows 不走此路径（用 'where' via cmd /c）。
 */
function which(binary: string, envPath: string): boolean {
  const sep = process.platform === "win32" ? ";" : ":";
  return envPath.split(sep).some((dir) => {
    if (!dir) return false;
    return existsSync(join(dir, binary));
  });
}

/**
 * 复制文本到系统剪贴板。允许空文本（视为成功，不复制）。
 * 三种结束：复制到剪贴板成功 / fallback 写文件 / 错（找不到任何后备）。
 *
 * options.env：注入给候选命令的 env（缺省 = process.env）。测试断言
 * 必然 fallback 时传 { PATH: "/nonexistent" }，不动全局 PATH 避免
 * 并行 worker 串扰。
 *
 * T5 备注：OSC52 路径走 CliRenderer.copyToClipboardOSC52，本函数仅作
 * 不可用 / 失败时的原生 fallback——不重复探测，保持单职责。
 */
export async function copyToClipboard(
  text: string,
  options: { readonly dataDir?: string; readonly env?: NodeJS.ProcessEnv } = {}
): Promise<CopyResult> {
  if (text.length === 0) {
    return { kind: "empty" };
  }
  const env = options.env ?? process.env;
  const envPath = env.PATH ?? "";
  for (const candidate of candidatesForPlatform()) {
    if (!which(candidate.cmd, envPath)) continue;
    const ok = await tryCommand(candidate, text, env);
    if (ok) {
      return { kind: "ok", method: candidate.method };
    }
  }
  // 退化：写文件。dataDir 缺省 = cwd；多数 shell 可 cat 粘贴。
  const fallbackPath = options.dataDir
    ? join(options.dataDir, "last_copy.txt")
    : join(process.cwd(), "last_copy.txt");
  try {
    await writeFile(fallbackPath, text, "utf8");
    return {
      kind: "fallback",
      path: fallbackPath,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
