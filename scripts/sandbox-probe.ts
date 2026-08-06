import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE_ENV_WHITELIST,
  createBwrapFence,
  createEnvIsolation,
  createFsPolicy,
  createNetworkPolicy,
  createResourceLimits,
} from "../src/harness/sandbox/index.js";
import { createViolationCounter } from "../src/harness/sandbox/violation-handling.js";

const cwd = process.cwd();
const fsPolicy = createFsPolicy({ cwd, home: homedir(), tmpDir: tmpdir() });
const networkPolicy = createNetworkPolicy();
const resourceLimits = createResourceLimits();
const env = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST }).filter(
  process.env
);
function run(command: string) {
  const fence = createBwrapFence({
    command: "bash",
    args: ["-c", command],
    fsPolicy,
    networkPolicy,
    resourceLimits,
    env,
    cwd,
  });
  return spawnSync(fence.argv[0], fence.argv.slice(1), {
    cwd,
    encoding: "utf8",
    env,
  });
}
const checks = [
  ["env isolation", () => run('test -z "$ANTHROPIC_AUTH_TOKEN"')],
  ["fs sensitivity (ssh hidden)", () => run("test ! -e ~/.ssh/id_rsa")],
  ["/etc readonly", () => run("touch /etc/sandbox-probe-write")],
  ["cwd writable", () => run("touch probe-write && rm probe-write && echo ok")],
  ["network denied", () => run("curl -sS https://example.com")],
  ["node runs", () => run("node -v")],
] as const;

// T6 violation handling probe (Node-side; bwrap fence is physical-layer
// only, the violation counter lives in the application layer). Each entry
// returns { ok, detail } instead of a SpawnSyncReturns so the print loop
// can format uniformly.
type ProbeResult = { ok: boolean; detail: string };

const violationChecks: ReadonlyArray<readonly [string, () => ProbeResult]> = [
  [
    "violation mid-escalation",
    (): ProbeResult => {
      // Record 3 mid events → shouldKill on the 3rd.
      const c = createViolationCounter();
      const r1 = c.record({
        tier: "mid",
        tool: "bash",
        input: {},
        message: "[hard_wall] dangerous command",
      });
      const r2 = c.record({
        tier: "mid",
        tool: "bash",
        input: {},
        message: "[hard_wall] dangerous command",
      });
      const r3 = c.record({
        tier: "mid",
        tool: "bash",
        input: {},
        message: "[hard_wall] dangerous command",
      });
      const ok =
        r1.shouldKill === false &&
        r2.shouldKill === false &&
        r3.shouldKill === true &&
        r3.count === 3;
      // Reset and confirm 2 records don't kill (regression check).
      c.reset();
      const r4 = c.record({
        tier: "mid",
        tool: "bash",
        input: {},
        message: "[hard_wall] dangerous command",
      });
      const r5 = c.record({
        tier: "mid",
        tool: "bash",
        input: {},
        message: "[hard_wall] dangerous command",
      });
      const resetOk =
        r4.shouldKill === false &&
        r5.shouldKill === false &&
        c.snapshot() === 2;
      return {
        ok: ok && resetOk,
        detail: `3rd-kill=${r3.shouldKill} reset-2-records=${r5.shouldKill} count=${r5.count}`,
      };
    },
  ],
  [
    "violation high-immediate",
    (): ProbeResult => {
      const c = createViolationCounter();
      const r = c.record({
        tier: "high",
        tool: "bash",
        input: {},
        message: "[escape_attempt]",
      });
      const ok = r.shouldKill === true;
      return {
        ok,
        detail: `high-kill=${r.shouldKill}`,
      };
    },
  ],
];

let passed = 0;
let total = 0;
console.log("sandbox-probe");
for (const [name, check] of checks) {
  total += 1;
  const result = check();
  const ok =
    name === "/etc readonly"
      ? result.status !== 0
      : name === "network denied"
        ? result.status !== 0
        : result.status === 0;
  if (ok) passed++;
  const detail = `${result.stdout?.trim() ?? ""} | ${result.stderr?.trim() ?? ""}`;
  console.log(
    `${ok ? "✓" : "✗"} ${name}${detail !== " | " ? ` (${detail})` : ""}`
  );
}
for (const [name, check] of violationChecks) {
  total += 1;
  const result = check();
  if (result.ok) passed++;
  console.log(
    `${result.ok ? "✓" : "✗"} ${name}${result.detail ? ` (${result.detail})` : ""}`
  );
}
console.log(
  `\n${passed === total ? "all green" : "failures"} (${passed}/${total})`
);
process.exit(passed === total ? 0 : 1);
void join;
