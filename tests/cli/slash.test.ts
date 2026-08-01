/**
 * CLI `src/cli/slash.ts` parse + dispatch tests (T2 acceptance).
 *
 * `parseChatLine` mirrors the old `src/interaction/slash.ts` line classifier
 * (case-insensitive command, args preserved). `applySlashCommand` covers the
 * dispatch table: quit/exit/help/?/status/json/reset/unknown/empty.
 *
 * Note: `/mode` and `/role` are intentionally absent (CLI no longer carries an
 * agent-mode or caller-role concept). Tests must NOT add expectations for them.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { applySlashCommand, parseChatLine } from "../../src/cli/slash.ts";
import { makeNative, makeState } from "./_fixtures.ts";

describe("parseChatLine", () => {
  it("classifies whitespace as empty", () => {
    assert.deepEqual(parseChatLine("   "), { kind: "empty" });
  });

  it("classifies non-slash as query (trimmed)", () => {
    assert.deepEqual(parseChatLine("  hello world  "), {
      kind: "query",
      text: "hello world",
    });
  });

  it("classifies slash with no body as empty-command slash", () => {
    assert.deepEqual(parseChatLine("/quit"), {
      kind: "slash",
      command: "quit",
      args: [],
    });
  });

  it("classifies slash with args (lowercases command, preserves args)", () => {
    assert.deepEqual(parseChatLine("/json ON"), {
      kind: "slash",
      command: "json",
      args: ["ON"],
    });
  });

  it("lowercases command (case-insensitive)", () => {
    assert.deepEqual(parseChatLine("/HELP"), {
      kind: "slash",
      command: "help",
      args: [],
    });
  });
});

describe("applySlashCommand", () => {
  it("quit → {type:quit}", () => {
    const ctx = { state: makeState() };
    assert.deepEqual(applySlashCommand({ command: "quit", args: [], ctx }), {
      type: "quit",
    });
  });

  it("exit → {type:quit}", () => {
    const ctx = { state: makeState() };
    assert.deepEqual(applySlashCommand({ command: "exit", args: [], ctx }), {
      type: "quit",
    });
  });

  it("help → type=help, text mentions /help /status /reset, NOT /mode", () => {
    const ctx = { state: makeState() };
    const eff = applySlashCommand({ command: "help", args: [], ctx });
    assert.strictEqual(eff.type, "help");
    if (eff.type !== "help") return;
    assert.ok(eff.text.includes("/help"));
    assert.ok(eff.text.includes("/status"));
    assert.ok(eff.text.includes("/reset"));
    assert.ok(!eff.text.includes("/mode"), "HELP must not advertise /mode");
  });

  it("? → same as help (type=help)", () => {
    const ctx = { state: makeState() };
    assert.strictEqual(
      applySlashCommand({ command: "?", args: [], ctx }).type,
      "help"
    );
  });

  it("status → reflects state (json=on, messages=3); NO role=/mode=/priors=", () => {
    const state = makeState({
      messages: [
        makeNative({ role: "user", text: "a" }),
        makeNative({ role: "user", text: "b" }),
        makeNative({ role: "user", text: "c" }),
      ],
      jsonMode: true,
    });
    const ctx = { state };
    const eff = applySlashCommand({ command: "status", args: [], ctx });
    assert.strictEqual(eff.type, "info");
    if (eff.type !== "info") return;
    assert.ok(eff.text.includes("json=on"));
    assert.ok(eff.text.includes("messages=3"));
    assert.ok(!eff.text.includes("role="), "must not contain 'role=' line");
    assert.ok(!eff.text.includes("mode="), "must not contain 'mode=' line");
    assert.ok(!eff.text.includes("priors="), "must not contain 'priors=' line");
  });

  it("json on → flips jsonMode true + info message", () => {
    const state = makeState({ jsonMode: false });
    const ctx = { state };
    const eff = applySlashCommand({
      command: "json",
      args: ["on"],
      ctx,
    });
    assert.strictEqual(eff.type, "info");
    if (eff.type !== "info") return;
    assert.strictEqual(state.jsonMode, true);
    assert.ok(eff.text.includes("JSON output: on"));
  });

  it("json off → flips jsonMode false + info message", () => {
    const state = makeState({ jsonMode: true });
    const ctx = { state };
    const eff = applySlashCommand({
      command: "json",
      args: ["off"],
      ctx,
    });
    assert.strictEqual(eff.type, "info");
    if (eff.type !== "info") return;
    assert.strictEqual(state.jsonMode, false);
    assert.ok(eff.text.includes("JSON output: off"));
  });

  it("json (no arg / bad arg) → error 'Usage: /json on|off'", () => {
    const ctx1 = { state: makeState() };
    const noArg = applySlashCommand({
      command: "json",
      args: [],
      ctx: ctx1,
    });
    assert.strictEqual(noArg.type, "error");
    if (noArg.type !== "error") return;
    assert.strictEqual(noArg.text, "Usage: /json on|off");

    const ctx2 = { state: makeState() };
    const badArg = applySlashCommand({
      command: "json",
      args: ["maybe"],
      ctx: ctx2,
    });
    assert.strictEqual(badArg.type, "error");
    if (badArg.type !== "error") return;
    assert.strictEqual(badArg.text, "Usage: /json on|off");
  });

  it("reset → clears messages to [], preserves session object identity", () => {
    const session = {};
    const state = makeState({
      messages: [
        makeNative({ role: "user", text: "a" }),
        makeNative({ role: "user", text: "b" }),
      ],
      session,
    });
    const ctx = { state };
    const eff = applySlashCommand({
      command: "reset",
      args: [],
      ctx,
    });
    assert.strictEqual(eff.type, "reset");
    if (eff.type !== "reset") return;
    assert.deepEqual([...state.messages], []);
    assert.strictEqual(state.session, session, "session object preserved");
    assert.match(eff.message, /Session cleared/i);
  });

  it("unknown command (/foo) → error 'Unknown command /foo'", () => {
    const ctx = { state: makeState() };
    const eff = applySlashCommand({ command: "foo", args: [], ctx });
    assert.strictEqual(eff.type, "error");
    if (eff.type !== "error") return;
    assert.match(
      eff.text,
      /^Unknown command \/foo\. Type \/help for commands\.$/
    );
  });

  it("empty command (\"\") → 'Empty command. Type /help for commands.'", () => {
    const ctx = { state: makeState() };
    const eff = applySlashCommand({ command: "", args: [], ctx });
    assert.strictEqual(eff.type, "error");
    if (eff.type !== "error") return;
    assert.strictEqual(eff.text, "Empty command. Type /help for commands.");
  });

  it("control-char strip: error text does NOT contain raw ESC", () => {
    const ctx = { state: makeState() };
    const esc = String.fromCharCode(27);
    const eff = applySlashCommand({
      command: esc + "foo",
      args: [],
      ctx,
    });
    assert.strictEqual(eff.type, "error");
    if (eff.type !== "error") return;
    assert.ok(
      !eff.text.includes(esc),
      "error text must not contain the ESC byte"
    );
    // After stripping, the error references the remaining printable body.
    assert.ok(eff.text.includes("Unknown command /foo"));
  });
});
