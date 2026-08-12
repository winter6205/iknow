/**
 * Check loader-resolved key load path vs chat auth (no secret dump).
 * settings-model-extension：key 来源 = settings.llm.apiKey（字面或 `${VAR}`
 * 占位符，`expandPlaceholders` 从 process.env / .env.local 解析）。
 * `apiKeyEnv` 字段已退役（不再有「key 变量名」概念）；loader 指纹是
 * 唯一权威证据（#173）。
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
  const e = loadIknowEnv();
  const fromLoader = e.llm.apiKey;

  console.log("loader key present=" + Boolean(fromLoader?.trim()));
  // L6：loader_fp 是 settings.llm.apiKey 的「来源标记」指纹（来源标记而非
  // 变量名，区别于退役前的 IKNOW_LLM_API_KEY_ENV 变量名）。
  console.log("loader_fp=" + fingerprint(fromLoader));
  console.log("baseUrl=" + e.llm.baseUrl);
  console.log("model=" + e.llm.model);

  const key = fromLoader;
  if (!key) {
    console.log(
      "chat_probe=skipped_no_key — set settings.llm.apiKey (literal or ${VAR}) " +
        "in ~/.iknow/settings.json or <cwd>/.iknow/settings.json"
    );
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
