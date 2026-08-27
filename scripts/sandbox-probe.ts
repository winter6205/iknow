import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
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
function runSync(command: string, network = false) {
  const fence = createBwrapFence({
    command: "bash",
    args: ["-c", command],
    fsPolicy,
    networkPolicy,
    resourceLimits,
    env,
    cwd,
    network,
  });
  return spawnSync(fence.argv[0], fence.argv.slice(1), {
    cwd,
    encoding: "utf8",
    env,
  });
}
// Async spawn (NOT spawnSync) for the two netns-sensitive checks. The loopback
// listener below lives in THIS process; while spawnSync blocks the event loop
// no callback can run, so curl inside the fence could never reach it.
function runAsync(command: string, network = false): Promise<string> {
  const fence = createBwrapFence({
    command: "bash",
    args: ["-c", command],
    fsPolicy,
    networkPolicy,
    resourceLimits,
    env,
    cwd,
    network,
  });
  return new Promise((resolve) => {
    const child = spawn(fence.argv[0], fence.argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      resolve(`1 | spawn error: ${err.message}`);
    });
    child.on("close", (code) => {
      resolve(`${code ?? "null"} | ${stderr.trim()}`);
    });
  });
}
type ProbeRun = { name: string; run: () => Promise<string> };
const checks: ProbeRun[] = [];
// Sync-status checks (green or expected-fail) still return a fake 0/1 status
// through the same pipe so the assert loop below stays uniform.
function addSyncCheck(
  name: string,
  command: string,
  network = false,
  expectFail = false
): void {
  checks.push({
    name,
    run: async () => {
      const result = runSync(command, network);
      const detail = `${result.stdout?.trim() ?? ""} | ${result.stderr?.trim() ?? ""}`;
      const ok = expectFail ? result.status !== 0 : result.status === 0;
      return `${ok ? "0" : "1"} | ${detail}`;
    },
  });
}
// `network denied` keeps the original external target: the default branch's
// isolated netns must not reach the public internet.
addSyncCheck("env isolation", 'test -z "$ANTHROPIC_AUTH_TOKEN"');
addSyncCheck("fs sensitivity (ssh hidden)", "test ! -e ~/.ssh/id_rsa");
addSyncCheck("/etc readonly", "touch /etc/sandbox-probe-write", false, true);
addSyncCheck("cwd writable", "touch probe-write && rm probe-write && echo ok");
addSyncCheck("host prefix /opt", "test ! -d /opt -o -r /opt");
addSyncCheck(
  "network denied",
  "curl -sS --max-time 5 https://example.com",
  false,
  true
);
addSyncCheck("node runs", "node -v");
// T9b (#503): physical validation of `network: true` moves to a host loopback
// listener. WSL2 drops outbound IPv4 for mount+user-ns combos and the fence's
// /etc/resolv.conf symlink is dangling (no /mnt bind), so example.com can
// never be reached even though the opt-in netns shape is correct. Loopback
// inbound is not subject to the WSL2 egress penalty: the opt-in branch shares
// the host netns and MUST reach the listener, while the default branch runs in
// its own netns whose lo is not up and MUST NOT — a stronger netns-shape
// signal than an external target.
async function startProbeListener(): Promise<{
  port: number;
  stop: () => void;
}> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("probe-listener-ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    stop: () => {
      // Close the listener AND destroy any keep-alive sockets curl left open,
      // otherwise the port/event-loop handle survives past this process.
      server.closeAllConnections();
      server.close();
    },
  };
}

// T6 violation handling probe (Node-side; bwrap fence is physical-layer
// only, the violation counter lives in the application layer). Each entry
// returns { ok, detail } instead of a SpawnSyncReturns so the assert loop
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
async function main(): Promise<void> {
  const listener = await startProbeListener();
  checks.push({
    name: "network opt-in reachable",
    run: () =>
      runAsync(
        `curl -sS --max-time 5 http://127.0.0.1:${listener.port} | grep -q probe-listener-ok`,
        true
      ),
  });
  checks.push({
    name: "network default isolated from host loopback",
    run: async () => {
      // This probe PASSES when curl FAILS: the default branch's own netns
      // must not reach the host loopback listener. Mirror addSyncCheck's
      // mock-status pattern so the assert loop stays uniform.
      const raw = await runAsync(
        `curl -sS --max-time 5 http://127.0.0.1:${listener.port}`,
        false
      );
      const [status, ...rest] = raw.split("|");
      const ok = status.trim() !== "0";
      return `${ok ? "0" : "1"} | ${rest.join("|").trim()}`;
    },
  });
  console.log("sandbox-probe");
  for (const check of checks) {
    total += 1;
    let ok = false;
    let detail = "";
    try {
      const raw = await check.run();
      const [status, ...rest] = raw.split("|");
      ok = status.trim() === "0";
      detail = rest.join("|").trim();
    } catch (err) {
      detail = `probe errored: ${String(err)}`;
    }
    if (ok) passed++;
    console.log(
      `${ok ? "✓" : "✗"} ${check.name}${detail ? ` (${detail})` : ""}`
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
  // Listener lifecycle: started here, stopped on this same path — covers the
  // not-all-green case (the loop above still completes and both async check
  // children are closed by `close` before this line). A failure in the
  // loopback checks themselves never leaks either the child or the port.
  listener.stop();
  process.exitCode = passed === total ? 0 : 1;
}
main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
