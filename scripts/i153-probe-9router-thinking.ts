/**
 * i153 probe — 9router / MiniMax-M3 Anthropic-format thinking-block handling
 *
 * Reference: #143 Resolution §5 (probe matrix), #132 (precedent: 9router
 * passthrough of /v1/messages and provider-qualified model name `minimax-cn/...`).
 *
 * Goal: classify how 9router (and its MiniMax-M3 upstream) handles the
 * Anthropic-format `thinking` field on /v1/messages:
 *   - adaptive type:     thinking: { type: "adaptive" }
 *   - fixed-budget:      thinking: { type: "enabled", budget_tokens: N }
 *
 * First-round probes each classify into 3 buckets:
 *   - bucket A: 2xx + thinking block present in response.content
 *   - bucket B: 2xx + NO thinking block in response.content (silently dropped)
 *   - bucket C: 4xx (param explicitly rejected; sanitized error body)
 *
 * If the first round returns thinking + tool_use, the follow-up probe re-sends
 * the conversation in 3 shapes to test structural validation:
 *   - 3a original:       thinking block echoed back verbatim + tool_result
 *   - 3b drop_thinking:   thinking block omitted from assistant message
 *   - 3c trunc_signature: thinking block echoed with truncated signature
 * Each shape records HTTP status and the sanitized error body (if any).
 *
 * The prompt forces tool_use — pure text completion cannot exercise the
 * thinking + tool_use flow. If the model declines to call the tool, the
 * follow-up probe is skipped (noted as `no_tool_use_skip`).
 *
 * Key handling: only via env (NINE_ROUTER_KEY IKNOW_PROBE_KEY_BACKUP).
 * argv --key is removed — keys must never appear in shell history.
 * Error bodies are sanitized to {code, type, message} only.
 *
 * Run:
 *   NINE_ROUTER_KEY='...' IKNOW_LLM_BASE_URL=http://<wsl-gateway>:20128/v1 \
 *     tsx scripts/i153-probe-9router-thinking.ts \
 *     --model=minimax-cn/MiniMax-M3 --max-tokens=4096 --budget-tokens=2048
 */
import { createHash } from "node:crypto";
import { loadIknowEnv } from "../src/config/env.js";

function fp(v: string | undefined): string {
  if (!v?.trim()) return "absent";
  return (
    "len=" +
    v.trim().length +
    " sha256_12=" +
    createHash("sha256").update(v.trim()).digest("hex").slice(0, 12)
  );
}

/** First 3 chars + last 4 chars of a signature — for safe redaction in logs. */
function sigRedact(s: string | undefined): string {
  if (!s) return "<absent>";
  if (s.length <= 7) return `<len=${s.length}>`;
  return `${s.slice(0, 3)}...${s.slice(-4)}<len=${s.length}>`;
}

/** Truncate a free-form string to a fingerprint-friendly size. */
function clip(s: string | undefined, n = 240): string {
  if (s === undefined) return "<undefined>";
  return s.length <= n ? s : s.slice(0, n) + `<...+${s.length - n}>`;
}

// --- argv + env ---------------------------------------------------------

interface CliArgs {
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  budgetTokens?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    // argv --key is intentionally NOT supported — key must come only from env
    // (process.env.NINE_ROUTER_KEY or process.env.IKNOW_PROBE_KEY_BACKUP).
    if (a === "--base-url") out.baseUrl = argv[++i];
    else if (a.startsWith("--base-url="))
      out.baseUrl = a.slice("--base-url=".length);
    else if (a === "--model") out.model = argv[++i];
    else if (a.startsWith("--model=")) out.model = a.slice("--model=".length);
    else if (a === "--max-tokens") out.maxTokens = Number(argv[++i]);
    else if (a === "--budget-tokens") out.budgetTokens = Number(argv[++i]);
  }
  return out;
}

// --- request/response typing (only fields the probe reads) -----------

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface MessagesResponse {
  id?: string;
  model?: string;
  content?: ContentBlock[];
  stop_reason?: string;
  usage?: Record<string, number>;
  error?: { type?: string; code?: string; message?: string };
}

