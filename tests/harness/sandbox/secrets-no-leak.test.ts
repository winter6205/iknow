import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import {
  BASE_ENV_WHITELIST,
  createEnvIsolation,
} from "../../../src/harness/sandbox/env-isolation.js";

function readSandboxSource(): string {
  return readdirSync("src/harness/sandbox")
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(join("src/harness/sandbox", name), "utf8"))
    .join("\n");
}

describe("sandbox secret literal guard", () => {
  it("does not hardcode the canonical LLM key name", () => {
    assert.equal(readSandboxSource().includes("ANTHROPIC_AUTH_TOKEN"), false);
  });
});

// ── ADR-0097: the fence secret-env half-surface does not depend on the network axis ──
// The network axis has fully retired from the fence layer (`--unshare-net` is
// constant); the secret-env handling path stays byte-identical with the default
// branch (envIsolation.filter truncates host-side hits, and no fence option can
// reintroduce a channel). This suite remains as a regression net: any future
// "fence shape change smuggling an env channel" regression gets caught here.
//
// Closed-world adaptation: contract roots (taskRoot/tmp) are validated on disk →
// fixtures use real directories (mkdtemp), no more fake "/workspace" +
// "/tmp/job" paths.
const FIXTURE_CWD = mkdtempSync(join(tmpdir(), "secrets-no-leak-cwd-"));

afterAll(() => {
  rmSync(FIXTURE_CWD, { recursive: true, force: true });
});

describe("sandbox secret env path (network axis retired)", () => {
  function buildArgv(): readonly string[] {
    // mirror bash.ts's assembly-time environment: the env the bwrap fence
    // receives is process.env truncated by envIsolation.filter. Inject a
    // SECRET_PATTERN-shaped env var and assert it never appears in the --setenv list.
    const rawEnv = {
      PATH: "/bin",
      HOME: homedir(),
      SANDBOX_NET_SECRET_KEY: "sk-test-not-real-12345",
    };
    const filtered = createEnvIsolation({
      allowEnv: BASE_ENV_WHITELIST,
    }).filter(rawEnv);
    assert.equal(
      filtered.SANDBOX_NET_SECRET_KEY,
      undefined,
      "env-isolation must strip SECRET_PATTERN hits"
    );
    return createBwrapFence({
      command: "bash",
      args: ["-c", "echo hi"],
      fsPolicy: createFsPolicy({
        tmpDir: tmpdir(),
      }),
      env: filtered,
      cwd: FIXTURE_CWD,
    }).argv;
  }

  it("fence argv 不含 secret env 名/值,且 --unshare-net 恒在", () => {
    const argv = buildArgv();
    // the network axis is always cut: the secret-env half-surface and the netns shape are independent (ADR-0097)
    assert.equal(
      argv.includes("--unshare-net"),
      true,
      "--unshare-net is constant (spec SC1)"
    );
    // neither the secret env name nor its value is in argv
    const flat = argv.join("\n");
    assert.equal(
      flat.includes("SANDBOX_NET_SECRET_KEY"),
      false,
      "fence must not smuggle secret var name"
    );
    assert.equal(
      flat.includes("sk-test-not-real-12345"),
      false,
      "fence must not smuggle secret var value"
    );
  });
});
