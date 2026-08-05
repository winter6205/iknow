/**
 * i132 probe — 9router Anthropic-format passthrough check
 *
 * Goal: discover whether 9router (http://localhost:20128/v1) accepts
 * Anthropic-format /v1/messages requests and passes through the SDK v0.115.0
 * server-side context-management params and beta header.
 *
 * Reference tickets: #118 (research, closed) → #132 (this probe) → #119 (strategy).
 *
 * Probes (run sequentially, each isolated):
 *   A. Baseline Anthropic-format POST (no beta, no context_management) — does 9router
 *      even understand /v1/messages, or is it pure OpenAI-format /chat/completions?
 *   B. + anthropic-beta: context-management-2025-06-27 header
 *   C. + context_management.edits body (clear_tool_uses_20250919, trigger value=1)
 *   D. + cache_control on a tool definition (ephemeral breakpoint)
 *   E. Combined (B + C + D together — the realistic reuse case)
 *
 * Output convention (per i4-* sibling probe): hash-fingerprint only, no secret dump.
 * Each probe prints a single line: <label>_status=<code> [code=<error_code>] body_len=<n>
 * plus a probe verdict on whether the requested feature reached the server and echoed back.
 *
 * Run: tsx scripts/i132-probe-9router-context-mgmt.ts
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

interface ProbeHit {
  label: string;
  status: number | null;
  errCode?: string;
  bodyLen: number;
  /** Substring check on the raw response body — true if present. */
  hasAppliedEdits: boolean;
  hasCacheMissReason: boolean;
  /** Substring check on the raw response body for downstream-visible cache telemetry. */
  hasCacheCreationTokens: boolean;
  /** Whether 9router echoed the request fields back (proves passthrough of echo endpoints only). */
  errorMessage?: string;
  rawBodyHead?: string;
}

interface ProbeResult extends ProbeHit {
  label: string;
  verdict:
    | "ok_2xx"
    | "expected_400_param_rejected"
    | "expected_400_beta_rejected"
    | "5xx_or_unreachable"
    | "transport_error"
    | "endpoint_not_found_404"
    | "ok_but_no_echo"
    | "auth_401";
  /** One-line human conclusion for the resolution comment. */
  verdictNote: string;
}

/** Body shape — only the fields we care about for passthrough testing. */
function buildBaseBody(): Record<string, unknown> {
  return {
    model: "m3-combo",
    max_tokens: 16,
    messages: [{ role: "user", content: "probe ping" }],
  };
}

/** Tool with cache_control breakpoint — used in probes D and E. */
function toolWithCacheControl(): unknown[] {
  return [
    {
      name: "probe_tool",
      description:
        "Probe tool that echoes input — used only for cache_control passthrough test.",
      input_schema: {
        type: "object",
        properties: {
          input: { type: "string", description: "Echo input." },
        },
        required: ["input"],
      },
      cache_control: { type: "ephemeral" },
    },
  ];
}

/** One probe = one POST with optional headers + body extras. */
async function hit(
  label: string,
  url: string,
  key: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string>,
  baselineAcceptableStatuses: readonly number[]
): Promise<ProbeResult> {
  const reqBody = JSON.stringify(body);
  const hit: ProbeHit = {
    label,
    status: null,
    bodyLen: 0,
    hasAppliedEdits: false,
    hasCacheMissReason: false,
    hasCacheCreationTokens: false,
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        ...extraHeaders,
      },
      body: reqBody,
    });
    const text = await res.text();
    hit.status = res.status;
    hit.bodyLen = text.length;
    hit.hasAppliedEdits = text.includes("applied_edits");
    hit.hasCacheMissReason =
      text.includes("cache_miss_reason") || text.includes("cache_creation");
    hit.hasCacheCreationTokens = text.includes("cache_creation_input_tokens");
    if (text.length > 0 && text.length < 400) hit.rawBodyHead = text;

    let j: { error?: { code?: string; message?: string } } | null = null;
    try {
      j = JSON.parse(text) as typeof j;
    } catch {
      /* not JSON */
    }
    if (j?.error) {
      hit.errCode = j.error.code;
      hit.errorMessage = j.error.message;
    }
  } catch (err) {
    return {
      ...hit,
      verdict: "transport_error",
      verdictNote:
        "fetch threw — " + (err instanceof Error ? err.message : String(err)),
    };
  }

  // Verdict — priority: 401 > 404 > transport > 5xx > 2xx > 400 > other.
  if (hit.status === 401) {
    return {
      ...hit,
      verdict: "auth_401",
      verdictNote:
        "401 — key not accepted by 9router (per i4-smoke: typical key-sync drift)",
    };
  }
  if (hit.status === 404) {
    return {
      ...hit,
      verdict: "endpoint_not_found_404",
      verdictNote:
        "404 — 9router has no /v1/messages endpoint; it's pure OpenAI-format /chat/completions",
    };
  }
  if (hit.status !== null && hit.status >= 500) {
    return {
      ...hit,
      verdict: "5xx_or_unreachable",
      verdictNote: "5xx — 9router up but errored on Anthropic-format request",
    };
  }
  if (
    hit.status !== null &&
    baselineAcceptableStatuses.includes(hit.status) &&
    hit.status >= 200 &&
    hit.status < 300
  ) {
    return {
      ...hit,
      verdict: hit.hasAppliedEdits ? "ok_2xx" : "ok_but_no_echo",
      verdictNote: hit.hasAppliedEdits
        ? "2xx + applied_edits present — full passthrough confirmed"
        : "2xx but no applied_edits in body — passthrough unknown (request may have been dropped)",
    };
  }
  if (hit.status === 400) {
    return {
      ...hit,
      verdict: hit.errCode?.includes("context_management")
        ? "expected_400_param_rejected"
        : "expected_400_beta_rejected",
      verdictNote:
        "400 — " +
        (hit.errCode ?? "no error code") +
        " — param/header rejected by 9router or upstream",
    };
  }
  return {
    ...hit,
    verdict: "transport_error",
    verdictNote: "status " + String(hit.status) + " — unclassified",
  };
}

