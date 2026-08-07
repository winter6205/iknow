/**
 * src/tui/clipboard.ts
 *
 * 多平台复制到系统剪贴板（#237 /copy + Ctrl+Y 显示式复制路径）。
 *
 * 设计：openharness `_copy_to_clipboard` 同款 fallback 链（参照
 * upstream-openharness/src/openharness/commands/registry.py:223）。我们
 * 没有 pyperclip 依赖，因此每平台直接 spawn 一个本机剪贴板命令；按
 * `candidatesForPlatform()` 顺序遍历，找到第一个能完成写 → 命中。
 *  1. macOS pbcopy
 *  2. Linux wl-copy（Wayland）
 *  3. Linux xclip -selection clipboard（X11）
 *  4. Linux xsel --clipboard（X11 退化）
 *  5. Windows clip.exe
 *  6. 退化：写 <dataDir>/last_copy.txt
 *
 * 协议现实：DECSET 1000h 启用后，鼠标拖选不可用（本会话已有说明），
 * 故提供 `/copy` 显示式命令 + Ctrl+Y 快捷键复制最近一段 assistant
 * 全文。零 mouse 协议修改，保留键盘滚动 + 滚轮 SGR。
 *
 * 不引外部依赖：复制实现 100 行出头可控，pyperclip 倒退在 ts-paths
 * 之外、对单仓库 lockfile 还要加一依赖，违反 #237 的最小改动目标。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../harness/model-adapter/types.js";

/**
 * 提取最近的 assistant 消息的完整文本（连接其 text blocks）。
 * 会话消息中可能有 thinking / tool_result 等非 text 块；只取 text。
 * 若无 assistant 消息或全空 → 空串（调用方应 show notice 空结果）。
 */
export function extractLastAssistantText(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const text = msg.content
      .filter(
        (b): b is Extract<AnthropicContentBlock, { type: "text" }> =>
          b.type === "text"
      )
      .map((b) => b.text)
      .join(" ");
    if (text.trim().length > 0) return text;
  }
  return "";
}

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
      // detached: false → child 随父进程清理
      windowsHide: true,
      env,
    });
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
