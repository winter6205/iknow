/**
 * I4 LLM smoke using 9router DB key named "iknow" (process env only; never log secret).
 * Usage: npx tsx scripts/i4-llm-smoke-with-router-key.ts
 *
 * Requires local 9router data.sqlite. Exit 0 only if ask returns hops_used>=1 and snapshot_id.
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseLlmResponseJson } from "../src/agent-loop/llm-client.js";
import { loadIknowEnv } from "../src/config/env.js";

const require = createRequire(import.meta.url);

function loadIknowRouterKey(): string | undefined {
  // better-sqlite3 may not exist; use child sqlite3 CLI
  const db =
    process.env.NINE_ROUTER_DB ||
    join(
      process.env.APPDATA || "",
      "9router",
      "db",
      "data.sqlite",
    );
  const sqlite =
    process.env.SQLITE3_BIN ||
    "C:/Users/86152/miniconda3/Library/bin/sqlite3.exe";
  // Prefer miniconda path used on this machine
  const candidates = [
    sqlite,
    "E:/thing/miniconda/Library/bin/sqlite3.exe",
    "sqlite3",
  ];
  for (const bin of candidates) {
    const r = spawnSync(
      bin,
      [db, "SELECT key FROM apiKeys WHERE name='iknow' AND isActive=1 LIMIT 1;"],
      { encoding: "utf8" },
    );
    if (r.status === 0 && r.stdout?.trim()) {
      return r.stdout.trim();
    }
  }
  return undefined;
}

async function probeChat(apiKey: string): Promise<{
  status: number;
  parse_ok: boolean;
  has_choices: boolean;
}> {
  const e = loadIknowEnv();
  const base = e.llm.baseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: e.llm.model,
      messages: [{ role: "user", content: "reply with ok" }],
      stream: false,
      max_tokens: 16,
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    return { status: res.status, parse_ok: false, has_choices: false };
  }
  try {
    const j = parseLlmResponseJson(raw) as { choices?: unknown[] };
    return {
      status: res.status,
      parse_ok: true,
      has_choices: Array.isArray(j.choices) && j.choices.length > 0,
    };
  } catch {
    return { status: res.status, parse_ok: false, has_choices: false };
  }
}

async function main(): Promise<void> {
  const key = loadIknowRouterKey();
  if (!key) {
    console.log("router_key=missing");
    process.exitCode = 1;
    return;
  }
  console.log("router_key=present name=iknow");

  // Inject for this process tree only
  process.env.NINE_ROUTER_API_KEY = key;

  const probe = await probeChat(key);
  console.log(
    `probe status=${probe.status} parse_ok=${probe.parse_ok} has_choices=${probe.has_choices}`,
  );
  if (probe.status !== 200 || !probe.parse_ok) {
    process.exitCode = 1;
    return;
  }

  const t0 = Date.now();
  const ask = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "ask", "退款政策是什么？", "--mode", "llm"],
    {
      encoding: "utf8",
      env: { ...process.env, NINE_ROUTER_API_KEY: key },
      timeout: 180_000,
      shell: true,
    },
  );
  const askMs = Date.now() - t0;
  let has_snapshot = false;
  let hops: number | null = null;
  let gov: string | null = null;
  let tool_calls_len: number | null = null;
  let llm_success = false;
  try {
    const j = JSON.parse(ask.stdout || "{}") as {
      snapshot_id?: string;
      hops_used?: number;
      governance_status?: string;
      tool_calls?: unknown[];
      notes?: string[];
      text?: string;
    };
    has_snapshot = Boolean(j.snapshot_id);
    hops = typeof j.hops_used === "number" ? j.hops_used : null;
    gov = j.governance_status ?? null;
    tool_calls_len = Array.isArray(j.tool_calls) ? j.tool_calls.length : null;
    const notes = j.notes?.join(" ") ?? "";
    const text = j.text ?? "";
    llm_success =
      has_snapshot &&
      (hops ?? 0) >= 1 &&
      !/llm_error|not valid JSON|Invalid API key/i.test(notes + text);
  } catch {
    llm_success = false;
  }

  const t1 = Date.now();
  const pipeIn =
    "公司的退款政策是什么？\n那和旧版有什么不同？\n/status\n/quit\n";
  const pipe = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "chat", "--mode", "llm"],
    {
      encoding: "utf8",
      input: pipeIn,
      env: {
        ...process.env,
        NINE_ROUTER_API_KEY: key,
        IKNOW_CHAT_QUIET: "1",
      },
      timeout: 300_000,
      shell: true,
    },
  );
  const pipeMs = Date.now() - t1;
  const pipeOut = (pipe.stdout || "") + (pipe.stderr || "");
  const pipe_llm_errors = (pipeOut.match(/llm_error/gi) || []).length;
  const status_seen = /mode=llm/i.test(pipeOut) || /turns=\d+/i.test(pipeOut);
  const pipe_ok =
    pipe.status === 0 && pipe_llm_errors === 0 && status_seen;

  const outDir = join("docs", "handoff", "i4-smoke");
  mkdirSync(outDir, { recursive: true });
  const result = {
    mode: "llm",
    timestamp: new Date().toISOString(),
    result: llm_success && pipe_ok ? "pass" : "fail",
    key_source: "9router.apiKeys.name=iknow",
    probe,
    ask: {
      exit: ask.status,
      duration_ms: askMs,
      has_snapshot_id: has_snapshot,
      hops_used: hops,
      governance_status: gov,
      tool_calls_len,
      llm_success,
    },
    pipe: {
      exit: pipe.status,
      duration_ms: pipeMs,
      status_seen,
      llm_error_count: pipe_llm_errors,
      llm_success: pipe_ok,
    },
    notes: [
      "Shell NINE_ROUTER_API_KEY may 401; smoke injects active 9router key name iknow for process only.",
      "Client forces stream:false and parseLlmResponseJson strips SSE trailers.",
    ],
  };
  writeFileSync(
    join(outDir, "llm.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    join(outDir, "llm.md"),
    `# I4 smoke — llm\n\n**Result: ${String(result.result).toUpperCase()}**\n\n` +
      `| Check | Outcome |\n|-------|---------|\n` +
      `| Probe chat HTTP | ${probe.status} parse_ok=${probe.parse_ok} |\n` +
      `| Ask exit | ${ask.status} |\n` +
      `| snapshot_id | ${has_snapshot} |\n` +
      `| hops_used | ${hops} |\n` +
      `| governance_status | ${gov} |\n` +
      `| tool_calls length | ${tool_calls_len} |\n` +
      `| ask llm_success | ${llm_success} |\n` +
      `| pipe exit | ${pipe.status} |\n` +
      `| pipe llm_error_count | ${pipe_llm_errors} |\n` +
      `| pipe status_seen | ${status_seen} |\n\n` +
      `Key source: 9router DB apiKeys name=iknow (not printed).\n` +
      `Parse: stream:false + SSE trailer strip.\n`,
    "utf8",
  );

  console.log("ask_llm_success=" + llm_success);
  console.log("pipe_ok=" + pipe_ok);
  console.log("hops_used=" + hops);
  console.log("result=" + result.result);
  if (!llm_success || !pipe_ok) process.exitCode = 1;
}

// silence unused require for lint
void require;

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
