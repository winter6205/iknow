/**
 * ntfy publisher (spec specs/remote-sync.md §4.6, plan task 6).
 *
 * Pins:
 *  - approval / turn-end messages carry only the event kind and tool name, with
 *    the specified title, priority, tag and `text/plain; charset=utf-8` body;
 *  - the turn-end notice is gated by `turnEndMinMs` (default 30000, 0 disables
 *    the gate);
 *  - publishing is fire-and-forget with a 5 s abort timeout, never retried and
 *    never thrown to the caller;
 *  - the first delivery failure per publisher raises exactly one notice, later
 *    failures stay silent, and `close()` aborts in-flight work and is idempotent;
 *  - `resolveNtfyToken` resolves a literal or a placeholder exactly like
 *    `llm.apiKey` (process env first, then `.env` / `.env.local`) and never
 *    echoes the value;
 *  - a resolved token joins the output-mask registry.
 *
 * All tokens / topics / env names here are synthetic; no real secret or real
 * `.env` value is read or asserted.
 */
import { afterEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNtfyPublisher,
  resolveNtfyToken,
} from "../../src/remote-api/notify-ntfy.ts";
import {
  clearActiveExtraSecrets,
  createOutputMask,
  currentSecretValues,
} from "../../src/harness/sandbox/index.ts";

const BASE = {
  url: "https://ntfy.example.test",
  topic: "iknow-test-topic",
} as const;

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

/** Fake fetch that records every request and answers with `respond`. */
function recorder(
  respond: () => Promise<Response> = async () =>
    new Response(null, { status: 200 })
): { calls: Recorded[]; fetchImpl: typeof fetch } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** Fake fetch that never settles until its request signal aborts. */
function pendingRecorder(): {
  calls: number;
  aborted: boolean;
  fetchImpl: typeof fetch;
} {
  const state = { calls: 0, aborted: false };
  const fetchImpl = (async (
    _input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ) => {
    state.calls += 1;
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        state.aborted = true;
        reject(new Error("synthetic abort"));
        return;
      }
      signal?.addEventListener("abort", () => {
        state.aborted = true;
        reject(new Error("synthetic abort"));
      });
    });
  }) as typeof fetch;
  return {
    get calls() {
      return state.calls;
    },
    get aborted() {
      return state.aborted;
    },
    fetchImpl,
  };
}

/** Headers as the publisher passes them (a plain record, by contract). */
function headersOf(init: RequestInit): Record<string, string> {
  assert.ok(init.headers !== undefined);
  return init.headers as unknown as Record<string, string>;
}

