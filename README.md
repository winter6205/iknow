# iknow

Local **coding agent** for a tool-calling LLM: a loop engine, sandboxed tools, and three surfaces (CLI, TUI, web) on the same runtime.

iknow can read and edit a workspace, run shell commands under a sandbox, search the repo, talk to LSP servers, load skills and MCP tools, spawn subagents, and treat **verification** (tests / evidence) as the completion signal — not the model saying it is done.

> Built from scratch; design informed by the coding-agent landscape (Claude Code and peers). Not affiliated with or endorsed by Anthropic.

## Features

- **Harness** — ReAct loop with explicit stop reasons, permission checks per tool call, context compression, and a verify loop
- **Tools** — bash (foreground + background, same bwrap fence), filesystem, grep/glob, web fetch/search, LSP, skills, MCP, memory, subagents
- **Parallel tools** — consecutive `isConcurrencySafe` calls overlap in one turn; unsafe calls stay serial
- **Surfaces** — interactive `chat`, OpenTUI `tui`, one-shot `ask` (JSON for scripts), `serve` (Session HTTP + Vite SPA + trace panel), `trace` (JSONL trace inspection)
- **Instruction channels** — outbound projection separates sources: tool results can't impersonate host frames, and subagent constitutions stay code-locked

## Requirements

- Node.js >= 20 and npm (`chat` / `ask` / `serve` / `trace` run on Node)
- [Bun](https://bun.sh) on your PATH for the TUI (`tui` re-execs the same CLI file under Bun when launched from Node) and for the TUI test slice of `npm test`
- `bwrap` (bubblewrap, >= 0.11.1) for sandboxed shell execution: the bash tool probes `bwrap --version` and fails with an install hint when it is missing
- Platform status: the TUI is verified on Linux/WSL2; macOS/Windows are unverified

## Setup (from source)

iknow is not published to npm yet — install from a clone:

```bash
npm install
cp .env.example .env.local        # optional env layer for ${VAR} placeholders; never commit
npm test
```

LLM configuration (model + key) lives in exactly one place: the user-layer `~/.iknow/settings.json` (`llm.model`, `llm.apiKey` as a literal or a `${VAR}` placeholder resolved from `.env.local`). See [`docs/llm-config-quickstart.md`](docs/llm-config-quickstart.md).

## Usage

```bash
npx tsx src/cli.ts -h

npx tsx src/cli.ts              # TTY -> chat
npx tsx src/cli.ts chat         # interactive REPL
npx tsx src/cli.ts ask "..."    # one-shot, JSON output for scripts
npx tsx src/cli.ts tui          # OpenTUI multi-session terminal UI (needs Bun)
npx tsx src/cli.ts serve        # http://127.0.0.1:8787  (API + SPA + /trace)
npx tsx src/cli.ts trace        # probes serve health, prints the /trace URL
```

On a TTY, bare invocation opens chat; piped / non-TTY with no args prints usage. The workspace root defaults to the launch cwd and can be overridden with `--workspace-root <dir>`; project settings (`.iknow/settings.json`, `.env.local`) are read from the launch cwd.

`package.json` declares an `iknow` bin pointing at `dist/cli.js` (produced by `npm run build`); it is meant for a future npm release and is not wired up as a global install yet.

## Search engine (ripgrep, from the lockfile)

The grep/glob tools run on a pinned ripgrep binary that arrives with the dependencies: `@vscode/ripgrep` carries a prebuilt `rg` per platform as its own `optionalDependencies`, so `npm install` / `npm ci` provisions the engine for the machine it runs on. There is no download step and no committed binary.

When the engine is unavailable (e.g. the per-platform package was skipped), grep falls back to a built-in Node scan; the fallback walks files with JavaScript RegExp and may answer differently from ripgrep.

## Sandbox

The bash tool executes commands inside a bwrap fence: read-only system mounts, tmpfs, a cleared environment, and constant network isolation (`--unshare-net` — there is no direct host-network mode). Outbound HTTP is a separate opt-in egress proxy seam (settings `isolation.network`): sandbox traffic is relayed over a unix socket to a host-side proxy, and a relay failure runs the command under plain isolation fail-closed instead of silently granting access. Foreground and background commands share the same fence parameters.

## Layout

| Path               | Role                                                |
| ------------------ | --------------------------------------------------- |
| `src/harness/`     | Loop, adapter, executor, ACI tools, sandbox, verify |
| `src/cli/`         | `chat` / `ask` / `serve` / `tui` / `trace` entry    |
| `src/tui/`         | OpenTUI terminal UI                                 |
| `src/session-api/` | HTTP sessions + static SPA                          |
| `src/traceserver/` | Read-only trace inspection (JSONL query API)        |
| `web/`             | Vite React console (`web/dist` served by `serve`)   |
| `specs/`           | Live module specs ([index](specs/README.md))        |
| `docs/`            | Architecture, ADRs, guides, status                  |

## Documentation

| Doc                                                                          | What it is                                     |
| ---------------------------------------------------------------------------- | ---------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)                               | Runtime modules                                |
| [`docs/STATUS.md`](docs/STATUS.md)                                           | What ships vs what does not                    |
| [`docs/llm-config-quickstart.md`](docs/llm-config-quickstart.md)             | Provider / model / key configuration           |
| [`docs/guides/user-hooks.md`](docs/guides/user-hooks.md)                     | Declared deny-only hooks (`settings.hooks`)    |
| [`docs/guides/prompt-development.md`](docs/guides/prompt-development.md)     | Prompt development guide                       |
| [`docs/guides/skill-authoring.md`](docs/guides/skill-authoring.md)           | Skill author contract (body vs `references/`)  |
| [`docs/trace-mcp-server.md`](docs/trace-mcp-server.md)                       | Trace MCP read server (`iknow-trace-mcp` bin)  |
| [`docs/coding-agent-capability-gap.md`](docs/coding-agent-capability-gap.md) | Honest gap list vs a full coding-agent harness |
| [`specs/README.md`](specs/README.md)                                         | Active specs index                             |
| [`docs/adr/`](docs/adr/)                                                     | Architecture decisions                         |
| [`CHANGELOG.md`](CHANGELOG.md)                                               | Version history                                |

## License

MIT — see [LICENSE](LICENSE).
