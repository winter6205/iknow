/**
 * Check NINE_ROUTER_API_KEY load path vs chat auth (no secret dump).
 */
import { createHash } from "node:crypto";
import { loadIknowEnv } from "../src/config/env.js";

function fingerprint(v: string | undefined): string {
  if (!v) return "absent";
  const t = v.trim();
  if (!t) return "empty";
  const h = createHash("sha256").update(t).digest("hex").slice(0, 12);
  return `len=${t.length} sha256_12=${h}`;
}

async function main(): Promise<void> {
  const fromProcess = process.env.NINE_ROUTER_API_KEY;
  const e = loadIknowEnv();
  const fromLoader = e.llm.apiKey;

  console.log("env_name=NINE_ROUTER_API_KEY");
  console.log("process.env present=" + Boolean(fromProcess?.trim()));
  console.log("process.env fp=" + fingerprint(fromProcess));
  console.log("loadIknowEnv.llm.apiKeyEnv=" + e.llm.apiKeyEnv);
  console.log("loadIknowEnv key present=" + Boolean(fromLoader?.trim()));
  console.log("loadIknowEnv fp=" + fingerprint(fromLoader));
  console.log(
    "process_equals_loader=" +
      (Boolean(fromProcess && fromLoader) && fromProcess === fromLoader),
  );
  console.log("baseUrl=" + e.llm.baseUrl);
  console.log("model=" + e.llm.model);

  const key = fromLoader || fromProcess;
  if (!key) {
    console.log("chat_probe=skipped_no_key");
    process.exitCode = 1;
    return;
  }

  const base = e.llm.baseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: e.llm.model,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      max_tokens: 8,
    }),
  });
  const raw = await res.text();
  console.log("chat_http_status=" + res.status);
  if (!res.ok) {
    try {
      const j = JSON.parse(raw) as {
        error?: { code?: string; type?: string };
      };
      console.log("chat_error_code=" + (j.error?.code || "unknown"));
      console.log("chat_error_type=" + (j.error?.type || ""));
    } catch {
      console.log("chat_error_body_len=" + raw.length);
    }
    process.exitCode = 1;
    return;
  }
  console.log("chat_ok=true");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
