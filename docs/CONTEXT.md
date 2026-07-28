# CONTEXT.md — Project Domain Language

> **Format**: be opinionated, pick the best word, list others under `_Avoid_`
> **Rule**: Keep definitions tight. One or two sentences max. Only project-specific terms.

## Language

**Loop Engine**: Foundation 的状态机运行内核，驱动模型 → 工具 → 真实结果 → 下一轮模型 → 明确停止；位于 `src/harness/`，并作为 018 退役旧 loop 后的可靠运行时基础。
_Avoid_: 与旧 `IknowAgent` / `LlmIknowAgent` 混同；将泛称 “agent loop” 当作本项目术语

**append-only messages**: Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加（`[...prev, x]`）更新，禁止原地修改或建立第二份权威副本。
_Avoid_: `ConversationState`（host 层多轮会话袋）；任何第二份权威历史

**turnCount**: Foundation 运行时回合计数，每完成一个 assistant 回合（包括纯文本完成）加一；`maxTurns` 是在调用模型前检查的运行时上限。
_Avoid_: `max_hops`（产品层仅计 retrieve + verify 的预算）；steps、retries

**stub model / stub tool**: Foundation 的确定性测试替身，覆盖真实模型或工具交通之外的完成、失败与停止行为；016 验 Gate A（S1–S11），017 起也验 Gate B 物理必需层（S12–S17 signal/timeout/trace），其中 `stub-signal-tool` 是 S17（ctx.signal → AbortError → execution_failed）的守门载体。不进生产装配路径。
_Avoid_: 声称已接入产品路径；mock agent、stub brain

**StopReason**: Loop Engine 的七类停止判别联合——016 五类（completed / maxTurns / nonSuccessStop / protocolError / emptyFinalResponse）末尾追加 017 两类 `cancelled`（signal abort）与 `timeout`（超时强制）；追加不重排，Transition 形状随之自动扩展。
_Avoid_: 把 cancelled 与 timeout 混为一条；把总耗时当作独立 stop 触发器

**LoopTrace** (TurnTrace / Totals): `run()` 的第二返回面 `{ result, trace }`——A 层结构元数据 trace（每回合 supplierStop / toolCall kind / durationMs / timeoutHit / signalAborted + 一次性 reduce 的 totals），严格不含 payload；与 014 messages 唯一权威解耦，immutable 累积。
_Avoid_: 在 trace 里塞 input/output/token/cost（B 层字段）；Collector 回调 / onTurn 中途观察点

**ToolExecutionContext**: Executor 透传给 handler 的执行上下文 `{ signal }`；run 第三参 signal 原样透传、不创建子 signal，超时由 Executor `Promise.race` 外包而非 ctx 携带。
_Avoid_: 在 ctx 里放 timeoutMs；为每个 handler 建子 AbortController

**在途收尾 (in-flight closeout)**: abort/timeout 发生时的收尾语义——模型在途则整回合不进历史（finalState = 入口 state）；工具在途则 assistant 回合已原子追加（不可回滚），在途 tool call 填 `execution_failed`（message 固定 "cancelled"/"timeout"），所有 tool_result 编码为一条 user message 原子追加后 stop。signal 优先于 timeout。
_Avoid_: 回滚已追加的 assistant 回合；悬空未回填的 tool call

**物理必需层 / 条件式修复层**: 017 的两层对仗边界——物理必需层（signal / timeout / trace / cancelled-timeout 停止 / 在途收尾）已实施；条件式修复层（自动重试、token-cost 护栏、trace B 层字段、工具分类超时、错误分类细化、总耗时独立 stop、OTel-span-metric 树）017 显式禁止，推迟到 018 真实接通后按 013 条件式修复原则补。
_Avoid_: 把条件式修复层提前带入 Foundation 内核

**Chunk**:
A retrievable text unit from the enterprise KB, identified and returned by `kb_retrieve` with ranking metadata.
_Avoid_: Document fragment, passage, snippet (unless speaking of UI display only)

**Fact**:
A compiled, deduplicated claim produced by `kb_compile` (content_hash–stable) for later citation and governance.
_Avoid_: Assertion, take, note, summary blob

**snapshot_id**:
An opaque governance identifier for a point-in-time KB / fact view used by `kb_governance` freshness and conflict checks.
_Avoid_: Version, tag, checkpoint, revision (unless mapping to external VCS)