/** Let detached fire-and-forget work settle on real timers. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  process.chdir(originalCwd);
  clearActiveExtraSecrets("remote:notify");
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("createNtfyPublisher", () => {
  it("publishes an approval as one minimal message", async () => {
    const { calls, fetchImpl } = recorder();
    const publisher = createNtfyPublisher({ settings: BASE, fetchImpl });

    publisher.approvalPending({ tool: "bash" });
    await flush();

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, "https://ntfy.example.test/iknow-test-topic");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.body, "bash is waiting for approval");
    const headers = headersOf(call.init);
    assert.deepEqual(Object.keys(headers).sort(), [
      "Content-Type",
      "Priority",
      "Tags",
      "Title",
    ]);
    assert.equal(headers.Title, "iknow: approval needed");
    assert.equal(headers.Priority, "high");
    assert.equal(headers.Tags, "warning");
    assert.equal(headers["Content-Type"], "text/plain; charset=utf-8");
    publisher.close();
  });

  it("emits one message per approval call", async () => {
    const { calls, fetchImpl } = recorder();
    const publisher = createNtfyPublisher({ settings: BASE, fetchImpl });

    publisher.approvalPending({ tool: "bash" });
    publisher.approvalPending({ tool: "read" });
    await flush();

    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.body, "bash is waiting for approval");
    assert.equal(calls[1].init.body, "read is waiting for approval");
    publisher.close();
  });

  it("adds a bearer header for a resolved token and omits it otherwise", async () => {
    const token = "synthetic-ntfy-token-a1b2c3";
    const withToken = recorder();
    const publisherWithToken = createNtfyPublisher({
      settings: { ...BASE, token },
      fetchImpl: withToken.fetchImpl,
    });
    publisherWithToken.approvalPending({ tool: "bash" });
    await flush();
    assert.equal(
      headersOf(withToken.calls[0].init).Authorization,
      `Bearer ${token}`
    );
    publisherWithToken.close();

    const withoutToken = recorder();
    const publisherWithoutToken = createNtfyPublisher({
      settings: { ...BASE, token: "${IKNOW_NTFY_TOKEN_UNRESOLVED_TEST}" },
      fetchImpl: withoutToken.fetchImpl,
      resolveToken: () => undefined,
    });
    publisherWithoutToken.approvalPending({ tool: "bash" });
    await flush();
    assert.equal(
      "Authorization" in headersOf(withoutToken.calls[0].init),
      false
    );
    publisherWithoutToken.close();
  });

  it("sends nothing when url or topic is empty", async () => {
    const { calls, fetchImpl } = recorder();
    const noUrl = createNtfyPublisher({
      settings: { url: "", topic: "t" },
      fetchImpl,
    });
    const noTopic = createNtfyPublisher({
      settings: { url: "https://ntfy.example.test", topic: "" },
      fetchImpl,
    });
    noUrl.approvalPending({ tool: "bash" });
    noTopic.turnEnded({ status: "completed", durationMs: 60_000 });
    await flush();
    assert.equal(calls.length, 0);
    noUrl.close();
    noTopic.close();
  });

  it("gates the turn-end message on the default 30000 ms threshold", async () => {
    const { calls, fetchImpl } = recorder();
    const publisher = createNtfyPublisher({ settings: BASE, fetchImpl });

    publisher.turnEnded({ status: "completed", durationMs: 29_999 });
    await flush();
    assert.equal(calls.length, 0);

    publisher.turnEnded({ status: "completed", durationMs: 30_000 });
    await flush();
    assert.equal(calls.length, 1);
    const headers = headersOf(calls[0].init);
    assert.equal(calls[0].init.body, "completed");
    assert.equal(headers.Title, "iknow: turn finished");
    assert.equal(headers.Priority, "default");
    publisher.close();
  });

  it("honours a custom 0 threshold and maps every terminal status", async () => {
    const { calls, fetchImpl } = recorder();
    const publisher = createNtfyPublisher({
      settings: { ...BASE, turnEndMinMs: 0 },
      fetchImpl,
    });

    publisher.turnEnded({ status: "completed", durationMs: 0 });
    publisher.turnEnded({ status: "cancelled", durationMs: 0 });
    publisher.turnEnded({ status: "failed", durationMs: 0 });
    await flush();

    assert.deepEqual(
      calls.map((call) => call.init.body),
      ["completed", "cancelled", "failed"]
    );
    publisher.close();
  });

  it("aborts after 5 s and reports the failure once", async () => {
    vi.useFakeTimers();
    const pending = pendingRecorder();
    const notices: string[] = [];
    const publisher = createNtfyPublisher({
      settings: BASE,
      fetchImpl: pending.fetchImpl,
      onNotice: (text) => notices.push(text),
    });

    publisher.approvalPending({ tool: "bash" });
    assert.equal(pending.aborted, false);
    await vi.advanceTimersByTimeAsync(4_999);
    assert.equal(pending.aborted, false);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(pending.aborted, true);
    assert.deepEqual(notices, [
      "iknow: notification delivery failed (no further notices this session)",
    ]);
    publisher.close();
  });

  it("notices the first failure once and stays silent afterwards", async () => {
    const notices: string[] = [];
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      throw new Error("synthetic network failure");
    }) as typeof fetch;
    const publisher = createNtfyPublisher({
      settings: BASE,
      fetchImpl,
      onNotice: (text) => notices.push(text),
    });

    publisher.approvalPending({ tool: "bash" });
    await flush();
    publisher.approvalPending({ tool: "bash" });
    await flush();

    assert.equal(attempts, 2);
    assert.equal(notices.length, 1);
    publisher.close();
  });

  it("keeps a failing publish off the unhandled-rejection path", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const fetchImpl = (async () => {
        throw new Error("synthetic network failure");
      }) as typeof fetch;
      const publisher = createNtfyPublisher({ settings: BASE, fetchImpl });
      publisher.approvalPending({ tool: "bash" });
      await flush();
      assert.deepEqual(unhandled, []);
      publisher.close();
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("close aborts in-flight work, silences later calls and is idempotent", async () => {
    const pending = pendingRecorder();
    const notices: string[] = [];
    const publisher = createNtfyPublisher({
      settings: BASE,
      fetchImpl: pending.fetchImpl,
      onNotice: (text) => notices.push(text),
    });

    publisher.approvalPending({ tool: "bash" });
    publisher.close();
    publisher.close();
    assert.equal(pending.aborted, true);
    assert.equal(notices.length, 0);

    publisher.approvalPending({ tool: "bash" });
    publisher.turnEnded({ status: "completed", durationMs: 60_000 });
    assert.equal(pending.calls, 1);
  });

  it("registers a resolved token with the output mask", async () => {
    const token = "synthetic-ntfy-token-d4e5f6";
    const { fetchImpl } = recorder();
    const publisher = createNtfyPublisher({
      settings: { ...BASE, token },
      fetchImpl,
    });

    assert.ok(currentSecretValues().includes(token));
    assert.equal(
      createOutputMask(currentSecretValues()).mask(`before ${token} after`),
      "before *** after"
    );
    publisher.close();
  });

  it("resolves the default token resolver from opts.cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iknow-ntfy-env-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, ".env"),
      "IKNOW_NTFY_TOKEN_PUBLISHER_CWD_TEST=from-publisher-cwd\n",
      "utf8"
    );
    const { calls, fetchImpl } = recorder();
    const publisher = createNtfyPublisher({
      settings: { ...BASE, token: "${IKNOW_NTFY_TOKEN_PUBLISHER_CWD_TEST}" },
      cwd: dir,
      fetchImpl,
    });

    publisher.approvalPending({ tool: "bash" });
    await flush();

    assert.equal(
      headersOf(calls[0].init).Authorization,
      "Bearer from-publisher-cwd"
    );
    publisher.close();
  });
});

describe("resolveNtfyToken", () => {
  it("returns a literal token verbatim and treats placeholders as unset", () => {
    assert.equal(
      resolveNtfyToken("literal-token-value"),
      "literal-token-value"
    );
    assert.equal(
      resolveNtfyToken("  literal-token-value  "),
      "literal-token-value"
    );
    assert.equal(resolveNtfyToken(undefined), undefined);
    assert.equal(resolveNtfyToken(""), undefined);
    assert.equal(resolveNtfyToken("yes"), undefined);
    assert.equal(resolveNtfyToken("YES"), undefined);
  });

  it("resolves a placeholder from the process environment", () => {
    vi.stubEnv("IKNOW_NTFY_TOKEN_ENV_TEST", "from-process-env");
    assert.equal(
      resolveNtfyToken("${IKNOW_NTFY_TOKEN_ENV_TEST}"),
      "from-process-env"
    );
  });

  it("falls back to the .env / .env.local map in cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iknow-ntfy-env-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, ".env"),
      "IKNOW_NTFY_TOKEN_FILE_TEST=from-env-file\n",
      "utf8"
    );
    await writeFile(
      join(dir, ".env.local"),
      "IKNOW_NTFY_TOKEN_LOCAL_TEST=from-env-local\n",
      "utf8"
    );
    process.chdir(dir);

    assert.equal(
      resolveNtfyToken("${IKNOW_NTFY_TOKEN_FILE_TEST}"),
      "from-env-file"
    );
    assert.equal(
      resolveNtfyToken("${IKNOW_NTFY_TOKEN_LOCAL_TEST}"),
      "from-env-local"
    );
  });

  it("prefers the process environment over the file map", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iknow-ntfy-env-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, ".env"),
      "IKNOW_NTFY_TOKEN_PRIORITY_TEST=from-env-file\n",
      "utf8"
    );
    process.chdir(dir);
    vi.stubEnv("IKNOW_NTFY_TOKEN_PRIORITY_TEST", "from-process-env");

    assert.equal(
      resolveNtfyToken("${IKNOW_NTFY_TOKEN_PRIORITY_TEST}"),
      "from-process-env"
    );
  });

  it("resolves from an explicit cwd without changing process.cwd()", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iknow-ntfy-env-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, ".env"),
      "IKNOW_NTFY_TOKEN_EXPLICIT_CWD_TEST=from-explicit-cwd\n",
      "utf8"
    );

    assert.equal(
      resolveNtfyToken("${IKNOW_NTFY_TOKEN_EXPLICIT_CWD_TEST}", dir),
      "from-explicit-cwd"
    );
    assert.equal(process.cwd(), originalCwd);
  });

  it("returns undefined for unresolvable or malformed placeholders without echoing values", () => {
    const unresolved = resolveNtfyToken("${IKNOW_NTFY_TOKEN_ABSENT_TEST}");
    assert.equal(unresolved, undefined);
    assert.equal(
      resolveNtfyToken("${IKNOW_NTFY_TOKEN_ABSENT_TEST}"),
      undefined
    );
    assert.equal(resolveNtfyToken("${}"), undefined);
    assert.equal(
      resolveNtfyToken("pre-${IKNOW_NTFY_TOKEN_ABSENT_TEST}-post"),
      undefined
    );
  });
});
