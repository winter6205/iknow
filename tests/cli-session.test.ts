import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../src/agent-loop/session.ts";
import { IknowAgent } from "../src/agent-loop/loop.ts";
import { createSeededStore } from "../src/fixtures/seed-kb.ts";
import { createConversation } from "../src/interaction/index.ts";
import { applySlashCommand } from "../src/interaction/slash.ts";
import { parseArgs } from "../src/cli/parse-args.ts";
import {
  processChatLine,
  type ChatLineContext,
} from "../src/cli/chat-session.ts";
import { isInteractive } from "../src/cli/session-io.ts";
import { getVersion, usageText } from "../src/cli/usage.ts";

describe("parseArgs", () => {
  it("defaults bare invocation to chat when interactive", () => {
    const p = parseArgs([], { interactive: true });
    assert.equal(p.command, "chat");
    assert.equal(p.missingQuery, false);
  });

  it("defaults bare invocation to help when non-interactive", () => {
    const p = parseArgs([], { interactive: false });
    assert.equal(p.command, "help");
  });

  it("flags-only on TTY defaults to chat", () => {
    const p = parseArgs(["--json", "--role", "manager"], {
      interactive: true,
    });
    assert.equal(p.command, "chat");
    assert.equal(p.json, true);
    assert.equal(p.role, "manager");
  });

  it("flags-only non-TTY defaults to help", () => {
    const p = parseArgs(["--json"], { interactive: false });
    assert.equal(p.command, "help");
  });

  it("chat subcommand", () => {
    const p = parseArgs(["chat", "--mode", "deterministic"], {
      interactive: false,
    });
    assert.equal(p.command, "chat");
    assert.equal(p.mode, "deterministic");
  });

  it("ask with query", () => {
    const p = parseArgs(["ask", "公司的退款政策是什么？"]);
    assert.equal(p.command, "ask");
    assert.equal(p.query, "公司的退款政策是什么？");
    assert.equal(p.missingQuery, false);
  });

  it("ask without query sets missingQuery (no demo default)", () => {
    const p = parseArgs(["ask"]);
    assert.equal(p.command, "ask");
    assert.equal(p.query, "");
    assert.equal(p.missingQuery, true);
  });

  it("oneshot bare query (compat)", () => {
    const p = parseArgs(["hello world"]);
    assert.equal(p.command, "oneshot");
    assert.equal(p.query, "hello world");
    assert.equal(p.missingQuery, false);
  });

  it("-h / --help → help", () => {
    assert.equal(parseArgs(["-h"]).command, "help");
    assert.equal(parseArgs(["--help", "ask", "x"]).command, "help");
  });
});

describe("usage / version", () => {
  it("getVersion returns semver-like string", () => {
    assert.match(getVersion(), /^\d+\.\d+\.\d+/);
  });

  it("usageText mentions chat and ask", () => {
    const t = usageText();
    assert.match(t, /chat/);
    assert.match(t, /ask/);
    assert.match(t, /iknow/);
  });
});

describe("isInteractive", () => {
  it("is false when streams are not TTYs", () => {
    const stdin = { isTTY: false } as NodeJS.ReadStream;
    const stdout = { isTTY: false } as NodeJS.WriteStream;
    assert.equal(isInteractive(stdin, stdout), false);
  });

  it("is true only when both are TTYs", () => {
    const stdin = { isTTY: true } as NodeJS.ReadStream;
    const stdout = { isTTY: true } as NodeJS.WriteStream;
    assert.equal(isInteractive(stdin, stdout), true);
    assert.equal(
      isInteractive(stdin, { isTTY: false } as NodeJS.WriteStream),
      false,
    );
  });
});

describe("slash /status", () => {
  it("reports mode role json turns priors", () => {
    const state = createConversation(createSession("employee"), {
      json_mode: true,
    });
    state.turns.push({
      query: "q",
      answer: {
        text: "a",
        source_spans: [],
        snapshot_id: "s",
        governance_status: "ok",
        tool_trace: [],
        tool_calls: [],
        hops_used: 1,
      },
    });
    state.last_priors = [
      { chunk_id: "c1", summary: "s1" },
      { chunk_id: "c2", summary: "s2" },
    ];

    const effect = applySlashCommand("status", [], {
      state,
      mode: "deterministic",
    });
    assert.equal(effect.type, "info");
    if (effect.type === "info") {
      assert.match(effect.text, /mode=deterministic/);
      assert.match(effect.text, /role=employee/);
      assert.match(effect.text, /json=on/);
      assert.match(effect.text, /turns=1/);
      assert.match(effect.text, /priors=2/);
    }
  });
});

describe("processChatLine (pipe simulation)", () => {
  function makeCtx(): ChatLineContext {
    const store = createSeededStore();
    const session = createSession("employee");
    const agent = new IknowAgent({ store, session });
    const state = createConversation(session);
    return {
      agent,
      store,
      state,
      mode: "deterministic",
      buildAgent: async () => agent,
    };
  }

  it("empty line is no-op", async () => {
    const ctx = makeCtx();
    const r = await processChatLine("   ", ctx);
    assert.equal(r.quit, false);
    assert.equal(r.output, "");
    assert.equal(r.ranQuery, undefined);
  });

  it("slash /help and /quit", async () => {
    const ctx = makeCtx();
    const help = await processChatLine("/help", ctx);
    assert.equal(help.quit, false);
    assert.match(help.output, /\/status/);

    const quit = await processChatLine("/quit", ctx);
    assert.equal(quit.quit, true);
  });

  it("slash /status via processChatLine", async () => {
    const ctx = makeCtx();
    const r = await processChatLine("/status", ctx);
    assert.equal(r.quit, false);
    assert.match(r.output, /mode=deterministic/);
    assert.match(r.output, /turns=0/);
  });

  it("serial two-query pipe: second sees priors; order preserved", async () => {
    const ctx = makeCtx();

    const r1 = await processChatLine("公司的退款政策是什么？", ctx);
    assert.equal(r1.quit, false);
    assert.equal(r1.ranQuery, true);
    assert.ok(r1.output.length > 0);
    assert.match(r1.output, /治理:|governance/i);
    assert.ok(ctx.state.turns.length === 1);
    assert.ok(ctx.state.last_priors.length >= 1);

    const status = await processChatLine("/status", ctx);
    assert.match(status.output, /turns=1/);
    assert.match(status.output, /priors=\d+/);

    const r2 = await processChatLine("那和旧版差在哪？", ctx);
    assert.equal(r2.ranQuery, true);
    assert.ok(r2.output.length > 0);
    assert.equal(ctx.state.turns.length, 2);
    // Fully awaited: no interleave — turn count is exactly 2 after both.
    assert.equal(ctx.state.history_finals.length, 4);
  });

  it("unknown slash goes to stderr field", async () => {
    const ctx = makeCtx();
    const r = await processChatLine("/nope", ctx);
    assert.equal(r.output, "");
    assert.ok(r.stderr);
    assert.match(r.stderr!, /Unknown command/);
  });

  it("/json on switches answer formatting", async () => {
    const ctx = makeCtx();
    await processChatLine("/json on", ctx);
    assert.equal(ctx.state.json_mode, true);
    const r = await processChatLine("公司的退款政策是什么？", ctx);
    assert.ok(r.output.startsWith("{"));
    const parsed = JSON.parse(r.output) as { text: string };
    assert.ok(typeof parsed.text === "string");
  });
});
