/**
 * Remote input port (spec specs/remote-sync.md §4.3, §5.4; plan T5).
 *
 * The port is the only path from the seat into the TUI functions the keyboard
 * already uses. These cases pin the operation mapping, the rejection order
 * (not_ready → empty_text → not_active) and that every rejection leaves the
 * bindings untouched. All content is synthetic.
 */
import { describe, expect, test } from "bun:test";
import type {
  AnswerChoice,
  RemoteOperation,
} from "../../../src/remote-api/protocol.js";
import {
  createRemoteInputPort,
  type RemoteInputBindings,
  type RemoteSendResult,
} from "../../../src/tui/remote/input-port.js";

type SendStatus = "sent" | "queued";
type AnswerStatus = "ok" | "not_pending";
type FailureCode =
  "not_ready" | "empty_text" | "not_active" | "not_pending" | "bad_request";

interface BindingLog {
  readonly sends: Array<{ text: string; origin: "remote" }>;
  readonly answers: Array<{
    toolUseId: string;
    answer: AnswerChoice;
    origin: "remote";
  }>;
  aborts: number;
}

interface BindingsOptions {
  readonly activeConversationId?: string | null;
  readonly sendMessage?: (
    text: string,
    origin: "remote"
  ) => RemoteSendResult | Promise<RemoteSendResult>;
  readonly answerApproval?: (
    toolUseId: string,
    answer: AnswerChoice,
    origin: "remote"
  ) => AnswerStatus | Promise<AnswerStatus>;
  readonly abort?: () =>
    { interrupted: boolean } | Promise<{ interrupted: boolean }>;
}

function makeBindings(options: BindingsOptions = {}): {
  readonly bindings: RemoteInputBindings;
  readonly log: BindingLog;
} {
  const log: BindingLog = { sends: [], answers: [], aborts: 0 };
  const bindings: RemoteInputBindings = {
    getActiveConversationId: () => options.activeConversationId ?? null,
    sendMessage: (text, origin) => {
      log.sends.push({ text, origin });
      return options.sendMessage !== undefined
        ? options.sendMessage(text, origin)
        : "sent";
    },
    answerApproval: (toolUseId, answer, origin) => {
      log.answers.push({ toolUseId, answer, origin });
      return options.answerApproval !== undefined
        ? options.answerApproval(toolUseId, answer, origin)
        : "ok";
    },
    abort: () => {
      log.aborts += 1;
      return options.abort !== undefined
        ? options.abort()
        : { interrupted: true };
    },
  };
  return { bindings, log };
}

interface FailureShape {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

function isFailure(value: unknown): value is FailureShape {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false
  );
}

function expectFailure(value: unknown, code: FailureCode): FailureShape {
  expect(isFailure(value)).toBe(true);
  if (!isFailure(value)) throw new Error("expected a typed failure");
  expect(value.code).toBe(code);
  expect(value.message.length).toBeGreaterThan(0);
  return value;
}

function expectSuccess<T>(value: unknown, expected: T): void {
  expect(isFailure(value)).toBe(false);
  expect(value).toEqual({ ok: true, value: expected });
}

describe("readiness", () => {
  test("every operation is not_ready before bind and calls no binding", async () => {
    const port = createRemoteInputPort();
    const { log } = makeBindings();

    expectFailure(await port.sendMessage("hello"), "not_ready");
    expectFailure(await port.answerApproval("toolu_1", "once"), "not_ready");
    expectFailure(await port.abort(), "not_ready");

    expect(log.sends).toHaveLength(0);
    expect(log.answers).toHaveLength(0);
    expect(log.aborts).toBe(0);
  });

  test("every operation is not_ready again after unbind and calls no binding", async () => {
    const port = createRemoteInputPort();
    const { bindings, log } = makeBindings({ activeConversationId: "c_1" });
    const unbind = port.bind(bindings);
    expectSuccess(await port.sendMessage("first"), { status: "sent" });
    unbind();

    expectFailure(await port.sendMessage("second"), "not_ready");
    expectFailure(await port.answerApproval("toolu_1", "once"), "not_ready");
    expectFailure(await port.abort(), "not_ready");

    expect(log.sends).toHaveLength(1);
    expect(log.answers).toHaveLength(0);
    expect(log.aborts).toBe(0);
  });
});