**source_span**:
A precise location into source material (chunk + offsets or equivalent) that grounds a citation in `kb_verify_citation`.
_Avoid_: Quote range, highlight, bookmark

**G2**:
The agent response envelope that must carry `snapshot_id` (and citation fields when answering from KB) before return to the user.
_Avoid_: Final answer bag, response wrapper, JSON reply shell

**kb_retrieve**:
Tool that dual-arm ranks and merges candidates (keyword/overlap → RRF, k=60) into ranked Chunks for the agent loop.
_Avoid_: search, RAG query, vector lookup (alone)

**kb_verify** / **kb_verify_citation**:
Tool that pure three-state checks whether a claim is supported by a given `source_span` / chunk evidence.
_Avoid_: fact-check, NLI pass, trust score, confidence float

**kb_compile**:
Tool that turns evidence into Facts with content_hash dedup for stable reuse.
_Avoid_: summarize, extract, ingest

**kb_governance**:
Tool that checks freshness, conflicts, and stamps `snapshot_id` (B-position independent tool).
_Avoid_: ACL admin, content moderation, CMS publish

**max_hops**:
Hard budget on hop-counted tool rounds (`kb_retrieve` + `kb_verify_citation` only; default 5) before forced exit.
_Avoid_: retries, steps, turns (unless clearly UI chat turns)

**trajectory** / **trajectory_score**:
Path-quality score over tool sequence vs required/recommended tools, efficiency, and hard-gate outcome (P2 formula).
_Avoid_: accuracy alone, pass rate only, LLM-as-judge score (those are outcome/soft metrics)

**tool_calls log**:
Structured per-answer list `{ tool, args, ordinal }` for trajectory scoring; `tool_trace` is names-only compat.
_Avoid_: ts (ambiguous with timestamp), stack, audit log (unless product audit)

**release_gates**:
Named milestone targets for suite rollup (`hard_pass_rate`, `mean_trajectory`) under `SuiteAggregate.release_gates`.
_Avoid_: sprint1_gates (legacy name), CI green alone

**session_overrides**:
Eval-sample fields that configure harness session (e.g. `simulate_governance_timeout`) without hardcoding sample ids in the runner.
_Avoid_: special-case if id === "qa-edge-006" in code

**deterministic agent**:
Rule-based `IknowAgent` loop used for CI and baseline eval; no external LLM/tool_calls API.
_Avoid_: mock agent, stub brain (unless truly empty fakes)

**lexicon (eval)**:
Shared note markers and answer regexes in `src/eval/lexicon.ts` used by both loop notes and scorer.
_Avoid_: duplicated string literals in loop and score-trajectory

**ConversationState**:
Host-layer multi-turn bag: turns, `last_priors`, short `history_finals`, json_mode — not part of tool schema.
_Avoid_: SessionContext (auth only), chat memory tool, stuffing full tool transcripts into session

**prior_chunks (cross-turn)**:
Protocol bridge for the next retrieve: `{ chunk_id, summary }[]` derived from last answer spans (capped/sanitized).
_Avoid_: pasting full chunk text, unlimited host arrays, using priors on sensitive edge-001 pre-check path

**chat REPL** / **product CLI**:
TTY interactive `iknow chat` (or bare TTY invoke) with human view; pipe mode is serial non-terminal turns.
_Avoid_: treating one-shot JSON ask as the interactive product; `terminal: true` on pipes; default demo query on empty ask

**oneshot / ask**:
Script/CI path: single question → full G2 JSON on stdout; empty query → usage + exit 1.
_Avoid_: inventing a demo Chinese query when args are empty

**processChatLine**:
Pure-ish turn handler used by REPL and unit tests (slash + agent.answer + format).
_Avoid_: embedding readline/TTY side effects inside this function

**Session HTTP API** / **session-api**:
Host multi-conversation surface over `node:http` (`src/session-api/`): create/message/command/reset; every message returns full G2; not tool schema.
_Avoid_: fifth chat tool, REST wrapping of individual kb_* tools

**iknow serve**:
CLI host that runs Session API + static product UI (`web/dist` preferred, fallback `web/`).
_Avoid_: separate frontend-only server as the production path without proxying `/api`

**product SPA (web/)**:
Vite + React + TypeScript chat console; same-origin Session client; G2 side panel required.
_Avoid_: zero-dep static shell as product; dropping `snapshot_id` for “clean UI”

