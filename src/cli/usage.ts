/**
 * CLI usage / version strings (stdout).
 * Bilingual (Chinese + English) product help for humans and scripts.
 */
import { readPackageVersion } from "../shared/package-version.js";

/**
 * Resolve package version from package.json; fall back to 0.1.0.
 * Delegates to the shared reader so the CLI and the standalone trace shell
 * report the same version (and same fallback) for the same process.
 */
export function getVersion(): string {
  return readPackageVersion();
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
  iknow tui [session-id] [--auto-mode] [--yolo] 终端多会话交互界面（需 Bun）/ multi-session TUI (needs Bun on PATH)
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
  --workspace-root <dir>        per-root 状态根目录（settings 写回 / worktrees），默认 process.cwd()
                                / per-root state root (settings writeback / worktrees), default process.cwd()
  --max-bytes <n>               trace 单次读取字节上限，默认 8 MiB / trace read cap (default 8 MiB)
  --no-open                     trace 不自动打开浏览器（CI/headless）/ trace: do not auto-open browser (CI/headless)
  --separate                    trace 保留独立检测进程（#183 旧行为，端口 24881）
                                / trace: keep standalone inspection process (#183 behavior, port 24881)
  --auto-mode                   tui 启动即 full_auto（跳过工具 ask）/ tui starts in full_auto (skip tool asks)
                                \`iknow tui --auto-mode\`（iknow 仓库根也可 npm run dev:tui -- --auto-mode）
                                / \`iknow tui --auto-mode\` (or npm run dev:tui -- --auto-mode at the iknow repo root)
  --yolo                        仅 tui：无沙箱模式（bwrap 围栏整体退场，网络与文件系统不限）
                                / tui only: no-sandbox mode (the bwrap fence is retired entirely)
                                不落盘（不进 settings / session 文件）；会话内切换（/yolo）需确认
                                / not persisted; the in-session /yolo toggle asks for confirmation
                                chat / serve / ask / oneshot / trace 携带 → 报错并非零退出、不启动
                                / rejected with a typed error (non-zero exit) for those five commands
  --eval-state                  仅 ask / oneshot：ADR-0130 评测态（围栏整体退场、不落盘、无需 TUI）
                                / ask / oneshot only: ADR-0130 eval state — the bwrap fence retires
                                entirely, and the posture is never persisted (per-invocation only)
                                权限 full_auto + fs 档 global；hard-wall 与 taskRoot 写目标不随之退场
                                / permission full_auto, fs tier global; the hard-wall and the live
                                taskRoot write target do not retire with the fence
                                chat / serve / trace / tui 携带，或与 --resume 同给 → 报错并非零退出、不启动
                                / rejected with a typed error (non-zero exit) on those entries, or when
                                combined with --resume; ask 的 JSON 以 runState="eval_state" 标明本态
                                / the ask JSON artifact names its own state (runState="eval_state")

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
  • trace 属会话命令，--yolo 与其不兼容（仅 tui 可达）→ 报错并非零退出、不启动
    / trace is a session command: --yolo is incompatible (tui only) and is rejected
• trace --separate 保留独立进程读 ./trace/ 目录（/api/v1/traces + /fields + /health）；
    写侧由 serve/chat/ask 的 --trace-out 负责；检测到旧 ./trace.jsonl 需先跑迁移脚本
    / trace --separate keeps the standalone reader on ./trace/;
    if an old ./trace.jsonl exists, run npx tsx scripts/trace-migrate.ts first
  • tui 需要 PATH 上有 Bun（OpenTUI 原生 FFI 仅 Bun 支持）。任意项目直接 \`iknow tui\`：Node 启动会自动改用 Bun 重跑同一 CLI，cwd 不变（workspace 默认 cwd，ADR-0019）。
    / tui needs Bun on PATH: run \`iknow tui\` from any project — a Node launch re-execs the same CLI under Bun with the cwd preserved (workspace = cwd, ADR-0019).
    \`npm run dev:tui\` 只在 iknow 仓库根有效 / only valid at the iknow repo root.
  • tui 与 serve 共享 ~/.iknow 会话池；tui 内 /help 看 slash 词表 / tui shares the pool
  • 管道可设 IKNOW_CHAT_QUIET=1 关闭 turn 标记 / pipe: IKNOW_CHAT_QUIET=1 quiet markers`;
}

/** Print usage to stdout. */
export function printUsage(): void {
  process.stdout.write(`${usageText()}\n`);
}

/** Fallback intercept message for when Node runs `tui` but PATH has no Bun. cliFile = absolute path of this process's CLI entry. */
export function tuiNodeInterceptMessage(cliFile: string): string {
  return (
    `未找到 Bun，TUI 未启动（OpenTUI 原生 FFI 仅 Bun 支持；当前进程是 Node）。\n` +
    `安装 Bun（https://bun.sh）后，任意项目直接 \`iknow tui\` 即可（Node 会自动用 Bun 重跑）。\n` +
    `chat / ask / serve 仍可用 Node。\n` +
    `\n` +
    `或现在手动执行（在目标项目目录，workspace 默认 cwd）：\n` +
    `  bun ${JSON.stringify(cliFile)} tui\n` +
    `\n` +
    `仅 iknow 仓库根才有 npm run dev:tui。\n`
  );
}
