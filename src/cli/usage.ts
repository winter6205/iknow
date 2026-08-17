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
  iknow serve [options]         HTTP 会话 API + Web UI + trace 面板(/trace) / session API + web UI + trace panel
  iknow trace [options]         打开 trace 面板（探测 serve）/ open trace panel (probes serve)
  iknow tui [session-id]        终端多会话交互界面 / multi-session TUI (banners/lists/slash)
  iknow ask "<query>" [options] 单次 JSON 回答（脚本/CI）/ one-shot JSON (scripts/CI)
  iknow "<query>" [options]     同上（兼容写法）/ same as ask (compat)
  iknow -h | --help             显示本帮助 / show this help
  iknow -V | --version          打印版本 / print version

选项 / Options:
  --json                        聊天开始即用 JSON 输出 / chat starts with JSON answers
  --port <n>                    serve 监听端口（默认 8787）；trace 默认探测 8787、--separate 用 24881
                                / serve port (default 8787); trace probes 8787, --separate uses 24881
  --host <addr>                 serve/trace 绑定地址，默认 127.0.0.1
                                / serve/trace host (default 127.0.0.1)
  --data-dir <dir>              会话池根目录，默认 ~/.iknow / session pool root (default ~/.iknow)
  --workspace-root <dir>        per-root 状态根目录（identity/memory/serve），默认 process.cwd()
                                / per-root state root (identity/memory/serve), default process.cwd()
  --max-bytes <n>               trace 单次读取字节上限，默认 8 MiB / trace read cap (default 8 MiB)
  --no-open                     trace 不自动打开浏览器（CI/headless）/ trace: do not auto-open browser (CI/headless)
  --separate                    trace 保留独立检测进程（#183 旧行为，端口 24881）
                                / trace: keep standalone inspection process (#183 behavior, port 24881)

会话内命令 / In-chat commands:
  /help  /status  /quit  /json on|off  /reset

说明 / Notes:
  • TTY 无参数 → chat；管道/非 TTY 无参数 → 用法 / no args: TTY→chat, piped→usage
  • 空 ask/query → 用法 + exit 1（无默认 demo 问句）/ empty ask → usage + exit 1
  • ask 输出 JSON；chat 默认人类可读 / ask→JSON, chat→human view
  • serve 打开 http://host:port/ ；API 见 src/session-api/contract.ts；trace 面板在 /trace
• trace 默认探测 iknow serve（--host/--port 指定目标）后打开 /trace 面板并自动开浏览器
    （--no-open 关闭）；检测不到 serve → exit 1 提示先起 serve 或 --separate
    / trace probes iknow serve then opens /trace (auto browser; --no-open disables);
    no serve → exit 1, start serve first or use --separate
• trace --separate 保留独立进程读 ./trace/ 目录（/api/v1/traces + /fields + /health）；
    写侧由 serve/chat/ask 的 --trace-out 负责；检测到旧 ./trace.jsonl 需先跑迁移脚本
    / trace --separate keeps the standalone reader on ./trace/;
    if an old ./trace.jsonl exists, run npx tsx scripts/trace-migrate.ts first
  • tui 与 serve 共享 ~/.iknow 会话池；tui 内 /help 看 slash 词表 / tui shares the pool
  • 管道可设 IKNOW_CHAT_QUIET=1 关闭 turn 标记 / pipe: IKNOW_CHAT_QUIET=1 quiet markers`;
}

/** Print usage to stdout. */
export function printUsage(): void {
  process.stdout.write(`${usageText()}\n`);
}
