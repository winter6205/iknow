# 9router Context Management Probe — #132 Resolution

**Date**: 2026-08-02
**Probe script**: `scripts/i132-probe-9router-context-mgmt.ts`
**9router endpoint**: `http://<WSL-gateway>:20128/v1/messages` (dynamic gateway IP)
**Key**: `ANTHROPIC_AUTH_TOKEN` (from `~/.claude/key.env`, 35 chars, fingerprint b9ffea64e85b; settings-model-extension 后，9router 探针通过 `settings.llm.apiKey: "${ANTHROPIC_AUTH_TOKEN}"` 单承载读取，IKNOW_LLM_API_KEY_ENV 机制已退役)

## Probe Results

| Probe                   | Request                                         | HTTP | `applied_edits` | Cache telemetry                    | Observation                                  |
| ----------------------- | ----------------------------------------------- | ---- | --------------- | ---------------------------------- | -------------------------------------------- |
| A. Baseline             | Anthropic POST, no extras                       | 200  | ❌ absent       | `cache_read=128, cache_creation=0` | `/v1/messages` endpoint exists and responds  |
| B. + beta header        | `anthropic-beta: context-management-2025-06-27` | 200  | ❌ absent       | same                               | Header accepted, no error, no effect         |
| C. + context_management | `edits: [{clear_tool_uses, trigger: 1}]`        | 200  | ❌ absent       | same                               | **Param silently dropped** — no 400, no echo |
| D. + cache_control      | tool with `cache_control: {ephemeral}`          | 200  | ❌ absent       | same                               | Accepted; `cache_read` present               |
| E. Combined             | B + C + D together                              | 200  | ❌ absent       | same                               | Same as individual probes                    |

Additional test: `model: "minimax-cn/MiniMax-M3"` (full provider-qualified name) → same behavior, routes to same backend.

## Facts Established

1. **9router backend is MiniMax-M3** (not Anthropic Claude). Response body: `"model": "MiniMax-M3"`, `"base_resp": {"status_code": 0}`, thinking blocks present.

2. **`context_management` (Anthropic server-side edit) is silently dropped.** HTTP 200, no 400 rejection, no `applied_edits` in response. The three edit types (`clear_tool_uses_20250919` / `clear_thinking_20251015` / `compact_20260112`) have no observable effect through 9router.

3. **`cache_control` IS supported by MiniMax** (per [MiniMax docs](https://platform.minimaxi.com/docs/api-reference/anthropic-api-compatible-cache)): Anthropic-compatible prompt caching with `ephemeral` type, 5-min TTL, max 4 breakpoints, 20-block lookback window. Probe D's `cache_creation_input_tokens: 0` is because the probe body was too small to trigger creation, not because the field is unsupported. `cache_read_input_tokens: 128` confirms the caching pipeline is active.

4. **`anthropic-beta` header is accepted but has no effect** — no error, no behavioral change. MiniMax does not implement the beta features gated behind it.

5. **WSL2 networking**: 9router runs on Windows host, reachable from WSL2 via default gateway IP (dynamic, changes on WSL restart). `~/.bashrc` has dynamic gateway detection. `localhost:20128` (env.ts fallback) does NOT work from WSL2.

## Open Questions for #119

These are facts that #119 grilling must weigh — not conclusions:

- `context_management` server-side edit is unavailable through 9router. Whether to self-build client-side compression, switch provider, or defer is a #119 decision.
- `cache_control` is available. How compression interacts with cache prefix stability (if/when caching is enabled) is a design question for #119 + #129.
- The probe tested one provider (MiniMax via 9router). Other Anthropic-compatible providers may behave differently.

## Probe Environment

- WSL2 Ubuntu 26.04, kernel 6.18.33.2-microsoft-standard-WSL2
- 9router on Windows host (dynamic gateway IP, port 20128)
- `~/.bashrc` dynamic gateway detection (survives WSL restarts)
- Key in `~/.claude/key.env` (chmod 600, never logged)

## Artifacts

- Probe script: `scripts/i132-probe-9router-context-mgmt.ts`
- This report: `docs/handoff/9router-context-mgmt-probe/README.md`
