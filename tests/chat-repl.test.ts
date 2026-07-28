import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createSession } from "../src/agent-loop/session.ts";
import { IknowAgent } from "../src/agent-loop/loop.ts";
import { createSeededStore } from "../src/fixtures/seed-kb.ts";
import {
  createConversation,
  formatAnswerHuman,
  recordTurn,
  applySlashCommand,
  parseChatLine,
} from "../src/interaction/index.ts";

describe("parseChatLine", () => {
  it("classifies empty / query / slash", () => {
    assert.deepEqual(parseChatLine(""), { kind: "empty" });
    assert.deepEqual(parseChatLine("   "), { kind: "empty" });
    assert.deepEqual(parseChatLine("公司的退款政策是什么？"), {
      kind: "query",
      text: "公司的退款政策是什么？",
    });
    assert.deepEqual(parseChatLine("  hello world  "), {
      kind: "query",
      text: "hello world",
    });
  });

  it("parses slash commands case-insensitively with args", () => {
    assert.deepEqual(parseChatLine("/quit"), {
      kind: "slash",
      command: "quit",
      args: [],
    });
    assert.deepEqual(parseChatLine("/JSON on"), {
      kind: "slash",
      command: "json",
      args: ["on"],
    });
    assert.deepEqual(parseChatLine("/role manager"), {
      kind: "slash",
      command: "role",
      args: ["manager"],
    });
    assert.deepEqual(parseChatLine("/mode deterministic"), {
      kind: "slash",
      command: "mode",
      args: ["deterministic"],
    });
    assert.deepEqual(parseChatLine("/"), {
      kind: "slash",
      command: "",
      args: [],
    });
  });
});