interface ProbeHit {
  status: number | null;
  bodyLen: number;
  /** Whether the response.content includes a `thinking` block. */
  hasThinking: boolean;
  /** Whether the response.content includes a `tool_use` block. */
  hasToolUse: boolean;
  /** Stop reason echoed back (e.g. "end_turn", "tool_use", "max_tokens"). */
  stopReason?: string;
  /** Sanitized error message (if any) — first 240 chars, key already excluded. */
  errorMessage?: string;
  errorType?: string;
  errorCode?: string;
  /** Compact display blocks (type + redacted sig + clipped text) — for stdout only. */
  blocks?: Array<Record<string, unknown>>;
  /**
   * Full unredacted content blocks — kept in memory only, used verbatim for
   * round-2 replay; NEVER rendered to stdout (signatures are opaque and large).
   */
  rawContent?: ContentBlock[];
  rawBodyHead?: string;
}

interface ProbeResult extends ProbeHit {
  label: string;
  requestBody: Record<string, unknown>;
  /** Verdict for first-round probes (P1/P2). */
  thinkingVerdict?:
    | "thinking_returned"
    | "thinking_silently_dropped"
    | "param_rejected_400"
    | "auth_401"
    | "endpoint_404"
    | "5xx_or_unreachable"
    | "transport_error"
    | "no_key_aborted"
    | "unexpected_2xx_no_tool_use";
  thinkingVerdictNote?: string;
  /** Verdict for follow-up round probes (P3a/b/c). */
  followUpVerdict?:
    | "echo_ok"
    | "echo_rejected_signature"
    | "echo_rejected_other"
    | "auth_401"
    | "no_tool_use_skip"
    | "transport_error"
    | "5xx_or_unreachable";
  followUpVerdictNote?: string;
}

// --- HTTP helper -------------------------------------------------------

async function hit(
  url: string,
  key: string,
  body: Record<string, unknown>
): Promise<ProbeHit> {
  const hit: ProbeHit = {
    status: null,
    bodyLen: 0,
    hasThinking: false,
    hasToolUse: false,
  };
  let text: string;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
    text = await res.text();
    hit.status = res.status;
    hit.bodyLen = text.length;
  } catch (err) {
    // Synthesize a transport-error result so the caller can still classify.
    hit.rawBodyHead =
      "fetch_threw: " + (err instanceof Error ? err.message : String(err));
    return hit;
  }

  let j: MessagesResponse | null = null;
  try {
    j = JSON.parse(text) as MessagesResponse;
  } catch {
    // Gateway responds content-type: text/event-stream with a trailing
    // `data: [DONE]` SSE trailer (same shape the production parseLlmResponseJson
    // tolerates). Extract the outermost JSON object and retry.
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        j = JSON.parse(text.slice(first, last + 1)) as MessagesResponse;
      } catch {
        /* not JSON */
      }
    }
  }
  if (j) {
    if (Array.isArray(j.content)) {
      hit.hasThinking = j.content.some((b) => b.type === "thinking");
      hit.hasToolUse = j.content.some((b) => b.type === "tool_use");
      hit.stopReason = j.stop_reason;
      // Compact display blocks — text/signature redacted for stdout only.
      hit.blocks = j.content.map((b) => {
        const out: Record<string, unknown> = { type: b.type };
        if (b.thinking !== undefined) out.thinking = clip(b.thinking, 80);
        if (b.signature !== undefined) out.signature = sigRedact(b.signature);
        if (b.id !== undefined) out.id = b.id;
        if (b.name !== undefined) out.name = b.name;
        if (b.input !== undefined) out.input = b.input;
        if (b.text !== undefined) out.text = clip(b.text, 120);
        return out;
      });
      // Full unredacted content kept in memory (used verbatim by follow-up
      // probes; signatures must not be redacted during replay because that
      // would conflate the "original" / "truncated" shapes).
      hit.rawContent = j.content.map((b) => {
        const out: ContentBlock = { type: b.type };
        if (b.thinking !== undefined) out.thinking = b.thinking;
        if (b.signature !== undefined) out.signature = b.signature;
        if (b.id !== undefined) out.id = b.id;
        if (b.name !== undefined) out.name = b.name;
        if (b.input !== undefined) out.input = b.input;
        if (b.text !== undefined) out.text = b.text;
        return out;
      });
    }
    if (j.error) {
      hit.errorType = j.error.type;
      hit.errorCode = j.error.code;
      hit.errorMessage = clip(j.error.message, 240);
    }
  }
  if (text.length > 0 && text.length < 400) hit.rawBodyHead = text;
  return hit;
}

