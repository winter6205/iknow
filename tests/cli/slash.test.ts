/**
 * CLI `src/cli/slash.ts` parse + dispatch tests (T2 acceptance).
 *
 * `parseChatLine` mirrors the old `src/interaction/slash.ts` line classifier
 * (case-insensitive command, args preserved). `applySlashCommand` covers the
 * dispatch table: quit/exit/help/?/status/json/role/reset/unknown/empty.
 *
 * Note: `/mode` is intentionally absent (CLI no longer carries an agent-mode
 * concept; Q3 resolution). Tests must NOT add a `/mode` expectation.
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
    assert.deepEqual(parseChatLine("/role manager"), {
      kind: "slash",
      command: "role",
      args: ["manager"],
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
    assert.deepEqual(applySlashCommand("quit", [], ctx), { type: "quit" });
  });

  it("exit → {type:quit}", () => {
    const ctx = { state: makeState() };
    assert.deepEqual(applySlashCommand("exit", [], ctx), { type: "quit" });
  });

  it("help → type=help, text mentions /help /status /reset, NOT /mode", () => {
    const ctx = { state: makeState() };
    const eff = applySlashCommand("help", [], ctx);
    assert.strictEqual(eff.type, "help");
    if (eff.type !== "help") return;
    assert.ok(eff.text.includes("/help"));
    assert.ok(eff.text.includes("/status"));
    assert.ok(eff.text.includes("/reset"));
    assert.ok(!eff.text.includes("/mode"), "HELP must not advertise /mode");
  });

  it("? → same as help (type=help)", () => {
    const ctx = { state: makeState() };
    assert.strictEqual(applySlashCommand("?", [], ctx).type, "help");
  });

  it("status → reflects state (role=manager, json=on, messages=3); NO mode=/priors=", () => {
    const state = makeState({
      messages: [
        makeNative("user", "a"),
        makeNative("user", "b"),
        makeNative("user", "c"),
      ],
      jsonMode: true,
      session: { caller_role: "manager" },
    });
    const ctx = { state };
    const eff = applySlashCommand("status", [], ctx);
    assert.strictEqual(eff.type, "info");
    if (eff.type !== "info") return;
    assert.ok(eff.text.includes("role=manager"));
    assert.ok(eff.text.includes("json=on"));
    assert.ok(eff.text.includes("messages=3"));
    assert.ok(!eff.text.includes("mode="), "must not contain 'mode=' line");
    assert.ok(!eff.text.includes("priors="), "must not contain 'priors=' line");
  });

  it("json on → flips jsonMode true + info message", () => {
    const state = makeState({ jsonMode: false });
    const ctx = { state };
    const eff = applySlashCommand("json", ["on"], ctx);
    assert.strictEqual(eff.type, "info");
    if (eff.type !== "info") return;
    assert.strictEqual(state.jsonMode, true);
    assert.ok(eff.text.includes("JSON output: on"));
  });

  it("json off → flips jsonMode false + info message", () => {
    const state = makeState({ jsonMode: true });
    const ctx = { state };
    const eff = applySlashCommand("json", ["off"], ctx);
    assert.strictEqual(eff.type, "info");
    if (eff.type !== "info") return;
    assert.strictEqual(state.jsonMode, false);
    assert.ok(eff.text.includes("JSON output: off"));
  });

  it("json (no arg / bad arg) → error 'Usage: /json on|off'", () => {
    const ctx1 = { state: makeState() };
    const noArg = applySlashCommand("json", [], ctx1);
    assert.strictEqual(noArg.type, "error");
    if (noArg.type !== "error") return;
    assert.strictEqual(noArg.text, "Usage: /json on|off");

    const ctx2 = { state: makeState() };
    const badArg = applySlashCommand("json", ["maybe"], ctx2);
    assert.strictEqual(badArg.type, "error");
    if (badArg.type !== "error") return;
    assert.strictEqual(badArg.text, "Usage: /json on|off");
  });

  it("role valid (manager) → mutates caller_role + info 'Role set to manager'", () => {
    const state = makeState({ session: { caller_role: "employee" } });
    const ctx = { state };
    const eff = applySlashCommand("role", ["manager"], ctx);
    assert.strictEqual(eff.type, "info");
    if (eff.type !== "info") return;
    assert.strictEqual(state.session.caller_role, "manager");
    assert.strictEqual(eff.text, "Role set to manager");
  });

  it("role invalid (wizard) → error message from parseCallerRole", () => {
    const state = makeState();
    const ctx = { state };
    const eff = applySlashCommand("role", ["wizard"], ctx);
    assert.strictEqual(eff.type, "error");
    if (eff.type !== "error") return;
    // parseCallerRole throws with "Invalid caller role:" prefix.
    assert.match(eff.text, /Invalid caller role/);
    // Caller-role must NOT have changed.
    assert.strictEqual(state.session.caller_role, "employee");
  });

  it("role missing → error 'Usage: /role <employee|manager|admin>'", () => {
    const state = makeState();
    const ctx = { state };
    const eff = applySlashCommand("role", [], ctx);
    assert.strictEqual(eff.type, "error");
    if (eff.type !== "error") return;
    assert.strictEqual(eff.text, "Usage: /role <employee|manager|admin>");
  });

  it("reset → clears messages to [], preserves session.caller_role", () => {
    const state = makeState({
      messages: [makeNative("user", "a"), makeNative("user", "b")],
      session: { caller_role: "admin" },
    });
    const ctx = { state };
    const eff = applySlashCommand("reset", [], ctx);
    assert.strictEqual(eff.type, "reset");
    if (eff.type !== "reset") return;
    assert.deepEqual([...state.messages], []);
    assert.strictEqual(state.session.caller_role, "admin");
    assert.match(eff.message, /Session cleared/i);
  });

  it("unknown command (/foo) → error 'Unknown command /foo'", () => {
    const ctx = { state: makeState() };
    const eff = applySlashCommand("foo", [], ctx);
    assert.strictEqual(eff.type, "error");
    if (eff.type !== "error") return;
    assert.match(
      eff.text,
      /^Unknown command \/foo\. Type \/help for commands\.$/
    );
  });

  it("empty command (\"\") → 'Empty command. Type /help for commands.'", () => {
    const ctx = { state: makeState() };
    const eff = applySlashCommand("", [], ctx);
    assert.strictEqual(eff.type, "error");
    if (eff.type !== "error") return;
    assert.strictEqual(eff.text, "Empty command. Type /help for commands.");
  });

  it("control-char strip: error text does NOT contain raw ESC", () => {
    const ctx = { state: makeState() };
    const esc = String.fromCharCode(27);
    const eff = applySlashCommand(esc + "foo", [], ctx);
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
