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
  iknow ask "<query>" [options] 单次 JSON 回答（脚本/CI）/ one-shot JSON (scripts/CI)
  iknow "<query>" [options]     同上（兼容写法）/ same as ask (compat)
  iknow -h | --help             显示本帮助 / show this help
  iknow -V | --version          打印版本 / print version

选项 / Options:
  --mode deterministic|llm      Agent 模式（默认 deterministic；可被 IKNOW_AGENT_MODE 覆盖）
                                Agent mode (default: deterministic; env may upgrade)
  --role employee|manager|admin 调用角色（默认 employee）/ caller role (default: employee)
  --embeddings                  启用向量检索臂 / enable embedding vector arm
  --json                        聊天开始即用 JSON 输出 / chat starts with JSON answers
  --governance-timeout          模拟治理超时降级路径 / simulate governance timeout degrade

会话内命令 / In-chat commands:
  /help  /status  /quit  /json on|off  /role <r>  /mode <m>  /reset

说明 / Notes:
  • 主入口：TTY 上无参数 → chat；管道/非 TTY 无参数 → 打印用法
    Primary: no args on TTY → chat; no args when piped → usage
  • 显式 --mode 优先于 IKNOW_AGENT_MODE / Explicit --mode always wins over env
  • ask / 裸查询 空文本 → 打印用法并以退出码 1 结束（无默认 demo 问句）
    Empty ask/query → usage + exit 1 (no default demo query)
  • 单次 ask 始终 stdout 输出 G2 JSON；chat 默认人类可读视图
    One-shot always prints G2 JSON on stdout; chat human view is default
  • 管道 chat 可设 IKNOW_CHAT_QUIET=1 关闭 turn 标记（无「思考中」噪音）
    Piped chat: IKNOW_CHAT_QUIET=1 suppresses turn markers (no thinking spam)`;
}

/** Print usage to stdout. */
export function printUsage(): void {
  process.stdout.write(`${usageText()}\n`);
}
