/**
 * CLI usage / version strings (stdout).
 * Bilingual (中文 + English) product help for humans and scripts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.1.0";

/** Resolve package version from package.json; fall back to 0.1.0. */
export function getVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/cli or dist/cli → repo root
    const pkgPath = join(here, "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
    return FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

/** Full usage text (no trailing newline required by caller). */
export function usageText(): string {
  const v = getVersion();
  return `iknow ${v} — 企业知识库问答 Agent / enterprise knowledge-base Q&A agent

用法 / Usage:
  iknow                         交互对话（仅 TTY）/ interactive chat (TTY only)
  iknow chat [options]          会话：TTY REPL 或按行管道 / chat (TTY REPL or piped lines)
  iknow serve [options]         HTTP 会话 API + Web UI / session API + web UI
  iknow tui [session-id]        终端多会话交互界面 / multi-session TUI (banners/lists/slash)
  iknow ask "<query>" [options] 单次 JSON 回答（脚本/CI）/ one-shot JSON (scripts/CI)
  iknow "<query>" [options]     同上（兼容写法）/ same as ask (compat)
  iknow -h | --help             显示本帮助 / show this help
  iknow -V | --version          打印版本 / print version

选项 / Options:
  --json                        聊天开始即用 JSON 输出 / chat starts with JSON answers
  --port <n>                    serve 监听端口，默认 8787 / serve port (default 8787)
  --host <addr>                 serve 绑定地址，默认 127.0.0.1 / serve host (default 127.0.0.1)
  --data-dir <dir>              会话池根目录，默认 ~/.iknow / session pool root (default ~/.iknow)

会话内命令 / In-chat commands:
  /help  /status  /quit  /json on|off  /reset

说明 / Notes:
  • TTY 无参数 → chat；管道/非 TTY 无参数 → 用法 / no args: TTY→chat, piped→usage
  • 空 ask/query → 用法 + exit 1（无默认 demo 问句）/ empty ask → usage + exit 1
  • ask 输出 G2 JSON；chat 默认人类可读 / ask→JSON, chat→human view
  • serve 打开 http://host:port/ ；API 见 docs/design/session-http-api-v0.md
  • tui 与 serve 共享 ~/.iknow 会话池；tui 内 /help 看 slash 词表 / tui shares the pool
  • 管道可设 IKNOW_CHAT_QUIET=1 关闭 turn 标记 / pipe: IKNOW_CHAT_QUIET=1 quiet markers`;
}

/** Print usage to stdout. */
export function printUsage(): void {
  process.stdout.write(`${usageText()}\n`);
}
