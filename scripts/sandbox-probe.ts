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
  });
}
const checks = [
  ["env isolation", () => run('test -z "$NINE_ROUTER_KEY"')],
  ["fs sensitivity (ssh hidden)", () => run("test ! -e ~/.ssh/id_rsa")],
  ["/etc readonly", () => run("touch /etc/sandbox-probe-write")],
  ["cwd writable", () => run("touch probe-write && rm probe-write && echo ok")],
  ["network denied", () => run("curl -sS https://example.com")],
  ["node runs", () => run("node -v")],
] as const;

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
console.log(
  `\n${passed === total ? "all green" : "failures"} (${passed}/${total})`
);
process.exit(passed === total ? 0 : 1);
void join;
