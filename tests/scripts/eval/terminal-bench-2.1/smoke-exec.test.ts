/**
 * The smoke's two execution guards: the credential refusal and the proxy-env injection.
 *
 * Why these two live together (issue 1219 audit follow-up): they are the only places in the
 * smoke that touch the `docker` command line, and each carried a way for the artifact to
 * outrun the evidence.
 *
 *   1. `assertNoCredentials` built its refusal from `[...named, ...leaked]`, where `leaked`
 *      holds the DETECTED VALUES. The guard correctly refused an operator who fat-fingered
 *      `--container-env MINIMAX_API_KEY=sk-…` and then printed the full key to stderr, i.e.
 *      into CI logs. A refusal must name the variable and measure the value; it may never
 *      print the value.
 *   2. `proxyEnvInjected` was a literal `true` in the report while `injectProxyEnv` returns
 *      argv unchanged when no proxy variable is set, so a run on a host with no `HTTP_PROXY`
 *      published an assertion it had not done.
 *
 * The pins state exactly what the message may carry: the variable NAME and the value's
 * LENGTH, and no run of the secret itself. `PERMITTED_MIN_RUN` is the deliberate allowance —
 * zero characters — so the test fails on any echo, not merely on the full value.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

import type { ExecFn } from "../../../../scripts/eval/terminal-bench-2.1/docker.ts";
import {
  assertNoCredentials,
  guardedExec,
  injectProxyEnv,
  proxyEnvInjected,
} from "../../../../scripts/eval/terminal-bench-2.1/smoke-exec.ts";

/** Not a credential: a synthetic shape, so a scanner or a reader cannot mistake it for one. */
const FAKE_KEY = "sk-FAKE-0123456789abcdef0123456789abcdef";
const IMAGE = "python:3.11-slim";
/** Deliberate allowance for the refusal message: it may quote NOTHING of the secret. */
const PERMITTED_MIN_RUN = 0;
const RUN = PERMITTED_MIN_RUN + 4;

const PROXY_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
];
const KEY_NAMES = [
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
];
const CONTROLLED = [...PROXY_NAMES, ...KEY_NAMES];

/**
 * Apply exactly `applied` for the duration of `body`, then restore the host's own values.
 * Every controlled name is cleared first, so an inherited proxy or key cannot decide a result.
 */
