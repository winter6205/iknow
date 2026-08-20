/**
 * HITL vs /goal auto — real-LLM smoke (#572 gate).
 *
 * Existing probes do not cover this pair:
 *   - i128 always feeds classifier userText = goal.text (no HITL skip)
 *   - i408 uses verify.command = `true` (no completion-judge spawn)
 *   - `printf | tsx src/cli.ts chat` hangs on TTY ask / MCP-held stdin after
 *     stop=completed, so spawn=0 cannot be asserted from a clean EXIT
 *
 * This script drives processChatLine (the chat host that dispatches HITL vs
 * /goal auto) with a real adapter + counting SubAgentManager whose worker
 * re-enters `tsx src/cli.ts --subagent-worker` (t4 production-like spawn).
 *
 * Assertions:
 *   HITL line `你好` → judge spawn count 0
 *   `/goal --max-turns 1 Reply with exactly OK and do not use tools`
 *     → pins goal.text and completion-judge spawn task === goal.text
 *
 * Independent run: npx tsx scripts/i572-verify-goal-gate-real-llm.ts
 * Missing apiKey → stdout skip + exit 0 (same convention as i128/i408).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadIknowEnv } from "../src/config/env.js";
import { resolveVerifyConfig } from "../src/config/verify-config.js";
import { processChatLine } from "../src/cli/chat-session.js";
import type { ChatLineContext } from "../src/cli/chat-session.js";
import { buildHarnessEngine } from "../src/harness/build-engine.js";
import { createNoAskUser } from "../src/harness/permission/ask-user.js";
import { createPermissionModeContext } from "../src/harness/permission/modes.js";
import { createSubAgentManager } from "../src/harness/subagent/manager.js";
import type { SubAgentDefinition } from "../src/harness/subagent/manager.js";
import { SessionStore } from "../src/session-api/store/index.js";

const __filename = fileURLToPath(import.meta.url);
const HERE = dirname(__filename);
const TSX_BIN = join(HERE, "..", "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(HERE, "..", "src", "cli.ts");

const GOAL_TEXT = "Reply with exactly OK and do not use tools";

type SpawnRec = { readonly role: string; readonly task: string };

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/\/.*$/, "");
  }
}

function productionLikeSpawn() {
  return spawn(process.execPath, [TSX_BIN, CLI_ENTRY, "--subagent-worker"], {
    stdio: ["pipe", "pipe", "pipe"] as const,
    env: process.env,
  });
}

async function main(): Promise<void> {
  const env = loadIknowEnv(process.cwd());
  const apiKey = env.llm.apiKey;
  if (!apiKey) {
    console.log(
      "key missing, smoke skipped (need settings.llm.apiKey to run real model)"
    );
    return;
  }

  const ws = mkdtempSync(join(tmpdir(), "i572-ws-"));
  const dataDir = mkdtempSync(join(tmpdir(), "i572-data-"));
  const spawnLog: SpawnRec[] = [];
  const manager = createSubAgentManager({
    spawn: (def: SubAgentDefinition) => {
      spawnLog.push({
        role: typeof def.role === "string" ? def.role : String(def.role),
        task: def.task ?? "",
      });
      return productionLikeSpawn();
    },
  });

  const started = Date.now();
  const built = await buildHarnessEngine({
    env,
    askUser: createNoAskUser(),
    surface: "chat",
    memory: { enabled: false },
    permissionMode: createPermissionModeContext("full_auto"),
    workspaceRoot: ws,
    userHome: ws,
    cwd: ws,
    subagentManager: manager,
  });

  const store = new SessionStore(dataDir);
  const verifyConfig = resolveVerifyConfig(undefined);
  const deps = { ...built.deps, maxTurns: 4 };

  function makeCtx(conversationId: string): ChatLineContext {
    return {
      deps,
      state: {
        messages: Object.freeze([]),
        jsonMode: false,
        session: {},
        conversationId,
      },
      permissionMode: createPermissionModeContext("full_auto"),
      checkpointStore: store,
      subagentManager: manager,
      verifyConfig,
    };
  }

  const hitlId = randomUUID();
  const hitl = await processChatLine({
    line: "你好",
    ctx: makeCtx(hitlId),
  });
  const hitlSession = await store.load(hitlId).catch(() => undefined);
  const hitlJudge = spawnLog.filter((s) => s.role === "judge");
  const afterHitl = spawnLog.length;

  const goalId = randomUUID();
  const goalLine = `/goal --max-turns 1 ${GOAL_TEXT}`;
  const goal = await processChatLine({
    line: goalLine,
    ctx: makeCtx(goalId),
  });
  const goalSession = await store.load(goalId).catch(() => undefined);
  const goalJudge = spawnLog.slice(afterHitl).filter((s) => s.role === "judge");

  await manager.shutdown();
  if (built.shutdown) await built.shutdown();

  const assertions = [
    {
      name: "HITL greeting: completion-judge spawn count === 0",
      pass: hitlJudge.length === 0,
      detail: `judge=${hitlJudge.length} allSpawns=${afterHitl} roles=${JSON.stringify(spawnLog.slice(0, afterHitl).map((s) => s.role))} stopInOutput=${/stop=/.test(hitl.output)}`,
    },
    {
      name: "HITL greeting: session.goal.text unset (not auto-pinned from 你好)",
      pass:
        hitlSession === undefined ||
        hitlSession.goal === undefined ||
        hitlSession.goal.text.length === 0,
      detail: `goal=${JSON.stringify(hitlSession?.goal)}`,
    },
    {
      name: "/goal path ran (processChatLine returned)",
      pass: typeof goal.output === "string",
      detail: `outputPrefix=${JSON.stringify(goal.output.slice(0, 160))} stderr=${goal.stderr ?? ""}`,
    },
    {
      name: "/goal pin: store.goal.text === GOAL_TEXT",
      pass: goalSession?.goal?.text === GOAL_TEXT,
      detail: `actual=${JSON.stringify(goalSession?.goal?.text)} source=${goalSession?.goal?.source}`,
    },
    {
      name: "/goal auto: completion-judge spawned ≥1",
      pass: goalJudge.length >= 1,
      detail: `judge=${goalJudge.length} tasks=${JSON.stringify(goalJudge.map((s) => s.task.slice(0, 80)))}`,
    },
    {
      name: "/goal auto: judge task === goal.text",
      pass: goalJudge.some((s) => s.task === GOAL_TEXT),
      detail: `tasks=${JSON.stringify(goalJudge.map((s) => s.task))}`,
    },
  ];

  const allPass = assertions.every((a) => a.pass);
  const durationMs = Date.now() - started;
  for (const a of assertions) {
    console.log(
      `${a.pass ? "[PASS]" : "[FAIL]"} ${a.name}${a.detail ? ` — ${a.detail}` : ""}`
    );
  }
  console.log(
    `result=${allPass ? "pass" : "fail"} model=${env.llm.model} baseUrl=${hostOf(env.llm.baseUrl)} durationMs=${durationMs}`
  );

  rmSync(ws, { recursive: true, force: true });
  if (allPass) {
    rmSync(dataDir, { recursive: true, force: true });
  } else {
    console.error(`FAIL: dataDir preserved ${dataDir}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
