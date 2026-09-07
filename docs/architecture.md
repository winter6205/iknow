# Architecture — iknow (standalone)

iknow is a local **coding-agent harness**: loop engine + Anthropic-compatible adapter + ACI tool set. Runtime code lives under `src/`. Live design truth is `specs/README.md` plus `docs/adr/`.

## Capability modules

| Module               | Path                            | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness (Foundation) | `src/harness/`                  | Loop Engine + Anthropic adapter + Executor + Registry + ACI decor layer (`src/harness/aci/`); CLI product path runs through `buildHarnessEngine` (module specs under `specs/`, live index: `specs/README.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Config               | `src/config/`                   | `.env`+`process.env` loading (base `http://localhost:20128/v1` 仍为代码默认 via `IKNOW_LLM_BASE_URL`); LLM 配置收敛到 `settings.json` 单承载（`settings.llm.model` 字面值 / `settings.llm.apiKey` 字面或 `${VAR}` 占位符经 `expandPlaceholders` 解析；ADR-0015 settings-model-extension）。`IKNOW_LLM_API_KEY_ENV` / `IKNOW_LLM_MODEL` 已退役。`workspace-root` resolver (`src/config/workspace-root.ts`) — per-root state anchor (CLI `--workspace-root <dir>` / env `IKNOW_WORKSPACE_ROOT` / default `process.cwd()`); priority chain `[explicit, env, cwd]`; 4 typed-error 判别联合 mirror `IknowIdentityError`; per-root consumers = memory dir / serve data dir / settings 写回 fallback target（不含 `user.md` / `BOOTSTRAP.md` / identity seed — 那些跟 `home`，issue #584）；global anchor `home` 仍由 `settings.json` merge fallback + user-level memory global scope + `~/.iknow/init.sh` host-init (D1.2) + 全局画像；ADR-0019，D1.4 由 #584 收回。 |
| Shared               | `src/shared/`                   | Schema (`SessionContext`), errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| CLI / entry          | `src/cli.ts`, `src/index.ts`    | Dev/ask + `chat` REPL + `serve` + `trace` + `tui` entrypoints; `iknow trace` 默认探测 `iknow serve` health → 打印 `/trace` URL（`--separate` escape hatch 保留独立进程 24881，ADR-0020）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Session HTTP         | `src/session-api/`              | Multi-conversation hub + node:http API; static root prefers `web/dist`; 同进程挂载 trace 读侧路由子树 `/api/v1/traces/*` + `/trace` SPA（ADR-0020，`createTraceRouter` 工厂注入 + `serveStaticRequest({stripPrefix})`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Trace inspection     | `src/traceserver/`              | Read-side mount in `iknow serve` (ADR-0020): read-only JSONL trace query — `GET /api/v1/traces` (filter + paginate) + `/api/v1/traces/fields` + `/api/v1/traces/sessions`（独立进程 `--separate` 模式保留 `/api/v1/sessions` 旧别名一个版本）；also hosts the trace inspection panel SPA (trace.html, fallback) via shared `src/web/serve-static.ts` 挂载在 `/trace`；`src/traceserver/` 与 `src/session-api/` 保持兄弟目录（S1 bounded context，不物理合并）；field declaration table is the SSOT driving the panel columns (write side lives in `src/harness/trace/`)                                                                                                                                                                                                                                                                                                                                                                                        |
| Verify (闭环)        | `src/harness/verify/`           | 失败自动修正闭环 orchestrator / advisor (#128 D1): verify-loop 包裹 run()（仅 StopReason=completed 触发验证，沙箱执行命令，信封 append-only 注入，趋势裁判停止）；command 缺失时子代理 LLM 判官（分类器，#128 verify-classifier）接管完成度判定；settings.verify 段经 cli/serve/tui 装配注入；每轮判定落 TraceService VerificationRecord                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Memory (记忆层)      | `src/harness/memory/`           | 三层落盘记忆库 + BM25-lite 检索（ASCII + CJK 重叠 bigram，`tokenize.ts` 与 ingest 近邻共用）+ `memory_recall` / `memory_save` + promote（ADR-0009 / 0010；`ask` 全 opt-out）。**auto-memory（ADR-0031 / 0033 / 0034）**——`autoExtract` 与 `dream` 独立 boolean、**默认皆 OFF**；钩子在二者任一为 true 时装配（`auto-hook.ts`），prompt 不进 loop-engine。抽取落盘 `source: auto`（N≥2）；dream 是第二条 LLM 合并趟（`dream.ts`，`source: dream`，触发 24h ∧ 5 session，禁止进入 `gc.ts`）；都开且做梦闸到了 ingest → dream → 机械 GC。读路径：现行条短目录 + 英文纪律进 `system`（EXISTENCE_POINTER 之后，不含未 promote body）；每轮最多 5 条预取叠在用户消息（仅 `autoExtract`，host 接线，打分留在 `memory/`）；`memory_recall` 默认 10 条原文 + 英文低信任包装。SessionHub 钩子与预取 per-root；chat/serve 共用 `notifyAutoMemory`。失败 `// EXIT: log-and-continue`，不 fail 用户 turn                                                                    |
| Web UI               | `web/`                          | Vite + React + TypeScript SPA (product console); build → `web/dist`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| TUI                  | `src/tui/`                      | @opentui/react 0.5.1 (Zig native renderer; Linux/WSL2 验收, macOS/Windows 未验证; 旧 ink 归档 archive/tui-ink/) multi-session terminal UI (spec: `specs/README.md`); α direct-connects `SessionHub` (shares pool with `serve`), slash nav + 3-state session machine                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Secret roundtrip     | `src/harness/secret-roundtrip/` | 密钥占位符 / 还原表 SSOT（#406 T1）：用户文本密钥形态 → `<<<SECRET_N>>>` 占位符 → bash 还原层 spawn 前回填真值 → 输出 mask 兜底（registry 值）。`settings.secrets.mode` 控制 `roundtrip`（默认）\| `block`（legacy deny-only guard）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Hook router          | `src/harness/hooks/`            | 用户钩子同进程 router（ADR-0055 / specs/user-hook-router.md）：两车道 —— builtin lane（harness 代码装配的拦截/观测，如 secrets guard）+ user lane（声明式 deny-only，`settings.hooks.enabled` 默认关，事件 V1 仅 `PreToolUse`/`PreWrite`/`PreCommit`）。经 permission 5 步链 Step 1 挂载，先拦先赢；PreWrite 复用 isolation `classifyCall`（mutate SSOT），PreCommit 认 git commit 命令形态。与 sandbox server 无关（不起 daemon / 不 fork）。自动记忆（`settings.memory`）等产品开关与 hooks 总闸正交。                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

```text
user query
    │
    ▼
 harness (src/harness/)  ──maxTurns──►  Anthropic adapter
    │
    ├── bash (ACI; foreground runInSandbox + background spawn share one bwrap fence)
    ├── read_file / grep / glob (ACI, read-only)
    └── edit_file / write_file (ACI, write)
```

## Secret 处理（#406 roundtrip mask）

Secret 处理从三层割裂补丁收敛为**单层 roundtrip mask**（识别 → 占位符 → bash 还原 → 输出遮蔽兜底）：

- 旧：#126 时代三层互不感知的补丁——① input guard（`permission/secrets-guard.ts`，工具 input 进 sandbox 前拦截密钥形态）② sandbox env 隔离（`sandbox/env-isolation.ts`，密钥 env 白名单）③ output mask（`sandbox/output-mask.ts`，按已知值遮蔽）。三层各自补「用户贴 key 后的事故」，但 deny-only guard 让 key 真值永远到不了 bash（反人类）。
- 新（#406 默认）：`src/harness/secret-roundtrip/` 单层 spine——识别层把用户文本中的密钥形态替换为 `<<<SECRET_N>>>`（per-engine registry，in-memory）；bash 工具在 spawn 前经 `restore()` 回填真值；输出 mask 经 `currentSecretValues(registry.values())` 兜底遮蔽 registry 值。**key 真值仅在 bash 进程构造 HTTP 请求那一瞬间物理存在**。
- `settings.secrets.mode = "block"` 保留 #126 旧 deny-only guard 路径（向后兼容）；缺省 `roundtrip`。

## Design truth

| Asset                                    | Role                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| `specs/` (live index: `specs/README.md`) | Module specs still in force                                |
| `docs/adr/`                              | Architecture decisions                                     |
| `docs/archive/`                          | Landed specs/plans and historical research — not live SSOT |

## Interaction design (product surface)

Multi-turn chat / REPL is a **host-layer** concern. See:

- **`src/session-api/`** — HTTP host over the harness conversation
- **`src/cli/`** — TTY REPL + one-shot `ask` (session state in `RuntimeBundle`), slash commands
- **`npx tsx src/cli.ts chat`** — REPL; one-shot `ask` / bare query stay JSON for scripts
- **`npx tsx src/cli.ts serve`** / **`npm run serve`** — Session API + SPA static (`web/dist`)
- **`npm run dev --prefix web`** / **`npm run build --prefix web`** — Vite SPA dev / prod build

Cross-turn state lives in the harness turn loop (LLM history within `run()`)
plus a per-session `SessionContext` marker.

## serve workspace = explicit (ADR-0023, T3/T4/T5)

`iknow serve` is **unbound** by default. The serve hub MUST NOT fall back to
`process.cwd()` as the workspace root (the long-running process cwd ≠ user
project root). The hub stays unbound until the SPA Picker binds an absolute
path; until then `POST /api/v1/sessions/:id/messages` returns 400
`validation` field=`workspaceRoot`. Flag/env pre-bind via
`--workspace-root <abs>` / `IKNOW_WORKSPACE_ROOT` is opt-in explicit
(ADR-0019 D1.1 still holds for `chat` / `tui` / `ask`). Bound state writes
`workspaceRoot` onto each session file; engine
`cwd === workspaceRoot === sandboxRoot` then collapse to the same absolute
path. Trust roster lives in `<home>/.iknow/workspaces.json`; new absolute
paths require explicit `confirmTrust` on PUT (optimistic rev-CAS).

ADR-0019 (per-root state anchor) is unchanged for `chat` / `tui` / `ask`;
this ADR is the serve-surface exception. See
`docs/adr/0023-serve-workspace-explicit.md` and
`specs/serve-workspace.md` (`specs/README.md:36`).

## Non-goals

- Durable multi-tenant store
- Production auth / multi-tenant isolation
- A second tool suite beside the harness ACI set
- Model post-training / agent self-play
