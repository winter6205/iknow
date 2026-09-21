# 0094. Single runtime EnvLoader source; wire model = models[].id; API errors only in the viewport

Date: 2026-09-14
Status: accepted

Amends ADR-0093. `settings.llm.model` remains the routing ID `provider/model`, used only for registry lookup (baseUrl / apiKeyEnv / headers) and the picker. The `model` on SDK requests is `models[].id` (the raw text after the first `/` in the routing ID); the provider `id` never goes on the wire. If a gateway needs a prefix, the prefix is written into the model name, not stitched together by the assembly layer. Runtime LLM env is held by one EnvLoader (mounted identically by TUI and serve); the hub must not snapshot `overrideEnv` at construction; thinking overrides go through the same `createAdapterFromEnv` — no second client factory. Vendor/API failures are drawn for the human in the conversation stream (thin shell `API error (status):` + verbatim message), not appended to the session transcript; `StopReason` / `protocolError` are not UX copy. Harness control-flow envelopes (e.g. LOOP_DETECTED) still enter the authoritative messages fed to the model.