describe("sendMessage", () => {
  test("empty and whitespace-only text is empty_text and never reaches the binding", async () => {
    const port = createRemoteInputPort();
    const { bindings, log } = makeBindings({ activeConversationId: "c_1" });
    port.bind(bindings);

    for (const text of ["", "   ", " \n\t "]) {
      expectFailure(await port.sendMessage(text), "empty_text");
    }
    expect(log.sends).toHaveLength(0);
  });

  test("empty_text is checked before not_active", async () => {
    const port = createRemoteInputPort();
    const { bindings, log } = makeBindings({ activeConversationId: "c_1" });
    port.bind(bindings);

    expectFailure(await port.sendMessage("   ", "c_other"), "empty_text");
    expect(log.sends).toHaveLength(0);
  });

  test("without a conversation id the text is sent as given with remote origin", async () => {
    const port = createRemoteInputPort();
    const { bindings, log } = makeBindings({ activeConversationId: "c_1" });
    port.bind(bindings);

    const text = "  keep surrounding whitespace \n";
    expectSuccess(await port.sendMessage(text), { status: "sent" });
    expect(log.sends).toEqual([{ text, origin: "remote" }]);
  });

  test("a matching conversation id is sent, a mismatch is not_active", async () => {
    const port = createRemoteInputPort();
    const { bindings, log } = makeBindings({ activeConversationId: "c_1" });
    port.bind(bindings);

    expectSuccess(await port.sendMessage("matching", "c_1"), {
      status: "sent",
    });
    expectFailure(await port.sendMessage("other", "c_2"), "not_active");

    expect(log.sends).toEqual([{ text: "matching", origin: "remote" }]);
  });

  test("a draft session (null active) rejects a conversation id and accepts none", async () => {
    const port = createRemoteInputPort();
    const { bindings, log } = makeBindings({ activeConversationId: null });
    port.bind(bindings);

    expectFailure(await port.sendMessage("draft", "c_1"), "not_active");
    expect(log.sends).toHaveLength(0);
    expectSuccess(await port.sendMessage("draft"), { status: "sent" });
    expect(log.sends).toEqual([{ text: "draft", origin: "remote" }]);
  });

  test("a queued status is passed through", async () => {
    const port = createRemoteInputPort();
    const { bindings } = makeBindings({
      activeConversationId: "c_1",
      sendMessage: () => "queued",
    });
    port.bind(bindings);

    expectSuccess(await port.sendMessage("while running"), {
      status: "queued",
    });
  });

  test("a failed binding result is bad_request and never claims a turn", async () => {
    const port = createRemoteInputPort();
    const secret = "synthetic-failed-message";
    const { bindings } = makeBindings({
      activeConversationId: "c_1",
      sendMessage: () => ({ failed: true }),
    });
    port.bind(bindings);

    const failure = expectFailure(
      await port.sendMessage(secret),
      "bad_request"
    );
    expect(failure.message).toBe("send_message failed in the TUI binding");
    expect(failure.message).not.toContain(secret);
  });

  test("an async failed binding result is mapped the same way", async () => {
    const port = createRemoteInputPort();
    const { bindings } = makeBindings({
      activeConversationId: "c_1",
      sendMessage: async (): Promise<RemoteSendResult> => ({ failed: true }),
    });
    port.bind(bindings);

    const failure = expectFailure(
      await port.sendMessage("later"),
      "bad_request"
    );
    expect(failure.message).toBe("send_message failed in the TUI binding");
  });

  test("an async binding result is awaited", async () => {
    const port = createRemoteInputPort();
    const { bindings } = makeBindings({
      activeConversationId: "c_1",
      sendMessage: async (): Promise<SendStatus> => "queued",
    });
    port.bind(bindings);

    expectSuccess(await port.sendMessage("later"), { status: "queued" });
  });
});

describe("answerApproval", () => {
  test("passes toolUseId, answer and remote origin through and maps ok to an empty value", async () => {
    const port = createRemoteInputPort();
    const { bindings, log } = makeBindings();
    port.bind(bindings);

    expectSuccess(await port.answerApproval("toolu_9", "always"), {});
    expect(log.answers).toEqual([
      { toolUseId: "toolu_9", answer: "always", origin: "remote" },
    ]);
  });

  test("every modal choice is passed through unchanged", async () => {
    const port = createRemoteInputPort();
    const { bindings, log } = makeBindings();
    port.bind(bindings);

    for (const answer of ["once", "always", "reject"] as const) {
      expectSuccess(await port.answerApproval(`toolu_${answer}`, answer), {});
    }
    expect(log.answers.map((entry) => entry.answer)).toEqual([
      "once",
      "always",
      "reject",
    ]);
  });

  test("not_pending is passed through and a second answer to the same ask changes nothing", async () => {
    const port = createRemoteInputPort();
    let pending = true;
    const { bindings, log } = makeBindings({
      answerApproval: () => {
        if (!pending) return "not_pending";
        pending = false;
        return "ok";
      },
    });
    port.bind(bindings);

    expectSuccess(await port.answerApproval("toolu_1", "once"), {});
    expectFailure(
      await port.answerApproval("toolu_1", "reject"),
      "not_pending"
    );
    expect(log.answers).toHaveLength(2);
  });
});

