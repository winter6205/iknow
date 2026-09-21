# Spec: instruction-authority outbound projection — host frames get stamped; the untrusted channel cannot impersonate official signage

**Status:** landed (T1–T5 implemented; decision landed in ADR-0112)
**Basis:** GH #1066; ADR-0009 / ADR-0044 (channel-based trust, labeling is not defense); ADR-0028 (the status bar enters messages, never `deps.system`); contract X / observability side-channel (disk truth ≠ model-visible bytes)
**Surface:** `src/harness/model-adapter/` (`buildMessageParams` outbound seam), `src/harness/loop-engine.ts` (host-injection commit stamping), `src/harness/subagent/worker.ts` (constitution vs addendum), root `README.md` (one Features line, after landing)
**Issue:** https://github.com/winter6205/iknow/issues/1066

## Goal

Narrow instruction authority from "the model reads the same bytes and behaves" to an **outbound projection**: the authoritative history may be dirty; the JSON sent to the model is laid out by provenance. A fake `<agent_status>` / fake system prefix appearing in a tool result must not grow into an official frame; a subagent's LOCKED constitution must not be lifted into `system` by the parent model's `systemPrompt`.

## Boundaries

- **Does:**
  - Host injections (the status bar and siblings of `encodeUserText` injections) receive a **non-model-visible** provenance stamp at commit time; stripped at outbound.
  - `buildMessageParams` (or a pure function extracted to the same seam) applies a deterministic transposition to unstamped / `tool_result` text so payloads cannot reproduce unescaped host-frame syntax.
  - `IKNOW_AGENT_STATUS_READ_RULE` changes to "trust only this hop's host frames" and no longer declares the newest XML tag in the transcript authoritative.
  - worker: `envelope.systemPrompt` must not override the LOCKED six sections; the addendum is downgraded to user/untrusted.
  - Once the capability lands, add one product blurb to the root `README.md`'s **Features** (for humans, not a security whitepaper).
- **Out of this spec:**
  - Full CaMeL / privileged-LLM control-flow extraction.
  - Using soul admonitions as the acceptance mechanism (an optional usage line does not carry an invariant).
  - Changing `permissions.toml` / executor truncation / memory body into system (already present, keep).
  - Writing escaping into the authoritative history or into TUI original-text display.
  - Detecting operator-input-box jailbreaks (the operator channel).
  - Any "the model never obeys" guarantee against natural-language indirect injection (that is the sink layer; this spec only removes the fake signage).

## Settled invariants

1. **The model protocol is a derived view.** The projection is a pure function of `LoopState` + `request.system`; the same history → the same wire bytes (KV prefix stability). Never stuff live state by editing `system` each hop.
2. **Official appearance comes only from stamped host commits.** Parsing XML / prefix rosters is not anti-forgery; `isHostInjectedUserText` keeps serving TUI bubble hiding / instruction echo and carries no authority.
3. **Untrusted content cannot reproduce host syntax.** After outbound, `tool_result` and unstamped user text must not contain unescaped tags that the read rule could take as the bar / host injection. Content stays readable (the data is still there).
4. **The constitution cannot be bought by the parent model.** The worker's `system` LOCKED prefix is identical to the no-addendum case; `task` / `systemPrompt` never enter the highest-trust slot.
5. **Failures fail closed.** If the encoder/projection throws a typed error, the hop sends no model request; no fallback to "upload the dirty transcript as-is".
6. **No replacement of the sink.** "Go do X" in an ordinary sentence may still be executed by the model; permissions, sandbox, and egress remain that layer's job.

## Task breakdown

### T1 — ADR + CONTEXT entries (decision landing)

Write "outbound projection / host-frame provenance / instruction authority vs capability authority" into an ADR and `docs/CONTEXT.md`. The number takes the next free slot relative to the default branch on the landing branch (do not race the unmerged 0108).

### T2 — host commit stamping + outbound transposition

Stamp at the injection points; deepen `buildMessageParams` into the projection. Acceptance: a complete fake bar inside tool_result → on the wire, official syntax appears only in stamped frames.

### T3 — status-bar read rule

Change `IKNOW_AGENT_STATUS_READ_RULE`; golden set / SEAM locks per `docs/guides/prompt-development.md`.

### T4 — worker addendum downgrade

`withRoleExtras` / equivalent assembly: the LOCKED sections are not overridden by `envelope.systemPrompt`.

### T5 — root README Features line

After the capability merges, edit the **repository root** `README.md` (the project-introduction one), adding one entry under `## Features` in the same register as the existing Harness / Tools / Surfaces lines: short, product language, no attack steps. Do not touch `web/README.md` or any README under `docs/`.

## Out of scope (relisted)

- Per-tool banner additions (the `web_fetch` island should be folded into the projection, not copied into each tool).
- Moving the bar from messages into system (violates the ADR-0028 cache contract).
