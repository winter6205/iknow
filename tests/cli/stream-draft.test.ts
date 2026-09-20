import { describe, it, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { createStreamDraft } from "../../src/cli/stream-draft.js";
import type { HarnessStreamEvent } from "../../src/harness/stream.js";

/**
 * Unit tests for the stream-draft shared layer.
 *
 * The masking behavior depends on `currentSecretValues()` freshly reading
 * process.env: the **non-empty** values of variable names matching
 * `SECRET_PATTERN` (/API[_-]?KEY|SECRET|TOKEN|PASSWD|PASSWORD|PRIVATE[_-]?KEY/i).
 * `ANTHROPIC_AUTH_TOKEN` matches that pattern and always appears in
 * `configuredSecretNames()` (settings.llm.apiKey placeholder + SECRET_PATTERN
 * fallback), so injecting a real secret value via `ANTHROPIC_AUTH_TOKEN` is
 * captured by `masked()`.
 *
 * Each case restores the env vars it changed at teardown to avoid polluting other tests.
 */

/** Same source as env-isolation.ts SECRET_PATTERN; used to clean up secret envs written by tests. */
const SECRET_PATTERN =
  /API[_-]?KEY|SECRET|TOKEN|PASSWD|PASSWORD|PRIVATE[_-]?KEY/i;

const SECRET = "sk-abc123";

/** Records env vars overwritten/deleted; restored together in afterEach. */
const touched = new Map<string, string | undefined>();

function setSecretEnv(name: string, value: string | undefined): void {
  if (!touched.has(name)) touched.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function clearAllSecretEnvs(): void {
  for (const name of Object.keys(process.env)) {
    if (SECRET_PATTERN.test(name)) setSecretEnv(name, undefined);
  }
}

afterEach(() => {
  for (const [name, original] of touched) {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  touched.clear();
  // Notifications are async after throttling; clean up any leftover fake timers.
  vi.useRealTimers();
});

describe("createStreamDraft", () => {
  it("正常路径:命中 secret 的文本在 masked() 中遮蔽为 ***", () => {
    setSecretEnv("ANTHROPIC_AUTH_TOKEN", SECRET);
    const draft = createStreamDraft();
    draft.append({ type: "text_delta", text: `hello ${SECRET} rest` });
    assert.equal(draft.raw(), `hello ${SECRET} rest`);
    assert.equal(draft.masked(), "hello *** rest");
  });

  it("跨 delta 边界的截断密钥在累积后整段遮蔽", () => {
    setSecretEnv("ANTHROPIC_AUTH_TOKEN", SECRET);
    const draft = createStreamDraft();
    draft.append({ type: "text_delta", text: "探路 " });
    draft.append({ type: "text_delta", text: "sk-" });
    draft.append({ type: "text_delta", text: "ab" });
    draft.append({ type: "text_delta", text: "c123" });
    assert.equal(draft.masked(), "探路 ***");
    assert.equal(draft.raw(), `探路 ${SECRET}`);
  });

  it("空 delta 不改变 raw()", () => {
    const draft = createStreamDraft();
    draft.append({ type: "text_delta", text: "a" });
    draft.append({ type: "text_delta", text: "" });
    assert.equal(draft.raw(), "a");
  });

  it("无密钥值时 masked() === raw()", () => {
    clearAllSecretEnvs();
    const draft = createStreamDraft();
    draft.append({ type: "text_delta", text: "plain text" });
    assert.equal(draft.masked(), draft.raw());
    assert.equal(draft.masked(), "plain text");
  });

  it("tool_call_start 不产生文本", () => {
    const draft = createStreamDraft();
    draft.append({
      type: "tool_call_start",
      name: "web_search",
      id: "toolu_web_1",
    });
    assert.equal(draft.raw(), "");
    assert.equal(draft.masked(), "");
  });

  it("thinking_delta 累加进独立 thinking 缓冲,不污染 answer 缓冲", () => {
    const draft = createStreamDraft();
    draft.append({ type: "text_delta", text: "答 " });
    draft.append({ type: "thinking_delta", text: "思考 " });
    draft.append({ type: "text_delta", text: "案" });
    draft.append({ type: "thinking_delta", text: "继续" });
    assert.equal(draft.raw(), "答 案");
    // text_delta closes the previous thinking segment; a later thinking_delta starts a new buffer.
    assert.equal(draft.thinkingRaw(), "继续");
  });

  it("thinkingSeconds:无 thinking_delta 返回 0", () => {
    const draft = createStreamDraft();
    assert.equal(draft.thinkingSeconds(), 0);
  });

  it("thinkingSeconds:首 thinking_delta 惰性打点，基于打点时刻计算", () => {
    vi.useFakeTimers();
    const draft = createStreamDraft();
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    draft.append({ type: "thinking_delta", text: "想" });
    // After the first delta lazily stamps t0, 7500ms → floor = 7s (measurement starts at the
    // first delta — pure thinking time, excluding the "waiting for thinking" window from turn start).
    assert.equal(draft.thinkingSeconds(t0 + 7500), 7);
    // 1Hz-tick snapshot undershoot: 1300ms must also report a second (floor=1, sub-second not swallowed).
    assert.equal(draft.thinkingSeconds(t0 + 1300), 1);
    // Under 1s → 0 (sub-second).
    assert.equal(draft.thinkingSeconds(t0 + 500), 0);
  });

  it("thinkingSeconds:后续 thinking_delta 不覆盖首次打点", () => {
    vi.useFakeTimers();
    const draft = createStreamDraft();
    const t0 = 5_000_000;
    vi.setSystemTime(t0);
    draft.append({ type: "thinking_delta", text: "先想" });
    vi.setSystemTime(t0 + 5000);
    draft.append({ type: "thinking_delta", text: "再想" });
    // Measured from the **first** delta stamp (t0 → t0+7000 = 7s), not the second
    // (t0+5000 → only 2s) — the lazy stamp happens once; later deltas don't overwrite it.
    assert.equal(draft.thinkingSeconds(t0 + 7000), 7);
  });

  it("thinkingSeconds:子秒 thinking 仍打点（当帧 0，随时间增长）", () => {
    vi.useFakeTimers();
    const draft = createStreamDraft();
    const t0 = 3_000_000;
    vi.setSystemTime(t0);
    draft.append({ type: "thinking_delta", text: "想" });
    // The lazy stamp takes effect at append time; under 1s in that frame → 0, but the start
    // point is not swallowed — it grows normally afterwards (3s later = 3, not 0/NaN).
    assert.equal(draft.thinkingSeconds(t0), 0);
    assert.equal(draft.thinkingSeconds(t0 + 3000), 3);
  });

  it("thinkingSeconds:reset 后清零", () => {
    vi.useFakeTimers();
    const draft = createStreamDraft();
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    draft.append({ type: "thinking_delta", text: "想" });
    draft.reset();
    assert.equal(draft.thinkingSeconds(), 0);
    // After reset, no longer computes from the old stamp.
    assert.equal(draft.thinkingSeconds(2_000_000), 0);
  });

  it("thinking_delta 触发 subscribe 通知(节流 timer flush 后)", () => {
    vi.useFakeTimers();
    const draft = createStreamDraft();
    let calls = 0;
    draft.subscribe(() => {
      calls += 1;
    });
    draft.append({ type: "thinking_delta", text: "先想" });
    // Throttled: notifications go through a 50ms timer batch; nothing fires before flush.
    assert.equal(calls, 0);
    vi.advanceTimersByTime(50);
    assert.equal(calls, 1);
    assert.equal(draft.thinkingRaw(), "先想");
  });

  it("thinkingRaw / thinkingMasked 一致性:thinking 命中密钥也遮蔽", () => {
    setSecretEnv("ANTHROPIC_AUTH_TOKEN", SECRET);
    const draft = createStreamDraft();
    draft.append({ type: "thinking_delta", text: `思考中:${SECRET}` });
    assert.equal(draft.thinkingRaw(), `思考中:${SECRET}`);
    assert.equal(draft.thinkingMasked(), "思考中:***");
  });

  it("reset 同时清空 answer + thinking 两缓冲", () => {
    const draft = createStreamDraft();
    draft.append({ type: "text_delta", text: "答" });
    draft.append({ type: "thinking_delta", text: "想" });
    assert.equal(draft.raw(), "答");
    assert.equal(draft.thinkingRaw(), "想");
    draft.reset();
    assert.equal(draft.raw(), "");
    assert.equal(draft.thinkingRaw(), "");
  });

  it("reset 清空累积,之后可重新累积", () => {
    const draft = createStreamDraft();
    draft.append({ type: "text_delta", text: "gone" });
    assert.equal(draft.raw(), "gone");
    draft.reset();
    assert.equal(draft.raw(), "");
    assert.equal(draft.masked(), "");
    draft.append({ type: "text_delta", text: "again" });
    assert.equal(draft.raw(), "again");
  });

  it("subscribe 在 append 后通知(节流 timer flush 后);unsubscribe 幂等且不再通知", () => {
    vi.useFakeTimers();
    const draft = createStreamDraft();
    let calls = 0;
    const listener = (): void => {
      calls += 1;
    };
    draft.subscribe(listener);
    draft.append({ type: "text_delta", text: "x" });
    // Notification goes through the 50ms batch; nothing fires before flush.
    assert.equal(calls, 0);
    vi.advanceTimersByTime(50);
    assert.equal(calls, 1);
    const unsubscribe = draft.subscribe(listener); // duplicate subscribe deduplicates
    draft.append({ type: "text_delta", text: "y" });
    vi.advanceTimersByTime(50);
    assert.equal(calls, 2);
    unsubscribe();
    unsubscribe(); // idempotent
    draft.append({ type: "text_delta", text: "z" });
    vi.advanceTimersByTime(50);
    assert.equal(calls, 2);
  });

  it("观察者异常被隔离:一个 listener throw 不影响其他 listener 与 append", () => {
    vi.useFakeTimers();
    const draft = createStreamDraft();
    let healthyCalls = 0;
    draft.subscribe(() => {
      throw new Error("listener boom (D3 swallow)");
    });
    draft.subscribe(() => {
      healthyCalls += 1;
    });
    draft.append({ type: "text_delta", text: "x" });
    // healthyCalls stays 0 before flush (the batch is not due yet).
    assert.equal(healthyCalls, 0);
    vi.advanceTimersByTime(50);
    // Must not throw; the healthy listener still gets notified.
    assert.equal(healthyCalls, 1);
    assert.equal(draft.raw(), "x");
  });

  it("多个 listener 各自收到通知;unsubscribe 只移除自身", () => {
    vi.useFakeTimers();
    const draft = createStreamDraft();
    let a = 0;
    let b = 0;
    const unsubA = draft.subscribe(() => {
      a += 1;
    });
    const unsubB = draft.subscribe(() => {
      b += 1;
    });
    draft.append({ type: "text_delta", text: "x" });
    vi.advanceTimersByTime(50);
    assert.equal(a, 1);
    assert.equal(b, 1);
    unsubA();
    draft.append({ type: "text_delta", text: "y" });
    vi.advanceTimersByTime(50);
    assert.equal(a, 1);
    assert.equal(b, 2);
    unsubB();
  });

  it("T5: 300 个连续 delta 批合并 — 通知次数远少于 300(每 50ms 一次)", () => {
    vi.useFakeTimers();
    const draft = createStreamDraft();
    let calls = 0;
    draft.subscribe(() => {
      calls += 1;
    });
    // 300 consecutive short deltas spanning <50ms → coalesce into 1 notification (batched within the time window).
    for (let i = 0; i < 300; i++) {
      draft.append({ type: "text_delta", text: "x" });
    }
    // Nothing fires before flush.
    assert.equal(calls, 0);
    vi.advanceTimersByTime(50);
    assert.equal(calls, 1, "300 delta 应合并为 1 次通知(非每 delta 一次)");
    assert.equal(draft.raw().length, 300);
  });

  it("T5: 累积 ≥384 字符立即 flush,不等 50ms 窗口", () => {
    vi.useFakeTimers();
    const draft = createStreamDraft();
    let calls = 0;
    draft.subscribe(() => {
      calls += 1;
    });
    // A single 383-char append → below threshold, no immediate flush.
    draft.append({ type: "text_delta", text: "a".repeat(383) });
    assert.equal(calls, 0);
    // 2 more chars → cumulative 385 ≥ 384 → immediate flush.
    draft.append({ type: "text_delta", text: "bb" });
    assert.equal(calls, 1, "跨 delta 累积 ≥384 字符应立即 flush");
    assert.equal(draft.raw().length, 385);
  });

  it("sealText: 当前无文本时 no-op，sealedCount 仍为 0", () => {
    const draft = createStreamDraft();
    draft.sealText();
    assert.equal(draft.sealedCount(), 0);
    assert.deepEqual(draft.maskedSegments(), []);
  });

  it("sealText: 冻结当前段后后续 text_delta 进入新段；masked() 仍为全量拼接", () => {
    const draft = createStreamDraft();
    draft.append({ type: "text_delta", text: "first" });
    draft.sealText();
    assert.equal(draft.sealedCount(), 1);
    draft.append({ type: "text_delta", text: "second" });
    assert.deepEqual(draft.maskedSegments(), ["first", "second"]);
    assert.equal(draft.raw(), "firstsecond");
    assert.equal(draft.masked(), "firstsecond");
  });

  it("sealText: 连续两次空 seal 不产空段（连续 tool 共用同一 epoch）", () => {
    const draft = createStreamDraft();
    draft.append({ type: "text_delta", text: "a" });
    draft.sealText();
    draft.sealText();
    assert.equal(draft.sealedCount(), 1);
    assert.deepEqual(draft.maskedSegments(), ["a"]);
  });

  it("sealText: 多段 overflow 与 reset 清空", () => {
    const draft = createStreamDraft();
    draft.append({ type: "text_delta", text: "s0" });
    draft.sealText();
    draft.append({ type: "text_delta", text: "s1" });
    draft.sealText();
    draft.append({ type: "text_delta", text: "s2" });
    assert.equal(draft.sealedCount(), 2);
    assert.deepEqual(draft.maskedSegments(), ["s0", "s1", "s2"]);
    draft.reset();
    assert.equal(draft.sealedCount(), 0);
    assert.deepEqual(draft.maskedSegments(), []);
    draft.sealText();
    assert.equal(draft.sealedCount(), 0);
  });

  it("sealText 后立刻 maskedSegments 同步可读，不依赖 50ms notify", () => {
    vi.useFakeTimers();
    const draft = createStreamDraft();
    let calls = 0;
    draft.subscribe(() => {
      calls += 1;
    });
    draft.append({ type: "text_delta", text: "alpha" });
    draft.sealText();
    draft.append({ type: "text_delta", text: "beta" });
    assert.equal(calls, 0);
    assert.deepEqual(draft.maskedSegments(), ["alpha", "beta"]);
    vi.advanceTimersByTime(50);
    assert.equal(calls, 1);
  });

  it("T5: reset 取消 pending timer,不再 notify", () => {
    vi.useFakeTimers();
    const draft = createStreamDraft();
    let calls = 0;
    draft.subscribe(() => {
      calls += 1;
    });
    draft.append({ type: "text_delta", text: "x" });
    assert.equal(calls, 0);
    draft.reset();
    // reset flushes once immediately (clears the UI draft panel); afterwards the pending timer is cancelled.
    assert.equal(calls, 1);
    vi.advanceTimersByTime(200);
    assert.equal(calls, 1, "reset 后不应再有迟到 notify");
  });
});