describe("abort", () => {
  test("returns the binding's interrupted flag", async () => {
    const port = createRemoteInputPort();
    const { bindings, log } = makeBindings({
      abort: () => ({ interrupted: true }),
    });
    port.bind(bindings);

    expectSuccess(await port.abort(), { interrupted: true });
    expect(log.aborts).toBe(1);
  });

  test("an idle abort reports interrupted false", async () => {
    const port = createRemoteInputPort();
    const { bindings } = makeBindings({
      abort: async () => ({ interrupted: false }),
    });
    port.bind(bindings);

    expectSuccess(await port.abort(), { interrupted: false });
  });
});

describe("thrown binding errors", () => {
  const secret = "synthetic-message-body";

  test("a thrown send binding becomes bad_request without echoing the text", async () => {
    const port = createRemoteInputPort();
    const { bindings } = makeBindings({
      activeConversationId: "c_1",
      sendMessage: () => {
        throw new Error(`boom ${secret}`);
      },
    });
    port.bind(bindings);

    const failure = expectFailure(
      await port.sendMessage(secret),
      "bad_request"
    );
    expect(failure.message).not.toContain(secret);
  });

  test("a thrown answer binding becomes bad_request without echoing the toolUseId", async () => {
    const port = createRemoteInputPort();
    const { bindings } = makeBindings({
      answerApproval: () => {
        throw new Error(`boom ${secret}`);
      },
    });
    port.bind(bindings);

    const failure = expectFailure(
      await port.answerApproval("toolu_secret", "once"),
      "bad_request"
    );
    expect(failure.message).not.toContain(secret);
    expect(failure.message).not.toContain("toolu_secret");
  });

  test("a thrown abort binding becomes bad_request and the port never rejects", async () => {
    const port = createRemoteInputPort();
    const { bindings } = makeBindings({
      abort: () => {
        throw new Error(`boom ${secret}`);
      },
    });
    port.bind(bindings);

    const failure = expectFailure(await port.abort(), "bad_request");
    expect(failure.message).not.toContain(secret);
  });
});

describe("rebinding", () => {
  test("binding twice replaces the bindings; the old unbind cannot clear the new one", async () => {
    const port = createRemoteInputPort();
    const first = makeBindings({ activeConversationId: "c_1" });
    const second = makeBindings({ activeConversationId: "c_1" });

    const unbindFirst = port.bind(first.bindings);
    port.bind(second.bindings);
    unbindFirst();

    expectSuccess(await port.sendMessage("to the new bindings"), {
      status: "sent",
    });
    expect(first.log.sends).toHaveLength(0);
    expect(second.log.sends).toEqual([
      { text: "to the new bindings", origin: "remote" },
    ]);
  });

  test("the current unbind is idempotent and only affects its own generation", async () => {
    const port = createRemoteInputPort();
    const first = makeBindings({ activeConversationId: "c_1" });
    const second = makeBindings({ activeConversationId: "c_1" });

    port.bind(first.bindings);
    const unbindSecond = port.bind(second.bindings);
    unbindSecond();
    unbindSecond();

    expectFailure(await port.sendMessage("after unbind"), "not_ready");
    expect(first.log.sends).toHaveLength(0);
    expect(second.log.sends).toHaveLength(0);
  });
});

describe("protocol shapes", () => {
  test("results are the RemoteOperation values the socket server host consumes", async () => {
    const port = createRemoteInputPort();
    const { bindings } = makeBindings({
      activeConversationId: null,
      abort: () => ({ interrupted: false }),
    });
    port.bind(bindings);

    const send: RemoteOperation<{ status: "sent" | "queued" }> =
      await port.sendMessage("hello");
    expect(send).toEqual({ ok: true, value: { status: "sent" } });

    const answer: RemoteOperation<Record<string, never>> =
      await port.answerApproval("toolu_1", "reject");
    expect(answer).toEqual({ ok: true, value: {} });

    const aborted: RemoteOperation<{ interrupted: boolean }> =
      await port.abort();
    expect(aborted).toEqual({ ok: true, value: { interrupted: false } });

    const rejected: RemoteOperation<{ status: "sent" | "queued" }> =
      await port.sendMessage("hello", "c_other");
    expect(rejected).toEqual({
      ok: false,
      code: "not_active",
      message: expect.any(String),
    });
    expect(JSON.parse(JSON.stringify(rejected))).toEqual({
      ok: false,
      code: "not_active",
      message: expect.any(String),
    });
  });
});
