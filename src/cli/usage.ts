/**
 * CLI usage / version strings (stdout).
 * English product help for humans and scripts.
 *
 * The text is data, not prose: one row per published fact inside the four
 * sections, aligned by a single computed column so a row never hand-pads itself.
 * Every flag the parser's scan chain recognizes must appear here —
 * `tests/cli/parse-args-eval-state.test.ts` derives that coverage from the source
 * rather than from this file's wording, so a flag can be added but not hidden.
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

/** A published fact: the label column, then what it means. */
type UsageRow = readonly [label: string, text: string];

/**
 * One shared column width per table: the widest label sets it, so renaming or
 * adding an entry moves its own row and no other row's padding.
 */
function alignRows(rows: ReadonlyArray<UsageRow>): string {
  const width = rows.reduce(
    (max, [label]) => Math.max(max, label.length),
    "  ".length
  );
  return rows
    .map(([label, text]) => `  ${label.padEnd(width)}  ${text}`)
    .join("\n");
}

const USAGE_ROWS: ReadonlyArray<UsageRow> = [
  [
    "iknow [options]",
    "TTY: start the TUI in default mode; without a TTY: print this usage",
  ],
  [
    'iknow "<query>" [options]',
    "one-shot answer from the query (compat form of iknow ask)",
  ],
  [
    "iknow <command> [options]",
    "run one entry directly: chat / serve / trace / tui / ask / help",
  ],
  ["iknow -h | --help", "show this help"],
  ["iknow -V | --version", "print the version"],
];

const COMMAND_ROWS: ReadonlyArray<UsageRow> = [
  [
    "iknow chat [options]",
    "interactive chat REPL on a TTY, serial piped turns otherwise; --json starts with JSON answers",
  ],
  [
    "iknow chat --resume <id>",
    "continue an existing conversation in the chat REPL",
  ],
  [
    'iknow ask "<query>" [options]',
    "one-shot JSON answer (scripts / CI); names runState when run in eval state",
  ],
  [
    "iknow serve [options]",
    "HTTP session API + web UI, with the trace panel at /trace",
  ],
  [
    "iknow trace [options]",
    "open the trace panel (probes a running iknow serve first)",
  ],
  [
    "iknow tui [session-id] [--auto-mode] [--yolo] [--no-sandbox]",
    "multi-session terminal UI (needs Bun on PATH); a positional session-id resumes that session directly",
  ],
  ["iknow help", "show this help"],
];

const OPTION_ROWS: ReadonlyArray<UsageRow> = [
  [
    "--json",
    "chat: start with JSON answers; on a bare TTY invocation it selects the chat route; on `iknow tui` it is a typed refusal (use iknow chat --json)",
  ],
  [
    "--port <n>",
    "serve listen port (default 8787); trace probes 8787, --separate uses 24881",
  ],
  ["--host <addr>", "serve / trace bind address (default 127.0.0.1)"],
  ["--data-dir <dir>", "session pool root (default ~/.iknow)"],
  [
    "--workspace-root <dir>",
    "per-root state root (settings writeback / worktrees); default process.cwd()",
  ],
  ["--max-bytes <n>", "trace read cap in bytes (default 8 MiB)"],
  [
    "--max-turns <n>",
    "per-run loop turn cap for chat / ask / oneshot / tui (default unlimited); an explicit value wins over settings, and one run's cap is not the session's budget",
  ],
  [
    "--resume <id>",
    "chat: resume conversation <id> (iknow chat --resume <id>, or a bare --resume <id> on a TTY); the TUI resumes through the positional form `iknow tui <session-id>`, so `iknow tui --resume <id>` is a typed refusal; never combined with --eval-state",
  ],
  [
    "--trace-out <path>",
    "trace output directory for ask / serve / tui (default ./trace/)",
  ],
  ["--no-open", "trace: do not auto-open the browser (CI / headless)"],
  ["--separate", "trace: keep the standalone reader process (port 24881)"],
  [
    "--auto-mode",
    "tui only: start in full_auto (skip tool asks). A TUI posture: a bare launch that `--json` / `--resume <id>` routes to the chat REPL is a typed conflict, not a drop; on any other non-TUI head it is parsed and unused",
  ],
  [
    "--yolo",
    "tui only: the yolo preset — the bwrap fence retires entirely (network and filesystem unrestricted), the filesystem tier goes global AND the permission mode goes full_auto. Never persisted into settings or a session file; the in-session /yolo toggle asks for confirmation. chat / serve / ask / oneshot / trace carrying it get a typed non-zero exit and start nothing",
  ],
  [
    "--no-sandbox",
    "tui only: retires the bwrap fence for this session and sets the filesystem tier to global, WITHOUT touching the permission mode — no fence, questions still on; this is the one difference from --yolo, which also sets full_auto. Never persisted. chat / serve / ask / oneshot / trace carrying it get a typed non-zero exit and start nothing",
  ],
  [
    "--eval-state",
    "ask / oneshot only: ADR-0130 eval state — applies the yolo preset declaratively for one invocation (fence retired, permission full_auto, fs tier global) with no exit path, since an eval run's posture ends with the process. Not persisted. chat / serve / trace / tui carrying it, or combining it with --resume, get a typed non-zero exit",
  ],
];