// --- shared request fragments -----------------------------------------

const TOOL_ECHO = [
  {
    name: "probe_echo",
    description:
      "Echoes the `input` string back to the caller. Used only by i153 probe to force a tool_use response so the thinking+tool_use flow is exercised.",
    input_schema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "Text to echo back.",
        },
      },
      required: ["input"],
    },
  },
];

const USER_FORCE_TOOL =
  "You MUST call the probe_echo tool with input='hello' before saying anything else. " +
  "Do not produce any text outside of the tool call.";

// --- first-round probe (P1/P2) ----------------------------------------

interface FirstRoundArgs {
  label: string;
  url: string;
  key: string;
  model: string;
  maxTokens: number;
  thinking: Record<string, unknown>;
}

async function firstRound(args: FirstRoundArgs): Promise<ProbeResult> {
  const body: Record<string, unknown> = {
    model: args.model,
    max_tokens: args.maxTokens,
    messages: [{ role: "user", content: USER_FORCE_TOOL }],
    tools: TOOL_ECHO,
    thinking: args.thinking,
  };
  const hit_ = await hit(args.url, args.key, body);
  const r: ProbeResult = { label: args.label, requestBody: body, ...hit_ };

  // Classification
  if (r.status === null) {
    r.thinkingVerdict = "transport_error";
    r.thinkingVerdictNote = "fetch threw — see rawBodyHead";
  } else if (r.status === 401) {
    r.thinkingVerdict = "auth_401";
    r.thinkingVerdictNote = "401 — key not accepted by gateway";
  } else if (r.status === 404) {
    r.thinkingVerdict = "endpoint_404";
    r.thinkingVerdictNote = "404 — no /v1/messages on gateway";
  } else if (r.status >= 500) {
    r.thinkingVerdict = "5xx_or_unreachable";
    r.thinkingVerdictNote = `5xx (${r.status}) — gateway errored`;
  } else if (r.status >= 200 && r.status < 300) {
    if (r.hasThinking) {
      r.thinkingVerdict = "thinking_returned";
      r.thinkingVerdictNote = r.hasToolUse
        ? "2xx + thinking + tool_use — full echo possible"
        : "2xx + thinking, no tool_use — follow-up skipped";
    } else {
      // 2xx but no thinking block — distinguish "model chose not to think" from
      // "thinking param silently dropped". Heuristic: if param_rejected-style
      // 400 came back as 2xx AND tool_use present, treat as silently_dropped.
      r.thinkingVerdict = "thinking_silently_dropped";
      r.thinkingVerdictNote = r.hasToolUse
        ? "2xx + tool_use but NO thinking block — param silently dropped"
        : "unexpected_2xx_no_tool_use";
      if (!r.hasToolUse) r.thinkingVerdict = "unexpected_2xx_no_tool_use";
    }
  } else if (r.status >= 400 && r.status < 500) {
    r.thinkingVerdict = "param_rejected_400";
    r.thinkingVerdictNote = `${r.status} — ${
      r.errorCode ?? r.errorType ?? "no error code"
    } — ${r.errorMessage ?? "<no message>"}`;
  } else {
    r.thinkingVerdict = "transport_error";
    r.thinkingVerdictNote = `status ${r.status} — unclassified`;
  }
  return r;
}

// --- follow-up probe (P3a/b/c) ---------------------------------------

interface FollowUpArgs {
  label: string;
  url: string;
  key: string;
  model: string;
  maxTokens: number;
  shape: "original" | "drop_thinking" | "trunc_signature";
  firstRoundBlocks: ContentBlock[];
  toolUseId: string;
  toolUseName: string;
  toolUseInput: unknown;
  toolResultContent: string;
  /** Same thinking param as first round — kept for cross-isolation. */
  thinking?: Record<string, unknown>;
}

function shapeAssistantContent(
  blocks: ContentBlock[],
  shape: FollowUpArgs["shape"]
): ContentBlock[] {
  if (shape === "drop_thinking") {
    return blocks.filter((b) => b.type !== "thinking");
  }
  if (shape === "trunc_signature") {
    // Take first 8 chars of signature verbatim (no suffix) — simulates a
    // client that persisted only a prefix of the signature.
    return blocks.map((b) =>
      b.type === "thinking" && typeof b.signature === "string"
        ? { ...b, signature: b.signature.slice(0, 8) }
        : b
    );
  }
  // original — pass through verbatim (must use full unredacted blocks)
  return blocks.map((b) => ({ ...b }));
}

