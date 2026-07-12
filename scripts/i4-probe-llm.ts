/**
 * Probe LLM chat/completions (no secrets printed).
 * Usage: npx tsx scripts/i4-probe-llm.ts
 */
import { loadIknowEnv } from "../src/config/env.js";
import { parseLlmResponseJson } from "../src/agent-loop/llm-client.js";

function redact(s: string): string {
  return s.replace(/[A-Za-z0-9_\-]{24,}/g, "[redacted]");
}

async function main(): Promise<void> {
  const e = loadIknowEnv();
  const key = e.llm.apiKey;
  if (!key) {
    console.log("llm_key=missing");
    process.exitCode = 1;
    return;
  }
  console.log("llm_key=present");
  console.log("baseUrl=" + e.llm.baseUrl);
  console.log("model=" + e.llm.model);

  const base = e.llm.baseUrl.replace(/\/$/, "");
  const body = JSON.stringify({
    model: e.llm.model,
    messages: [{ role: "user", content: "ping" }],
    stream: false,
    max_tokens: 16,
  });
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body,
  });
  const raw = await res.text();
  console.log("http_status=" + res.status);
  console.log("content_type=" + (res.headers.get("content-type") || ""));
  console.log("body_len=" + raw.length);
  console.log("has_done_trailer=" + /data:\s*\[DONE\]/i.test(raw));

  if (!res.ok) {
    console.log("error_prefix=" + redact(raw.slice(0, 100)));
    process.exitCode = 1;
    return;
  }
  try {
    const j = parseLlmResponseJson(raw) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const n = Array.isArray(j.choices) ? j.choices.length : -1;
    console.log("parse_ok=true choices=" + n);
  } catch (err) {
    console.log(
      "parse_ok=false err=" +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
