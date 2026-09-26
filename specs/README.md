# specs/ — live module-spec index (SSOT)

> **Index maintenance rules** (rewritten from the pre-`5ae9889a` version; the AGENTS.md pointer "active specs: `specs/README.md`" points at this file):
>
> - **New spec** → add a row under the matching topic group (one-line responsibility + basis ADR).
> - **Spec landed or superseded** → delete the row from this table (archive destination per the convention at the time; this table lists live files only).
> - Entry files (AGENTS.md / docs/STATUS.md) reference only this file; they never enumerate specs verbatim.

## Active specs

### Runtime core / sandbox

- `network-egress-allowlist.md` — egress proxy seam + domain allowlist (ADR-0097; bridging moved to ADR-0107: no host-side socat)
- `egress-preset-allowlist.md` — factory defaults list (ADR-0104; table extensions per ADR-0107)
- `egress-ssh-bridge.md` — SSH goes through the same allowlist; implementation switched to a self-contained relay, socat dependency forbidden (ADR-0107)
- `egress-credential-sentinel.md` — sentinel optional, not auto-enabled by 0107 (ADR-0105)
- `worktree-unbound-ro-bind.md` — worktree gate: physical ro-bind for unbound bash + EROFS feedback, replacing predictive interception (ADR-0109, supersedes ADR-0037 bash prediction clauses)
- `yolo-mode.md` — `--yolo` no-sandbox mode: the fence retires entirely, four-route bare argv, TUI-only entry with confirm modal (ADR-0119)
- `subagent-layers-worktree-deps.md` — subagent three layers + worktree project deps
- `subagent-model.md` — worker route is user-layer `settings.subagent.model`, else `llm.model`; per-spawn `model` is removed (#1121)

### Harness / state and transport

- `code-restore.md` — rewind can restore workspace bytes from per-write preimages on the abandoned head chain (ADR-0121; ADR-0027 / ADR-0071 / ADR-0110)
- `context-occupancy-autocompact.md` — the usage bar and the proactive compaction gate share one occupancy numerator (ADR-0118)
- `session-list-title.md` — list title: standalone transcript event + lite-model generation (ADR-0113)
- `agent-status-instruction-echo.md` — status-bar echo upgrade: verbatim `instruction:` replay segment + one-shot pivot reconcile marker (ADR-0103 amends ADR-0028; ACR PASS)
- `instruction-authority-projection.md` — instruction-authority outbound projection: host-frame stamping + untrusted translation (#1066; ADR-0112)
- `transport-continue-persist.md` — transport retry / continue / failure persist
- `interrupt-frozen-prefix-keep.md` — interrupting a model in flight keeps the frozen prefix (ADR-0108)

### TUI

- `tui-activity-block.md` — activity blocks (thinking and quiet tools share one body slot; blocks cut per message and appended)
- `tui-skill-slash-catalog.md` — TUI skill slash → harness SkillCatalog
- `tui-subagent-transcript-live.md` — live sub-agent's two lines land on the session spawn card (line content superseded by `subagent-card-title.md`; position, panel, and `subagent_result` exclusions hold)
- `subagent-card-title.md` — spawn card line 1 = required operator `title`, line 2 = one activity slot (in-flight tool name from the worker ledger → green `✓ Done`)

### IM bridge

- `im-bridge-feishu.md` — Feishu / Lark as an external consumer of the session HTTP face (ADR-0120; platform numbers in `docs/platforms/feishu-facts.md`)

### Tools and extension sources

- `251-lsp-tool.md` — LSP tool (connection-hygiene increment)
- `skill-index-increment.md` — incremental skill model index + human-side slash unification (ADR-0098)
- `frontmatter-shared-parser.md` — one shared frontmatter module (yaml-backed) replacing four hand-rolled parsers; memory newline guard; `when_to_use` signal (ADR-0123)
- `memory-frontmatter-write-signals.md` — memory write-side signals: serializer refuses non-scalar extras, structured store `skipped` diagnostics (#1137; resolves ADR-0123 accepted residuals)
- `read-image-vision.md` — read images at paths inside the fence, delivered to Anthropic vision via `tool_result` (ACR PASS)
