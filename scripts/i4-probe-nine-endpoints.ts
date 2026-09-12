/**
 * Probe 9router endpoints with the loader-resolved key (no secret dump).
 * settings-model-extension：key 来源 = settings.llm.apiKey（字面或 `${VAR}`
 * 占位符，`expandPlaceholders` 从 process.env / .env.local 解析）。
 * `apiKeyEnv` 字段已退役；loader 指纹是唯一权威证据（#173）。
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
  // L6：loader_fp 是 settings.llm.apiKey 的「来源标记」指纹（来源标记而非
  // 变量名，区别于退役前的 IKNOW_LLM_API_KEY_ENV 变量名）。
  console.log("loader_fp=" + fp(key));
  console.log("baseUrl=" + e.llm.baseUrl);
  console.log("llm_model=" + e.llm.model);

  if (!key) {
    console.log(
      "no_key — set settings.llm.apiKey (literal or ${VAR}) in " +
        "~/.iknow/settings.json (llm is a user-layer key, ADR-0084)"
    );
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
