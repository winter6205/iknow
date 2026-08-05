/**
 * Probe 9router endpoints with the loader-resolved key (no secret dump).
 * `apiKeyEnv` is the SSOT name (ANTHROPIC_AUTH_TOKEN by default, overridable
 * via IKNOW_LLM_API_KEY_ENV in .env.local). The loader fingerprint is the
 * authoritative one - we do not also print a raw process.env line because
 * the env-var name the loader actually reads is what matters (#173).
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

async function main(): Promise<void> {
  const e = loadIknowEnv();
  const key = e.llm.apiKey;
  console.log("apiKeyEnv=" + e.llm.apiKeyEnv);
  console.log("loader_fp=" + fp(key));
  console.log("baseUrl=" + e.llm.baseUrl);
  console.log("llm_model=" + e.llm.model);

  if (!key) {
    console.log("no_key");
    process.exitCode = 1;
    return;
  }

  const base = e.llm.baseUrl.replace(/\/$/, "");

  async function hit(
    label: string,
    path: string,
    init?: RequestInit
  ): Promise<void> {
    try {
      const res = await fetch(base + path, {
        ...init,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(init?.headers || {}),
        },
      });
      const text = await res.text();
      let code = "";
      try {
        const j = JSON.parse(text) as { error?: { code?: string } };
        code = j.error?.code || "";
      } catch {
        /* ignore */
      }
      console.log(
        label +
          "_status=" +
          res.status +
          (code ? " code=" + code : "") +
          " body_len=" +
          text.length
      );
    } catch (err) {
      console.log(
        label + "_error=" + (err instanceof Error ? err.message : String(err))
      );
    }
  }

  await hit("models", "/models", { method: "GET" });
  await hit("chat", "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: e.llm.model,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      max_tokens: 8,
    }),
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
