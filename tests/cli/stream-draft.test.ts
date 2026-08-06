import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { createStreamDraft } from "../../src/cli/stream-draft.js";
import type { HarnessStreamEvent } from "../../src/harness/stream.js";

/**
 * T2 (#175): stream-draft 共享层单测。
 *
 * 遮蔽行为依赖 `currentSecretValues()` 现取 process.env 中命中了
 * `SECRET_PATTERN`(/API[_-]?KEY|SECRET|TOKEN|PASSWD|PASSWORD|PRIVATE[_-]?KEY/i)
 * 的变量名下的**非空**值。`ANTHROPIC_AUTH_TOKEN` 命中该 pattern,且始终出现在
 * `configuredSecretNames()`(apiKeyEnv 默认名),故测试用 `ANTHROPIC_AUTH_TOKEN`
 * 注入真实 secret 值即可被 `masked()` 捕获。
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
    draft.append({ type: "tool_call_start", name: "web_search" });
    assert.equal(draft.raw(), "");
    assert.equal(draft.masked(), "");
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

  it("subscribe 在 append 后通知;unsubscribe 幂等且不再通知", () => {
    const draft = createStreamDraft();
    let calls = 0;
    const listener = (): void => {
      calls += 1;
    };
    draft.subscribe(listener);
    draft.append({ type: "text_delta", text: "x" });
    assert.equal(calls, 1);
    const unsubscribe = draft.subscribe(listener); // 重复订阅去重
    draft.append({ type: "text_delta", text: "y" });
    assert.equal(calls, 2);
    unsubscribe();
    unsubscribe(); // 幂等
    draft.append({ type: "text_delta", text: "z" });
    assert.equal(calls, 2);
  });

  it("观察者异常被隔离:一个 listener throw 不影响其他 listener 与 append", () => {
    const draft = createStreamDraft();
    let healthyCalls = 0;
    draft.subscribe(() => {
      throw new Error("listener boom (D3 swallow)");
    });
    draft.subscribe(() => {
      healthyCalls += 1;
    });
    // 必须不 throw;健康 listener 仍收到通知。
    draft.append({ type: "text_delta", text: "x" });
    assert.equal(healthyCalls, 1);
    assert.equal(draft.raw(), "x");
  });

  it("多个 listener 各自收到通知;unsubscribe 只移除自身", () => {
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
    assert.equal(a, 1);
    assert.equal(b, 1);
    unsubA();
    draft.append({ type: "text_delta", text: "y" });
    assert.equal(a, 1);
    assert.equal(b, 2);
    unsubB();
  });
});