async function followUp(args: FollowUpArgs): Promise<ProbeResult> {
  const assistantContent = shapeAssistantContent(
    args.firstRoundBlocks,
    args.shape
  );
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: USER_FORCE_TOOL },
    { role: "assistant", content: assistantContent },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: args.toolUseId,
          content: args.toolResultContent,
        },
      ],
    },
  ];
  // The follow-up must include the same `thinking` param as the first round —
  // omitting it would conflate "no new thinking enabled" with "second-turn
  // structural rejection". The echoed blocks self-validate via their
  // signature regardless.
  const body: Record<string, unknown> = {
    model: args.model,
    max_tokens: args.maxTokens,
    messages,
    tools: TOOL_ECHO,
  };
  if (args.thinking) body.thinking = args.thinking;
  const hit_ = await hit(args.url, args.key, body);
  const r: ProbeResult = { label: args.label, requestBody: body, ...hit_ };

  if (r.status === null) {
    r.followUpVerdict = "transport_error";
    r.followUpVerdictNote = "fetch threw — see rawBodyHead";
  } else if (r.status === 401) {
    r.followUpVerdict = "auth_401";
    r.followUpVerdictNote = "401 — key not accepted";
  } else if (r.status >= 500) {
    r.followUpVerdict = "5xx_or_unreachable";
    r.followUpVerdictNote = `5xx (${r.status})`;
  } else if (r.status >= 200 && r.status < 300) {
    r.followUpVerdict = "echo_ok";
    r.followUpVerdictNote = r.hasThinking
      ? "2xx + thinking echoed — signature validated"
      : `2xx, no new thinking in follow-up (stop_reason=${r.stopReason ?? "?"})`;
  } else if (r.status >= 400 && r.status < 500) {
    const isSig =
      (r.errorMessage ?? "").toLowerCase().includes("signature") ||
      (r.errorMessage ?? "").toLowerCase().includes("thinking") ||
      (r.errorCode ?? "").toLowerCase().includes("signature");
    r.followUpVerdict = isSig
      ? "echo_rejected_signature"
      : "echo_rejected_other";
    r.followUpVerdictNote = `${r.status} — ${
      r.errorCode ?? r.errorType ?? "no code"
    } — ${r.errorMessage ?? "<no message>"}`;
  } else {
    r.followUpVerdict = "transport_error";
    r.followUpVerdictNote = `status ${r.status} — unclassified`;
  }
  return r;
}

