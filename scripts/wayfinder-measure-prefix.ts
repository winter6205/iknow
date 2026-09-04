/**
 * wayfinder 图「模型面前缀分层与缓存兑现」R2 / R3 的测量脚本（只读，无副作用）。
 *
 * 量三件事：
 *   - R3a：system 各静态段的字节数（哪些段值得挪进断点前）
 *   - R3b：真实项目上 assembleIdentityContext 的实际产出大小
 *   - R2：`visibleSchemas()` 序列化字节数 —— 最小装配 vs 生产全装配两档
 *
 * token 估算用 chars/4 的粗口径 —— 只用来判量级（3K 还是 20K），不用来算钱。
 * 真实 token 数要读 API 回包 usage 或 countTokens，那是本脚本之外的事。
 */
import { IKNOW_IDENTITY_DEFAULT } from "../src/harness/identity/identity.js";
import { IKNOW_SOUL_DEFAULT } from "../src/harness/identity/soul.js";
import { IKNOW_USAGE_DEFAULT } from "../src/harness/identity/usage.js";
import {
  assembleIdentityContext,
  IKNOW_AGENT_STATUS_READ_RULE,
  IKNOW_COORDINATOR_TEXT,
  toolConstraintsSegment,
} from "../src/harness/identity/assemble.js";
// B3 / ADR-0041:`orchestration` 段撤出 system,旧 IKNOW_GRAPH_ORCHESTRATION_TEXT
// 退役 —— 内容并入 graph 模式切换提示(此常量已删,行内注明退场)。
import { IKNOW_GRAPH_MODE_ON_NOTIFICATION } from "../src/harness/graph/notification.js";
import { createDefaultAciRegistry } from "../src/harness/aci/tools/registry.js";

const est = (n: number) => Math.round(n / 4);
const row = (name: string, len: number) =>
  `${name.padEnd(36)} ${String(len).padStart(7)} chars  ~${String(est(len)).padStart(6)} tok`;

const ROOT = "/home/winner/projects/iknow";
const HOME = process.env.HOME ?? "/home/winner";

console.log("=== R3a: system static segments ===");
for (const [n, s] of [
  ["identity", IKNOW_IDENTITY_DEFAULT],
  ["soul", IKNOW_SOUL_DEFAULT],
  ["usage", IKNOW_USAGE_DEFAULT],
  ["agent_status read rule", IKNOW_AGENT_STATUS_READ_RULE],
  ["coordinator (off by default)", IKNOW_COORDINATOR_TEXT],
  [
    "graph_mode on notification (messages-tail)",
    IKNOW_GRAPH_MODE_ON_NOTIFICATION,
  ],
  ["tool constraints (ro worker)", toolConstraintsSegment("readonly")],
] as const) {
  console.log(row(n, s.length));
}

const webEnv = {
  web: {
    proxy: undefined,
    searchUrl: undefined,
    searchBackend: undefined,
    exaApiKey: undefined,
    tavilyApiKey: undefined,
    braveApiKey: undefined,
  },
} as never;

const stub = {} as never;
const surfaces = [
  { label: "minimal (ask-like)", opts: { env: webEnv, sandboxRoot: ROOT } },
  {
    label: "full (tui/serve-like)",
    opts: {
      env: webEnv,
      sandboxRoot: ROOT,
      memoryDir: `${ROOT}/.iknow/memory`,
      todoDir: `${ROOT}/.iknow/todos`,
      traceDir: `${ROOT}/trace`,
      skillCatalog: { available: () => [], all: () => [] } as never,
      subagentManager: stub,
      mcpManager: stub,
      backgroundManager: stub,
      graphAssembly: { enabled: () => true },
      worktreeProvision: (() => {}) as never,
      worktreeEnter: (() => {}) as never,
      worktreeExit: (() => {}) as never,
    },
  },
] as const;

for (const { label, opts } of surfaces) {
  console.log(`\n=== R2: tools -- ${label} ===`);
  try {
    const reg = createDefaultAciRegistry(opts as never);
    const schemas = reg.visibleSchemas();
    const wire = JSON.stringify(schemas);
    console.log(`tool count: ${schemas.length}`);
    console.log(row("visibleSchemas() serialized", wire.length));
    const ranked = schemas
      .map((s) => ({ name: s.name, len: JSON.stringify(s).length }))
      .sort((a, b) => b.len - a.len);
    console.log("--- top 10 fattest ---");
    for (const t of ranked.slice(0, 10)) {
      console.log(row(`  ${t.name}`, t.len));
    }
  } catch (err) {
    console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("\n=== R3b: assembled system prompt (real project) ===");
for (const variant of [
  { label: "tui, static instructions on", staticInstructions: true },
  { label: "tui, no memory/static", staticInstructions: false },
] as const) {
  const text = await assembleIdentityContext({
    projectIdentityRoot: ROOT,
    userHome: HOME,
    bootstrapActive: true,
    memoryEnabled: false,
    ...(variant.staticInstructions ? { staticInstructions: true } : {}),
    agentStatusReadRule: true,
  } as never);
  console.log(row(variant.label, text === undefined ? 0 : text.length));
}