async function withEnv<T>(
  applied: Readonly<Record<string, string>>,
  body: () => T | Promise<T>
): Promise<T> {
  const saved = new Map(CONTROLLED.map((name) => [name, process.env[name]]));
  for (const name of CONTROLLED) delete process.env[name];
  for (const [name, value] of Object.entries(applied))
    process.env[name] = value;
  try {
    return await body();
  } finally {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

/** The refusal message, or `""` when the guard let the argv through. */
function refusalFor(args: ReadonlyArray<string>): string {
  try {
    assertNoCredentials(args);
    return "";
  } catch (error) {
    return String((error as Error).message);
  }
}

/** Every contiguous run of at least `PERMITTED_MIN_RUN + 1` characters of the secret. */
function secretRuns(secret: string): ReadonlyArray<string> {
  const runs: string[] = [];
  for (let i = 0; i + RUN <= secret.length; i += 1)
    runs.push(secret.slice(i, i + RUN));
  return runs;
}

describe("the credential guard refuses without echoing the secret", () => {
  it("still refuses when a secret NAME reaches the docker argv", async () => {
    const message = await withEnv({ MINIMAX_API_KEY: FAKE_KEY }, () =>
      refusalFor(["run", "--rm", IMAGE, "-e", `MINIMAX_API_KEY=${FAKE_KEY}`])
    );

    assert.notEqual(
      message,
      "",
      "the guard must still refuse: this is the refusal a fat-fingered --container-env gets"
    );
    assert.ok(
      message.includes("MINIMAX_API_KEY"),
      `the refusal must stay actionable by naming the variable; got: ${message}`
    );
  });

  it("prints no run of the secret value, only its name and length", async () => {
    const message = await withEnv({ MINIMAX_API_KEY: FAKE_KEY }, () =>
      refusalFor(["run", "-e", `MINIMAX_API_KEY=${FAKE_KEY}`])
    );

    for (const run of secretRuns(FAKE_KEY))
      assert.ok(
        !message.includes(run),
        `the refusal quoted ${JSON.stringify(run)} of the secret; the message may carry at most ${PERMITTED_MIN_RUN} characters of it; got: ${message}`
      );
    assert.ok(
      !message.includes(FAKE_KEY),
      `the refusal printed the whole key into a log; got: ${message}`
    );
    assert.ok(
      message.includes(String(FAKE_KEY.length)),
      `the value's length is the one non-reversible fact the refusal may keep, so the operator can tell a pasted key from a truncated one; got: ${message}`
    );
  });

  it("redacts a leaked value that arrives without a recognised variable name", async () => {
    const message = await withEnv({ OPENAI_API_KEY: FAKE_KEY }, () =>
      refusalFor(["run", "-e", `INTERNAL_TOKEN=${FAKE_KEY}`])
    );

    assert.notEqual(
      message,
      "",
      "a value matching a live credential must be refused wherever it appears"
    );
    for (const run of secretRuns(FAKE_KEY))
      assert.ok(
        !message.includes(run),
        `an unrecognised variable name must not become an excuse to echo the value; the message may carry at most ${PERMITTED_MIN_RUN} characters of it; got: ${message}`
      );
  });

  it("redacts a bare secret token with no assignment at all", async () => {
    const message = await withEnv({ ANTHROPIC_API_KEY: FAKE_KEY }, () =>
      refusalFor(["run", "--env", FAKE_KEY])
    );

    assert.notEqual(message, "", "a bare credential argument must be refused");
    for (const run of secretRuns(FAKE_KEY))
      assert.ok(
        !message.includes(run),
        `a bare token must be described, never quoted; got: ${message}`
      );
  });

  it("lets a clean argv through", async () => {
    const message = await withEnv({ MINIMAX_API_KEY: FAKE_KEY }, () =>
      refusalFor(["run", "--rm", "-v", "/host:/logs", IMAGE])
    );

    assert.equal(
      message,
      "",
      `only a credential may be refused, or the smoke cannot run on a host that HAS a key; got: ${message}`
    );
  });

  it("refuses before the docker process starts", async () => {
    let started = false;
    const base: ExecFn = async () => {
      started = true;
      return { stdout: "", stderr: "", code: 0 };
    };
    const guarded = guardedExec(base, {
      dropMounts: [],
      injectProxyEnv: false,
    });

    await withEnv({ MINIMAX_API_KEY: FAKE_KEY }, () =>
      assert.rejects(
        () =>
          guarded("docker", ["run", "-e", `MINIMAX_API_KEY=${FAKE_KEY}`], {
            timeoutMs: 1_000,
          }),
        /refuses to run/,
        "the guard is a refusal, not a warning: nothing may reach the daemon"
      )
    );
    assert.equal(
      started,
      false,
      "the guard runs BEFORE the exec, or the credential is already in the process table"
    );
  });
});

describe("proxyEnvInjected reflects the flags actually injected", () => {
  const ARGV = ["run", "-d", "python:3.11-slim", "sleep", "1"];

  it("is false on a host with no proxy variable set, and injects nothing", async () => {
    await withEnv({}, () => {
      assert.equal(
        proxyEnvInjected(),
        false,
        "no proxy variable means no `-e` flag, so the report may not claim injection"
      );
      assert.deepEqual(
        injectProxyEnv(ARGV),
        ARGV,
        "injectProxyEnv returns argv unchanged, so the report must not say otherwise"
      );
    });
  });

  it("is false when every proxy variable is set to the empty string", async () => {
    await withEnv({ HTTP_PROXY: "", HTTPS_PROXY: "" }, () => {
      assert.equal(
        proxyEnvInjected(),
        false,
        "an empty variable injects nothing, so it must not be counted"
      );
    });
  });

  it("is true once a proxy variable is set, and the flag really reaches argv", async () => {
    await withEnv({ HTTP_PROXY: "http://proxy.invalid:8080" }, () => {
      assert.equal(
        proxyEnvInjected(),
        true,
        "a set proxy variable does produce `-e` flags, so the report may claim it"
      );
      assert.deepEqual(
        injectProxyEnv(ARGV),
        [
          "run",
          "-d",
          "-e",
          "HTTP_PROXY=http://proxy.invalid:8080",
          "python:3.11-slim",
          "sleep",
          "1",
        ],
        "the report field and the argv must come from the same helper, or they can disagree"
      );
    });
  });

  it("the report field is derived from that helper, not a literal", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../scripts/eval/terminal-bench-2.1/smoke.ts",
          import.meta.url
        )
      ),
      "utf8"
    );

    assert.doesNotMatch(
      source,
      /proxyEnvInjected:\s*true\b/,
      "a literal `true` is the defect: on a host with no proxy variable nothing is injected, so the report asserted something it did not do"
    );
    assert.match(
      source,
      /proxyEnvInjected:\s*proxyEnvInjected\(\)/,
      `the report field must read the helper that produced the flags; source: ${source.match(/proxyEnvInjected[^\n]*/g)?.join(" | ")}`
    );
  });
});