describe("applySlashCommand", () => {
  it("handles quit/exit/help", () => {
    const state = createConversation(createSession("employee"));
    assert.equal(
      applySlashCommand("quit", [], { state, mode: "deterministic" }).type,
      "quit",
    );
    assert.equal(
      applySlashCommand("exit", [], { state, mode: "deterministic" }).type,
      "quit",
    );
    const help = applySlashCommand("help", [], {
      state,
      mode: "deterministic",
    });
    assert.equal(help.type, "help");
    if (help.type === "help") {
      assert.match(help.text, /\/json/);
      assert.match(help.text, /\/role/);
      assert.match(help.text, /\/status/);
    }
  });

  it("status reports session counters", () => {
    const state = createConversation(createSession("manager"), {
      json_mode: false,
    });
    const effect = applySlashCommand("status", [], {
      state,
      mode: "llm",
    });
    assert.equal(effect.type, "info");
    if (effect.type === "info") {
      assert.match(effect.text, /mode=llm/);
      assert.match(effect.text, /role=manager/);
      assert.match(effect.text, /json=off/);
      assert.match(effect.text, /turns=0/);
      assert.match(effect.text, /priors=0/);
    }
  });

  it("toggles json_mode via /json on|off", () => {
    const state = createConversation(createSession("employee"), {
      json_mode: false,
    });
    const on = applySlashCommand("json", ["on"], {
      state,
      mode: "deterministic",
    });
    assert.equal(on.type, "info");
    assert.equal(state.json_mode, true);

    const off = applySlashCommand("json", ["off"], {
      state,
      mode: "deterministic",
    });
    assert.equal(off.type, "info");
    assert.equal(state.json_mode, false);

    const bad = applySlashCommand("json", [], {
      state,
      mode: "deterministic",
    });
    assert.equal(bad.type, "error");
  });

  it("mutates session.caller_role in place on /role", () => {
    const session = createSession("employee");
    const state = createConversation(session);
    const ok = applySlashCommand("role", ["manager"], {
      state,
      mode: "deterministic",
    });
    assert.equal(ok.type, "info");
    assert.equal(state.session.caller_role, "manager");
    // same object reference (agents share it)
    assert.equal(session.caller_role, "manager");

    const bad = applySlashCommand("role", ["intern"], {
      state,
      mode: "deterministic",
    });
    assert.equal(bad.type, "error");
    assert.equal(state.session.caller_role, "manager");
  });

  it("emits mode_change only when mode actually changes", () => {
    const state = createConversation(createSession("employee"));
    const same = applySlashCommand("mode", ["deterministic"], {
      state,
      mode: "deterministic",
    });
    assert.equal(same.type, "info");

    const next = applySlashCommand("mode", ["llm"], {
      state,
      mode: "deterministic",
    });
    assert.equal(next.type, "mode_change");
    if (next.type === "mode_change") {
      assert.equal(next.mode, "llm");
    }

    const bad = applySlashCommand("mode", ["magic"], {
      state,
      mode: "deterministic",
    });
    assert.equal(bad.type, "error");
  });

  it("reset clears turns/priors/history, keeps session", () => {
    const store = createSeededStore();
    const state = createConversation(createSession("employee"));
    state.turns.push({
      query: "q",
      answer: {
        text: "a",
        source_spans: [],
        snapshot_id: "snap_x",
        governance_status: "ok",
        tool_trace: [],
        tool_calls: [],
        hops_used: 0,
      },
    });
    state.last_priors = [{ chunk_id: "c1", summary: "s" }];
    state.history_finals = [{ role: "user", content: "q" }];
    state.json_mode = true;

    const effect = applySlashCommand("reset", [], {
      state,
      mode: "deterministic",
    });
    assert.equal(effect.type, "reset");
    assert.equal(state.turns.length, 0);
    assert.equal(state.last_priors.length, 0);
    assert.equal(state.history_finals.length, 0);
    assert.equal(state.session.caller_role, "employee");
    assert.equal(state.json_mode, true);
    // store unused — kept by host; reset only touches conversation bag
    assert.ok(store.listChunks().length > 0);
  });

  it("unknown slash yields error", () => {
    const state = createConversation(createSession("employee"));
    const effect = applySlashCommand("foo", [], {
      state,
      mode: "deterministic",
    });
    assert.equal(effect.type, "error");
    if (effect.type === "error") {
      assert.match(effect.text, /Unknown command \/foo/);
    }
  });

  it("strips control chars (incl. ESC) from reflected unknown command", () => {
    const state = createConversation(createSession("employee"));
    // ESC + CSI clear-screen payload reflected without sanitization would
    // corrupt the terminal when console.log prints the error.
    const hostile = `evil\x1b[2J\x1b[Hcmd`;
    const effect = applySlashCommand(hostile, [], {
      state,
      mode: "deterministic",
    });
    assert.equal(effect.type, "error");
    if (effect.type === "error") {
      // ESC (0x1B) stripped; printable remnants like '[' may remain
      assert.ok(!effect.text.includes("\x1b"));
      assert.ok(!/[\u0000-\u001F\u007F]/.test(effect.text));
      assert.equal(
        effect.text,
        "Unknown command /evil[2J[Hcmd. Type /help for commands.",
      );
    }
  });

  it("usage/help lists roles and modes from shared sources", () => {
    const state = createConversation(createSession("employee"));
    const help = applySlashCommand("help", [], {
      state,
      mode: "deterministic",
    });
    assert.equal(help.type, "help");
    if (help.type === "help") {
      assert.match(help.text, /employee\|manager\|admin/);
      assert.match(help.text, /deterministic\|llm/);
    }

    const roleUsage = applySlashCommand("role", [], {
      state,
      mode: "deterministic",
    });
    assert.equal(roleUsage.type, "error");
    if (roleUsage.type === "error") {
      assert.match(roleUsage.text, /employee\|manager\|admin/);
    }

    const modeUsage = applySlashCommand("mode", ["magic"], {
      state,
      mode: "deterministic",
    });
    assert.equal(modeUsage.type, "error");
    if (modeUsage.type === "error") {
      assert.match(modeUsage.text, /deterministic\|llm/);
    }
  });
});

describe("chat session integration (no readline)", () => {
  it("multi-turn answer injects last_priors; human format includes snapshot", async () => {
    const store = createSeededStore();
    const session = createSession("employee");
    const agent = new IknowAgent({ store, session });
    const state = createConversation(session);

    const a1 = await agent.answer("公司的退款政策是什么？", {
      prior_chunks: state.last_priors.length ? state.last_priors : undefined,
      history: state.history_finals.length ? state.history_finals : undefined,
    });
    recordTurn(state, "公司的退款政策是什么？", a1, store);
    assert.ok(a1.snapshot_id);
    assert.ok(state.last_priors.length >= 1);
    assert.equal(state.history_finals.length, 2);

    const human = formatAnswerHuman(a1);
    assert.match(human, /治理:/);
    assert.match(human, /snapshot:/);

    const a2 = await agent.answer("那和旧版差在哪？", {
      prior_chunks: state.last_priors,
      history: state.history_finals,
    });
    recordTurn(state, "那和旧版差在哪？", a2, store);
    assert.ok(a2.snapshot_id);
    assert.equal(state.turns.length, 2);

    // first retrieve of turn 2 should have recorded prior_chunks when used
    const firstRetrieve = a2.tool_calls.find((c) => c.tool === "kb_retrieve");
    if (firstRetrieve && firstRetrieve.args.prior_chunks) {
      assert.ok(Array.isArray(firstRetrieve.args.prior_chunks));
      assert.ok(
        (firstRetrieve.args.prior_chunks as unknown[]).length >= 1,
      );
    }
  });
});