// --- main --------------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const e = loadIknowEnv();
  // Key resolution — env only (no argv --key, no ANTHROPIC_AUTH_TOKEN fallback:
  // accepting that variable would silently substitute Claude Code's credential
  // and leak it via subsequent probe logs / traces).
  const key =
    process.env.NINE_ROUTER_KEY ??
    process.env.IKNOW_PROBE_KEY_BACKUP ??
    undefined;
  const baseUrl = (
    cli.baseUrl ??
    process.env.IKNOW_LLM_BASE_URL ??
    e.llm.baseUrl
  ).replace(/\/$/, "");
  // settings-model-extension：model 唯一来源 = settings.llm.model（loadIknowEnv
  // fail-fast 保证有值）；`--model` argv 覆盖仅限显式请求（不再有 IKNOW_LLM_MODEL
  // env 回退，也不再硬编码 minimax-cn/MiniMax-M3 兜底）。
  const model = cli.model ?? e.llm.model;
  // Default to 4096 so adaptive thinking + tool_use has budget, and
  // fixed-budget default of 2048 stays < max_tokens (per Anthropic constraint
  // carried over to MiniMax via 9router — see #143 §1.1).
  const maxTokens = cli.maxTokens ?? 4096;
  const budgetTokens = cli.budgetTokens ?? 2048;

  console.log("key_fp=" + fp(key));
  console.log("baseUrl=" + baseUrl);
  console.log("model=" + model);
  console.log("max_tokens=" + maxTokens);
  console.log("fixed_budget_tokens=" + budgetTokens);

  if (!key) {
    console.log(
      "no_key — abort (set NINE_ROUTER_KEY in environment; key must NOT be set via argv)"
    );
    process.exitCode = 1;
    return;
  }

  const url = baseUrl + "/messages";

  // ----- P1: adaptive thinking ----------------------------------------
  const p1 = await firstRound({
    label: "P1_adaptive",
    url,
    key,
    model,
    maxTokens,
    thinking: { type: "adaptive" },
  });

  // ----- P2: fixed-budget thinking ------------------------------------
  const p2 = await firstRound({
    label: "P2_fixed_budget",
    url,
    key,
    model,
    maxTokens,
    thinking: { type: "enabled", budget_tokens: budgetTokens },
  });

  // ----- P3: follow-up shapes (for each first-round that has thinking+tool_use)
  const followUps: ProbeResult[] = [];
  for (const fr of [p1, p2]) {
    const frBlocks = fr.rawContent;
    if (
      fr.thinkingVerdict !== "thinking_returned" ||
      !fr.hasToolUse ||
      !frBlocks ||
      frBlocks.length === 0
    ) {
      followUps.push({
        label: fr.label + "_followup_skip",
        status: null,
        bodyLen: 0,
        hasThinking: false,
        hasToolUse: false,
        requestBody: { reason: "no thinking+tool_use in first round" },
        followUpVerdict: "no_tool_use_skip",
        followUpVerdictNote: `first-round verdict=${fr.thinkingVerdict ?? "?"}`,
      });
      continue;
    }
    const tu = frBlocks.find((b) => b.type === "tool_use");
    if (!tu || typeof tu.id !== "string" || typeof tu.name !== "string") {
      followUps.push({
        label: fr.label + "_followup_skip",
        status: null,
        bodyLen: 0,
        hasThinking: false,
        hasToolUse: false,
        requestBody: { reason: "tool_use block missing id/name" },
        followUpVerdict: "no_tool_use_skip",
        followUpVerdictNote: "tool_use block malformed",
      });
      continue;
    }
    const tuInput = tu.input;
    // Run the 3 follow-up shapes — replay uses the FULL unredacted blocks
    // (rawContent), never the display-only compact blocks, so that the
    // "original" shape is truly original.
    for (const shape of [
      "original",
      "drop_thinking",
      "trunc_signature",
    ] as const) {
      const fu = await followUp({
        label: `${fr.label}_followup_${shape}`,
        url,
        key,
        model,
        maxTokens,
        shape,
        firstRoundBlocks: frBlocks,
        toolUseId: tu.id,
        toolUseName: tu.name,
        toolUseInput: tuInput,
        toolResultContent: "echo-ok",
        thinking:
          fr.label === "P1_adaptive"
            ? { type: "adaptive" }
            : { type: "enabled", budget_tokens: budgetTokens },
      });
      followUps.push(fu);
    }
  }

  // Render compact JSON so downstream tooling can parse the verdict programmatically.
  const all = [p1, p2, ...followUps];
  console.log("\n--- verdict ---");
  for (const r of all) {
    const compact: Record<string, unknown> = {
      label: r.label,
      status: r.status,
      bodyLen: r.bodyLen,
      hasThinking: r.hasThinking,
      hasToolUse: r.hasToolUse,
      stopReason: r.stopReason,
      blocks: r.blocks,
    };
    if (r.thinkingVerdict !== undefined) {
      compact.thinkingVerdict = r.thinkingVerdict;
      compact.thinkingVerdictNote = r.thinkingVerdictNote;
    }
    if (r.followUpVerdict !== undefined) {
      compact.followUpVerdict = r.followUpVerdict;
      compact.followUpVerdictNote = r.followUpVerdictNote;
    }
    if (r.errorCode !== undefined) compact.errorCode = r.errorCode;
    if (r.errorType !== undefined) compact.errorType = r.errorType;
    if (r.errorMessage !== undefined) compact.errorMessage = r.errorMessage;
    if (r.rawBodyHead !== undefined) compact.rawBodyHead = r.rawBodyHead;
    console.log(JSON.stringify(compact));
  }

  // Exit code: 0 = all probes reached a verdict, 2 = transport/endpoint failure.
  const failed = all.filter(
    (r) =>
      r.thinkingVerdict === "transport_error" ||
      r.thinkingVerdict === "5xx_or_unreachable" ||
      r.thinkingVerdict === "endpoint_404" ||
      r.thinkingVerdict === "auth_401" ||
      r.followUpVerdict === "transport_error" ||
      r.followUpVerdict === "5xx_or_unreachable"
  );
  if (failed.length > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