const NOTE_ROWS: ReadonlyArray<string> = [
  'Routing: a bare `iknow` on a TTY starts the TUI; the same invocation without a TTY prints this usage and starts nothing; `iknow "<query>"` is a one-shot run.',
  "A bare `--yolo`, `--no-sandbox` or `--auto-mode` on a TTY starts that same TUI holding the posture. `--no-sandbox` is the fence axis only: it never answers permission asks for you; `--yolo` answers them.",
  "Neither preset is guardrail-free: the hard-wall still intercepts, writes still resolve against the live taskRoot, and neither is persisted. Refused outright when the process is running as root.",
  "A bare `--json` or `--resume <id>` on a TTY keeps the chat route, so `iknow chat --resume <id>` and the bare form resume the same conversation.",
  "A bare launch routed to chat by `--json` / `--resume <id>` and also carrying a TUI-only posture (`--auto-mode`) is refused as a typed conflict, because honoring one request would silently discard the other.",
  "The same rule runs the other way: `iknow tui --json` and `iknow tui --resume <id>` are refused with a non-zero exit before any session starts, and each refusal names the supported form (`iknow chat --json` / `iknow tui <session-id>`).",
  "A bare `--eval-state` prints this usage on either TTY state: a display path starts no session, so showing the flag is not an eval-state execution.",
  'ask / oneshot is the headless eval entry, and `--eval-state` never routes an evaluation request to a TUI; its ask JSON names its own state (runState="eval_state").',
  "Neither `--yolo` nor `--eval-state` is guardrail-free: the hard-wall still intercepts before full_auto, writes still resolve against the live taskRoot, and neither posture is persisted.",
  "The workspace root defaults to the current directory (ADR-0019); `--workspace-root <dir>` overrides it.",
  "The TUI needs Bun on PATH (OpenTUI native FFI). Any project can run it: a Node launch re-execs this same CLI under Bun with the cwd preserved, so the workspace default survives the handoff. `npm run dev:tui` is valid only at the iknow repo root.",
  "A bare TTY launch carrying no TUI-only posture falls back to the chat REPL when Bun is missing, with one notice on stderr. A launch carrying `--yolo` or `--auto-mode`, and an explicit `iknow tui`, fail loudly with a non-zero exit instead of quietly starting a session without the posture.",
  "trace is a session command: --yolo is incompatible with it (tui only) and is refused with a typed non-zero exit.",
  "trace probes a running `iknow serve` (--host / --port) and then opens /trace in the browser; --no-open disables that. With no serve detected it exits 1 — start serve first, or use --separate to keep the standalone reader on ./trace/ (/api/v1/traces + /fields + /health). If an old ./trace.jsonl exists, run npx tsx scripts/trace-migrate.ts first.",
  "serve exposes the session API and the trace panel at /trace; the contract lives in src/session-api/contract.ts.",
  "An empty `ask` / query prints this usage and exits 1 (no default demo query).",
  "ask prints JSON; chat prints the human view. Piped chat: IKNOW_CHAT_QUIET=1 drops the turn markers.",
  "tui and serve share the ~/.iknow session pool; the TUI's /help lists its slash commands.",
  "In-chat commands: /help /status /quit /json on|off /reset",
];

/** Full usage text (no trailing newline required by caller). */
export function usageText(): string {
  const v = getVersion();
  return [
    `iknow ${v} — tool-calling agent runtime`,
    "",
    "Usage:",
    alignRows(USAGE_ROWS),
    "",
    "Options:",
    alignRows(OPTION_ROWS),
    "",
    "Commands:",
    alignRows(COMMAND_ROWS),
    "",
    "Notes:",
    NOTE_ROWS.map((note) => `  • ${note}`).join("\n"),
  ].join("\n");
}

/** Print usage to stdout. */
export function printUsage(): void {
  process.stdout.write(`${usageText()}\n`);
}

/**
 * Fallback intercept message for when Node runs `tui` but PATH has no Bun.
 * cliFile = absolute path of this process's CLI entry.
 *
 * Reached only by a launch that asked for the TUI on its own (an explicit `tui`
 * head, or a bare TTY launch carrying a TUI-only posture): an ordinary bare
 * launch falls back to chat instead, so this copy must not read as a general
 * "the terminal UI is unavailable" notice.
 */
export function tuiNodeInterceptMessage(cliFile: string): string {
  return (
    `Bun not found, so the TUI did not start (OpenTUI's native FFI needs Bun; this process is Node).\n` +
    `Install Bun (https://bun.sh) and \`iknow tui\` works from any project: a Node launch re-execs this same CLI file under Bun with the cwd preserved.\n` +
    `chat / ask / serve keep running on Node, and a plain \`iknow\` on a TTY falls back to the chat REPL by itself.\n` +
    `\n` +
    `This launch asked for the TUI explicitly (iknow tui, or a bare --yolo / --auto-mode), so it stops here rather than starting a session without that posture.\n` +
    `Or run it by hand now, in the target project directory (workspace defaults to cwd):\n` +
    `  bun ${JSON.stringify(cliFile)} tui\n` +
    `\n` +
    `npm run dev:tui exists only at the iknow repo root.\n`
  );
}
