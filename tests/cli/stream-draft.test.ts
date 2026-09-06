import { describe, it, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { createStreamDraft } from "../../src/cli/stream-draft.js";
import type { HarnessStreamEvent } from "../../src/harness/stream.js";

/**
 * T2 (#175): stream-draft 共享层单测。
 *
 * 遮蔽行为依赖 `currentSecretValues()` 现取 process.env 中命中了
 * `SECRET_PATTERN`(/API[_-]?KEY|SECRET|TOKEN|PASSWD|PASSWORD|PRIVATE[_-]?KEY/i)
 * 的变量名下的**非空**值。`ANTHROPIC_AUTH_TOKEN` 命中该 pattern,且始终出现在
 * `configuredSecretNames()`(settings.llm.apiKey 占位符 + SECRET_PATTERN 兜底),
 * 故测试用 `ANTHROPIC_AUTH_TOKEN` 注入真实 secret 值即可被 `masked()` 捕获。
 *
 * 每个用例结束都恢复被改动的 env 变量,避免污染其他测试。
 */

/** 与 env-isolation.ts SECRET_PATTERN 同源,用于清理测试写入的密钥 env。 */
const SECRET_PATTERN =
  /API[_-]?KEY|SECRET|TOKEN|PASSWD|PASSWORD|PRIVATE[_-]?KEY/i;

const SECRET = "sk-abc123";

/** 记录被改写/删除的 env 变量,afterEach 统一还原。 */
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
  // T5: 节流后通知异步,清理可能残留的 fake timer。
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
    // text_delta 收起上一段思考；后一段 thinking_delta 是新缓冲。
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
    // 首 delta 惰性打点后 7500ms → floor = 7s（计算起点 = 首 delta 时刻，
    // 纯思考时长，不含 turn 启动→首 delta 的「等待思考」时段）。
    assert.equal(draft.thinkingSeconds(t0 + 7500), 7);
    // 1Hz tick 快照偏小问题：1300ms 也应有秒数（floor=1，子秒不吞）。
    assert.equal(draft.thinkingSeconds(t0 + 1300), 1);
    // 未满 1s → 0（子秒）。
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
    // 从**首次** delta 打点起算（t0 → t0+7000 = 7s），而非第二次 delta
    // （t0+5000 → 仅 2s）—— 惰性打点只发生一次，后续 delta 不覆盖。
    assert.equal(draft.thinkingSeconds(t0 + 7000), 7);
  });

  it("thinkingSeconds:子秒 thinking 仍打点（当帧 0，随时间增长）", () => {
    vi.useFakeTimers();
    const draft = createStreamDraft();
    const t0 = 3_000_000;
    vi.setSystemTime(t0);
    draft.append({ type: "thinking_delta", text: "想" });
    // 惰性打点于 append 时生效；当帧未满 1s → 0，但不吞掉计时起点——
    // 之后随时间正常增长（3s 后 = 3，非 0/NaN）。
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
    // reset 后不再从旧打点计算。
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
    // T5 节流:通知经 50ms timer 批处理,flush 前不触发。
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
    // T5:通知走 50ms 批处理;flush 前不触发。
    assert.equal(calls, 0);
    vi.advanceTimersByTime(50);
    assert.equal(calls, 1);
    const unsubscribe = draft.subscribe(listener); // 重复订阅去重
    draft.append({ type: "text_delta", text: "y" });
    vi.advanceTimersByTime(50);
    assert.equal(calls, 2);
    unsubscribe();
    unsubscribe(); // 幂等
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
    // flush 前 healthyCalls 仍为 0(批处理未到)。
    assert.equal(healthyCalls, 0);
    vi.advanceTimersByTime(50);
    // 必须不 throw;健康 listener 仍收到通知。
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
    // 连续 300 个短 delta,跨度 <50ms → 应合并为 1 次通知(时间窗内批处理)。
    for (let i = 0; i < 300; i++) {
      draft.append({ type: "text_delta", text: "x" });
    }
    // 未 flush 前 0 次。
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
    // 单次 append 383 字符 → 未达阈值,不立即 flush。
    draft.append({ type: "text_delta", text: "a".repeat(383) });
    assert.equal(calls, 0);
    // 再来 2 字符 → 累积 385 ≥ 384 → 立即 flush。
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
    // reset 立即 flush 一次(清 UI 草稿面板),之后 pending timer 已取消。
    assert.equal(calls, 1);
    vi.advanceTimersByTime(200);
    assert.equal(calls, 1, "reset 后不应再有迟到 notify");
  });
});
