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
  return `iknow ${v} — 工具调用 Agent 运行时 / tool-calling agent runtime

用法 / Usage:
  iknow                         交互对话（仅 TTY）/ interactive chat (TTY only)
  iknow chat [options]          会话：TTY REPL 或按行管道 / chat (TTY REPL or piped lines)
  iknow serve [options]         HTTP 会话 API + Web UI / session API + web UI
  iknow trace [options]         独立 trace 检测面板 / standalone trace inspection (read-only)
  iknow tui [session-id]        终端多会话交互界面 / multi-session TUI (banners/lists/slash)
  iknow ask "<query>" [options] 单次 JSON 回答（脚本/CI）/ one-shot JSON (scripts/CI)
  iknow "<query>" [options]     同上（兼容写法）/ same as ask (compat)
  iknow -h | --help             显示本帮助 / show this help
  iknow -V | --version          打印版本 / print version

选项 / Options:
  --json                        聊天开始即用 JSON 输出 / chat starts with JSON answers
  --port <n>                    serve/trace 监听端口，serve 默认 8787 / trace 默认 24881
                                / serve/trace port (default serve=8787, trace=24881)
  --host <addr>                 serve/trace 绑定地址，默认 127.0.0.1
                                / serve/trace host (default 127.0.0.1)
  --data-dir <dir>              会话池根目录，默认 ~/.iknow / session pool root (default ~/.iknow)
  --max-bytes <n>               trace 单次读取字节上限，默认 8 MiB / trace read cap (default 8 MiB)
  --no-open                     trace 不自动打开浏览器（CI/headless）/ trace: do not auto-open browser (CI/headless)

会话内命令 / In-chat commands:
  /help  /status  /quit  /json on|off  /reset

说明 / Notes:
  • TTY 无参数 → chat；管道/非 TTY 无参数 → 用法 / no args: TTY→chat, piped→usage
  • 空 ask/query → 用法 + exit 1（无默认 demo 问句）/ empty ask → usage + exit 1
  • ask 输出 JSON；chat 默认人类可读 / ask→JSON, chat→human view
  • serve 打开 http://host:port/ ；API 见 src/session-api/contract.ts
• trace 默认读 ./trace/ 目录并自动开浏览器（--no-open 关闭）；检测到旧 ./trace.jsonl 需先跑迁移脚本
    / trace defaults to ./trace/ and auto-opens the browser (--no-open disables);
    if an old ./trace.jsonl exists, run npx tsx scripts/trace-migrate.ts first
• trace 独立进程读 /api/v1/traces + /fields + /health；写侧仍由 serve/chat/ask 的 --trace-out 负责
    / trace is a separate process; serve/chat/ask still write via --trace-out
  • tui 与 serve 共享 ~/.iknow 会话池；tui 内 /help 看 slash 词表 / tui shares the pool
  • 管道可设 IKNOW_CHAT_QUIET=1 关闭 turn 标记 / pipe: IKNOW_CHAT_QUIET=1 quiet markers`;
}

/** Print usage to stdout. */
export function printUsage(): void {
  process.stdout.write(`${usageText()}\n`);
}
