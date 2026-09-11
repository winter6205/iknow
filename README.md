# iknow

Local **coding agent** for a tool-calling LLM: a loop engine, sandboxed tools, and three surfaces (CLI, TUI, web) on the same runtime.

iknow can read and edit a workspace, run shell commands under a sandbox, search the repo, talk to LSP servers, load skills and MCP tools, spawn subagents, and treat **verification** (tests / evidence) as the completion signal—not the model saying it is done.

## Features

- **Harness** — ReAct loop with explicit stop reasons, permission checks per tool call, context compression, and a verify loop
- **Tools** — bash (foreground + background, same bwrap fence), filesystem, grep/glob, web fetch/search, LSP, skills, MCP, memory, subagents
- **Parallel tools** — consecutive `isConcurrencySafe` calls overlap in one turn; unsafe calls stay serial
- **Surfaces** — interactive `chat`, OpenTUI `tui`, one-shot `ask` (JSON for scripts), `serve` (Session HTTP + Vite SPA + trace panel)

## Requirements

- Node.js >= 20 and npm
- TUI: [Bun](https://bun.sh) (OpenTUI native bindings)

## Setup

```bash
npm install
cp docs/integration-materials.env.example .env.local   # fill secrets; do not commit
# LLM model + apiKey: ~/.iknow/settings.json  (see docs/llm-config-quickstart.md)
npm test
```

## Usage

```bash
npx tsx src/cli.ts -h

npx tsx src/cli.ts              # TTY → chat
npx tsx src/cli.ts chat
npx tsx src/cli.ts ask "…"      # one-shot JSON
npx tsx src/cli.ts tui          # needs Bun: npm run dev:tui
npx tsx src/cli.ts serve        # http://127.0.0.1:8787  (API + SPA + /trace)
```

On a TTY, bare `iknow` opens chat. Piped / non-TTY with no args prints usage.

Configure the model in `settings.json` (`llm.model`, `llm.apiKey` as a literal or `${VAR}`). Details: [`docs/llm-config-quickstart.md`](docs/llm-config-quickstart.md).

## Layout

| Path               | Role                                                |
| ------------------ | --------------------------------------------------- |
| `src/harness/`     | Loop, adapter, executor, ACI tools, sandbox, verify |
| `src/cli/`         | `chat` / `ask` / `serve` / `tui` entry              |
| `src/tui/`         | OpenTUI UI                                          |
| `src/session-api/` | HTTP sessions + static SPA                          |
| `web/`             | Vite React console (`web/dist` served by `serve`)   |
| `specs/`           | Live module specs ([index](specs/README.md))        |
| `docs/`            | Architecture, ADRs, status                          |

## Documentation

| Doc                                                                          | What it is                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)                               | Runtime modules                               |
| [`docs/guides/user-hooks.md`](docs/guides/user-hooks.md)                     | Declared deny-only hooks (`settings.hooks`)   |
| [`docs/guides/prompt-development.md`](docs/guides/prompt-development.md)     | Prompt development guide                      |
| [`docs/guides/skill-authoring.md`](docs/guides/skill-authoring.md)           | Skill author contract (body vs `references/`) |
| [`docs/STATUS.md`](docs/STATUS.md)                                           | What ships vs what does not                   |
| [`docs/coding-agent-capability-gap.md`](docs/coding-agent-capability-gap.md) | Gap vs a full coding-agent harness            |
| [`specs/README.md`](specs/README.md)                                         | Active specs only                             |
| [`CHANGELOG.md`](CHANGELOG.md)                                               | Version history                               |
| [`docs/adr/`](docs/adr/)                                                     | Architecture decisions                        |

Historical rewrite notes (upstream mapping, vector retrieval, unused prototypes) live under [`docs/archive/`](docs/archive/), not in the live index.

## License

MIT