async function main(): Promise<void> {
  const e = loadIknowEnv();
  const key = e.llm.apiKey;
  console.log("apiKeyEnv=" + e.llm.apiKeyEnv);
  console.log("loader_fp=" + fp(key));
  console.log("baseUrl=" + e.llm.baseUrl);
  console.log("llm_model=" + e.llm.model);

  if (!key) {
    console.log("no_key — abort (see i4-smoke: key sync is typical blocker)");
    process.exitCode = 1;
    return;
  }

  const base = e.llm.baseUrl.replace(/\/$/, "");
  const url = base + "/messages"; // Anthropic-format endpoint

  // Probe A: baseline Anthropic-format POST. Any 2xx proves /v1/messages is served;
  // 404 proves 9router is pure OpenAI-format and SDK reuse is dead.
  const a = await hit("A_baseline", url, key, buildBaseBody(), {}, [200, 201]);

  // Probe B: same + anthropic-beta header.
  const b = await hit(
    "B_beta_header",
    url,
    key,
    buildBaseBody(),
    { "anthropic-beta": "context-management-2025-06-27" },
    [200, 201, 400] // 400 is acceptable IF body identifies context_management as unknown
  );

  // Probe C: same + context_management body edits.
  const cBody: Record<string, unknown> = {
    ...buildBaseBody(),
    context_management: {
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: 1 },
        },
      ],
    },
  };
  const c = await hit(
    "C_context_management",
    url,
    key,
    cBody,
    {},
    [200, 201, 400]
  );

  // Probe D: tool with cache_control breakpoint.
  const dBody: Record<string, unknown> = {
    ...buildBaseBody(),
    tools: toolWithCacheControl(),
  };
  const d = await hit(
    "D_cache_control_tool",
    url,
    key,
    dBody,
    {},
    [200, 201, 400]
  );

  // Probe E: combined — the realistic SDK-reuse configuration.
  const eBody: Record<string, unknown> = {
    ...buildBaseBody(),
    context_management: {
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: 1 },
        },
      ],
    },
    tools: toolWithCacheControl(),
  };
  const eRes = await hit(
    "E_combined",
    url,
    key,
    eBody,
    { "anthropic-beta": "context-management-2025-06-27" },
    [200, 201, 400]
  );

  // Render compact JSON so downstream tooling can parse the verdict programmatically.
  const results = [a, b, c, d, eRes];
  console.log("\n--- verdict ---");
  for (const r of results) {
    console.log(
      JSON.stringify({
        label: r.label,
        status: r.status,
        errCode: r.errCode,
        bodyLen: r.bodyLen,
        hasAppliedEdits: r.hasAppliedEdits,
        hasCacheMissReason: r.hasCacheMissReason,
        hasCacheCreationTokens: r.hasCacheCreationTokens,
        errorMessage: r.errorMessage,
        verdict: r.verdict,
        verdictNote: r.verdictNote,
      })
    );
  }

  // Process exit code: 0 if all probes hit a verdict; 2 if any transport / endpoint failures.
  const failed = results.filter(
    (r) =>
      r.verdict === "transport_error" ||
      r.verdict === "5xx_or_unreachable" ||
      r.verdict === "endpoint_not_found_404"
  );
  if (failed.length > 0) {
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