**parseLlmResponseJson**:
LLM body parser that accepts plain JSON or JSON followed by SSE trailer (`data: [DONE]`); client also sends `stream: false`.
_Avoid_: bare `JSON.parse(raw)` on 9router chat responses

**I4 smoke**:
Documented three-mode + HTTP interaction smoke under `docs/handoff/i4-smoke/` (no secrets in artifacts).
_Avoid_: claiming interactive product complete without I4 evidence

**NINE_ROUTER_API_KEY**:
Env name for 9router API key (via `IKNOW_LLM_API_KEY_ENV` / embedding key env defaults). Value must be the active key 9router accepts for the endpoint in use.
_Avoid_: renaming the env var for “alignment”; treating `GET /v1/models` 200 as proof that chat/embeddings will 200

## Relationships

- **Query → kb_retrieve → Chunk[]**: agent issues a retrieve hop; store returns ranked chunks
- **Chunk + claim → kb_verify_citation → three-state**: verify binds claim to `source_span`
- **Verified evidence → kb_compile → Fact**: compile emits content_hash–stable facts
- **Fact / KB view → kb_governance → snapshot_id status**: governance stamps freshness/conflict
- **Agent loop → max_hops → G2**: loop terminates with G2 envelope when done or budget exhausted
- **tool_calls log → scoreTrajectory → trajectory_score / release_gates**: suite aggregates hard + soft gates
- **session_overrides → createSession → agent run**: data-driven timeout/role without runner special cases
- **User line → processChatLine → answer(opts) → IknowAnswer → ConversationState**: multi-turn host path
- **last_priors → answer prior_chunks → kb_retrieve**: cross-turn retrieve bridge only
- **Browser → Session HTTP → ConversationState → Agent.answer → G2**: product SPA / API host path
- **chat/completions body → parseLlmResponseJson → tool_calls loop**: LLM agent path

## Flagged ambiguities

- **gbrain vs iknow runtime**: `_upstream_gbrain/` is READ-ONLY design reference; product runtime is standalone `iknow` with **zero** import/link to gbrain
- **"verify" alone**: prefer `kb_verify_citation` / `kb_verify` tool name in code; "verify" in prose means citation support check, not human QA sign-off
- **snapshot vs Snapshot (template)**: project term is `snapshot_id` (governance), not generic project backup
- **hops vs tool_calls.length**: hops only count retrieve+verify; compile/governance do not consume hop budget
- **ordinal vs ts**: log field is `ordinal` (1-based sequence); do not use `ts` for tool call order
- **draft eval set**: `eval-set.draft.json` is DRAFT-EVAL-SET; hard_pass on draft ≠ production gate until real queries replace samples
- **chat vs test harness**: product CLI is TTY/pipe-aware session code under `src/cli/`; unit tests call `processChatLine` without claiming that is the product UX
- **--mode vs env**: explicit CLI `--mode` wins over `IKNOW_AGENT_MODE`; env alone may still select llm when flag omitted
- **9router key vs endpoint**: same `NINE_ROUTER_API_KEY` can yield `models` 200 while `chat/completions` or `embeddings` return 401; agent shell env may differ from operator interactive shell
- **SSE trailer vs stream flag**: gateway may return `text/event-stream` trailer even when client requested non-stream; use `parseLlmResponseJson`, not only `stream: false`
- **turnCount vs max_hops**: `turnCount`（Foundation）统计每个已完成的 assistant 回合；`max_hops`（产品 / eval）只统计 retrieve + verify hop（默认 5）；两者属于不同层次，不得混同。
- **cancelled vs timeout**: 两条独立停止路径——cancelled 由 Loop Engine 检测 `signal.aborted`，timeout 由 adapter/executor 超时结果判定；signal 优先，不在 signal 层合并超时。
- **LoopTrace vs messages**: LoopTrace 是非权威 A 层结构元数据（不含 payload），messages 才是 014 唯一权威历史；trace 只用于诊断聚合，不得作为第二份权威副本。
- **next phase focus**: multi-turn quality / message persistence / real KB data — not reopening the 4-tool protocol; I4 smoke archived

---

## Bootstrap mode

If this file only had template examples and no real project terms, seed via:

```bash
bash scripts/bootstrap.sh --interactive
```

---

**Maintenance cadence**: monthly review per project memory rules.
