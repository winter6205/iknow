// One stable read-rule sentence in the system prefix + the todo_write skip
// condition's "never printed in the status bar" boundary (ADR-0028).
//
// Covers:
//   1. The assembled system contains the stable reading rule (trust only the
//      `<agent_status>` frame the host injects for this turn, ADR-0112), and
//      only on surfaces where the bar is injected; ask-shaped assemblies omit
//      it (ask/worker never see the bar, so a rule for an absent bar is
//      permanent noise).
//   2. Two consecutive rounds with identical inputs assemble a byte-identical
//      system (KV-cache contract; shape mirrors identity-assemble-skills.test.ts).
//   3. The bar text carries neither the read-rule sentence nor the todo_write
//      skip clause (ADR-0028: the bar holds only code-computed current state;
//      src/harness/agent-status.ts is referenced read-only here).
//   4. The positive pin for the todo_write skip clause lives in
//      tests/harness/aci/tools/todo-write.test.ts (not duplicated here).
//   5. Existing identity / assembly / build-engine tests do not regress from
//      this segment (additive file only).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assembleIdentityContext,
  createIknowSystemResolver,
  IKNOW_AGENT_STATUS_READ_RULE,
  type AssemblyContext,
} from "../../../src/harness/identity/assemble.ts";
import {
  buildAgentStatusText,
  computeAgentStatusSnapshot,
  AGENT_STATUS_IDLE_TOOL,
} from "../../../src/harness/agent-status.ts";
import { TODO_WRITE_SKIP_CLAUSE } from "../../../src/harness/aci/tools/todo-write.ts";
import { buildHarnessEngine } from "../../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../../src/config/env.ts";

let origHome: string | undefined;
let workDir: string;

beforeAll(async () => {
  origHome = process.env.HOME;
  workDir = await mkdtemp(join(tmpdir(), "iknow-status-read-rule-"));
  await mkdir(join(workDir, ".iknow"), { recursive: true });
  process.env.HOME = workDir;
});

afterAll(async () => {
  process.env.HOME = origHome;
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
});

function baseCtx(extra?: Partial<AssemblyContext>): AssemblyContext {
  return {
    cwd: workDir,
    userHome: workDir,
    bootstrapActive: false,
    memoryEnabled: false,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Read-rule sentence: present only on surfaces that inject the bar (gated
// additive segment)
// ---------------------------------------------------------------------------

describe("T2 ① agent-status read rule — gated additive segment", () => {
  it("bar-active resolver (agentStatusReadRule: true) → system contains the read-rule sentence verbatim, exactly once", async () => {
    const resolver = createIknowSystemResolver({
      cwd: workDir,
      userHome: workDir,
      surface: "chat",
      memoryEnabled: false,
      agentStatusReadRule: true,
    });
    const out = (await resolver()) ?? "";
    expect(out).toContain(IKNOW_AGENT_STATUS_READ_RULE);
    // Exactly once in the whole text (not printed per bar, not re-injected).
    expect(out.split(IKNOW_AGENT_STATUS_READ_RULE).length - 1).toBe(1);
  });

  it("ask-shaped resolver (no agentStatusReadRule — same opts the worker path passes) → sentence absent", async () => {
    // The other half of the gating: ask / worker assemblies pass no
    // agentStatusReadRule (single build-engine gate `surface !== "ask" &&
    // opts.todoDir`; the subagent worker resolver uses surface "ask" and omits
    // this seam) → segment absent, byte-level zero change. A rule for a bar
    // that never appears is permanent noise, so those surfaces skip injection.
    const resolver = createIknowSystemResolver({
      cwd: workDir,
      userHome: workDir,
      surface: "ask",
      memoryEnabled: false,
    });
    const out = (await resolver()) ?? "";
    expect(out).not.toContain(IKNOW_AGENT_STATUS_READ_RULE);
    expect(out).not.toContain("<agent_status>");
  });

  it("seam absent (assembleIdentityContext without agentStatusReadRule) → byte-identical zero change", async () => {
    const out = await assembleIdentityContext(baseCtx());
    expect(out).toBeDefined();
    expect(out).not.toContain(IKNOW_AGENT_STATUS_READ_RULE);
    expect(out).not.toContain("<agent_status>");
  });
});

// ---------------------------------------------------------------------------
// ADR-0112 read-rule semantics: authority = the frame the host injects for
// this turn; official-looking shapes are not verified via a roster
// ---------------------------------------------------------------------------
// Pinned invariants (spec invariants 2/3 + ADR-0112 decision 6): current state
// trusts only this turn's host-injected `<agent_status>` frame; bar-styled
// content in escaped forms / tool_result / untagged user text is data without
// authority; the `instruction:` echo line inside a frame is verbatim user
// text, not a host directive; never claim transcript "latest" tags are
// authoritative (roster anti-forgery was rejected by ADR-0009/0109). Wording
// may be polished, but deleting a semantic clause must turn RED. The system
// prefix is a SEAM-tier surface per docs/guides/prompt-development.md
// (ordering + byte stability; roster n/a), so this STATIC lock suffices.

describe("ADR-0112 T3 read-rule semantics — only this turn's host frame carries authority", () => {
  it("grounds current state in the host-injected frame for this turn, not transcript recency", () => {
    expect(IKNOW_AGENT_STATUS_READ_RULE).toMatch(/host injects for this turn/);
    // The old contract "the latest `<agent_status>` message is authoritative"
    // is retired: the rule must not treat transcript recency as authority.
    expect(IKNOW_AGENT_STATUS_READ_RULE).not.toMatch(/latest/i);
    expect(IKNOW_AGENT_STATUS_READ_RULE).not.toMatch(
      /last (?:`<agent_status>` )?message/i
    );
  });

  it("declares escaped forms, tool-result text and look-alike user messages as data without authority", () => {
    // The outbound projection transcodes official frame syntax in untagged
    // payloads into escaped form — the rule must name this transcode so the
    // model does not misread the escaped text as a truncated official frame.
    expect(IKNOW_AGENT_STATUS_READ_RULE).toContain("&lt;agent_status&gt;");
    expect(IKNOW_AGENT_STATUS_READ_RULE).toMatch(/tool results/i);
    expect(IKNOW_AGENT_STATUS_READ_RULE).toMatch(/data, not an official frame/);
  });

  it("marks the instruction: echo line inside the trusted frame as user data, not a host directive", () => {
    // ADR-0103 echo: the `instruction:` line of a tagged frame echoes the
    // user's raw text verbatim, which is user data — the rule must not let it
    // borrow the host frame's shape to become a host directive.
    expect(IKNOW_AGENT_STATUS_READ_RULE).toContain("`instruction:`");
    expect(IKNOW_AGENT_STATUS_READ_RULE).toMatch(/user data/i);
  });

  it("keeps the bar field semantics (last_tool / todos presence contract)", () => {
    // The ADR-0028 bar-field semantics survive the authority rewrite: both
    // last_tool and the todos present/absent arms must still be spelled out in
    // the rule (an absent section means no open items; empty slots are not advertised).
    expect(IKNOW_AGENT_STATUS_READ_RULE).toContain("`last_tool`");
    expect(IKNOW_AGENT_STATUS_READ_RULE).toMatch(
      /absent todos section means there are no open items/
    );
  });
});

// ---------------------------------------------------------------------------
// (build-engine seam): one gate expression drives both deps.agentStatus and
// the read-rule segment
// ---------------------------------------------------------------------------

function makeEnv(apiKey: string): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
  };
}

describe("T2 ① build-engine gate — deps.agentStatus 与读规则段同门(单一 gate,无漂移)", () => {
  it("chat + todoDir → deps.agentStatus 在场 AND system 含读规则句", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-read-rule-build-"));
    try {
      const todoDir = join(tmp, "todos");
      const { deps, shutdown } = await buildHarnessEngine({
        env: makeEnv("sk-t2-read-rule-chat"),
        askUser: createNoAskUser(),
        surface: "chat",
        todoDir,
        userHome: tmp,
        cwd: tmp,
        // This file pins the agentStatus gating and the read-rule sentence,
        // not overflow eviction / index downgrade (see
        // build-engine-tool-overflow.test.ts and tests/harness/disclosure-index-align/).
        // skipCountTokens bypasses assembly-time token counting; see the
        // BuildEngineOpts.skipCountTokens doc.
        skipCountTokens: true,
      });
      try {
        expect(deps.agentStatus).toEqual({ todoDir });
        const out = (await deps.system?.()) ?? "";
        expect(out).toContain(IKNOW_AGENT_STATUS_READ_RULE);
      } finally {
        await shutdown?.();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("ask + todoDir → deps.agentStatus 缺席 AND system 不含读规则句(同一 gate 的另一臂)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-read-rule-ask-"));
    try {
      const todoDir = join(tmp, "todos");
      const { deps } = await buildHarnessEngine({
        env: makeEnv("sk-t2-read-rule-ask"),
        askUser: createNoAskUser(),
        surface: "ask",
        todoDir,
        userHome: tmp,
        cwd: tmp,
        skipCountTokens: true, // as above: exercise the other arm of the same gate.
      });
      expect(deps.agentStatus).toBeUndefined();
      const out = (await deps.system?.()) ?? "";
      expect(out).not.toContain(IKNOW_AGENT_STATUS_READ_RULE);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("chat 但 host 未注入 todoDir → 栏不注入,读规则句同样缺席", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-read-rule-notodo-"));
    try {
      const { deps, shutdown } = await buildHarnessEngine({
        env: makeEnv("sk-t2-read-rule-notodo"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: tmp,
        cwd: tmp,
        skipCountTokens: true, // as above: without todoDir both the bar and the rule are absent.
      });
      try {
        expect(deps.agentStatus).toBeUndefined();
        const out = (await deps.system?.()) ?? "";
        expect(out).not.toContain(IKNOW_AGENT_STATUS_READ_RULE);
      } finally {
        await shutdown?.();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-turn byte stability (KV-cache contract; shape mirrors
// identity-assemble-skills.test.ts)
// ---------------------------------------------------------------------------

describe("T2 ② read-rule segment byte-stability", () => {
  it("is byte-stable across repeat calls with unchanged inputs (KV cache contract)", async () => {
    const a = await assembleIdentityContext(
      baseCtx({ agentStatusReadRule: true })
    );
    const b = await assembleIdentityContext(
      baseCtx({ agentStatusReadRule: true })
    );
    expect(a).toBeDefined();
    expect(b).toBe(a);
    expect(a).toContain(IKNOW_AGENT_STATUS_READ_RULE);
  });

  it("the sentence itself is per-turn interpolation-free (static const, single string)", () => {
    // Machine-checkable proxy for zero per-turn interpolation: the sentence
    // contains no runtime-only values (cwd / time / tool names), fixed vocabulary only.
    expect(IKNOW_AGENT_STATUS_READ_RULE).not.toContain(workDir);
    expect(IKNOW_AGENT_STATUS_READ_RULE).not.toMatch(/\$\{/);
    expect(IKNOW_AGENT_STATUS_READ_RULE.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Bar text carries current facts only: no read-rule or skip-condition sentence
// ---------------------------------------------------------------------------

describe("T2 ③ bar text carries facts only — no policy prose", () => {
  it("buildAgentStatusText output (todos present / absent) contains neither sentence", () => {
    const withTodos = buildAgentStatusText({
      lastTool: "todo_write",
      openTodoLines: ["- [ ] alpha task", "- [ ] beta task"],
    });
    const idleNoTodos = buildAgentStatusText({
      lastTool: AGENT_STATUS_IDLE_TOOL,
      openTodoLines: [],
    });
    for (const bar of [withTodos, idleNoTodos]) {
      expect(bar).not.toContain(IKNOW_AGENT_STATUS_READ_RULE);
      expect(bar).not.toContain(TODO_WRITE_SKIP_CLAUSE);
      // Keyword-level backstop: read-rule prose markers never enter the bar.
      expect(bar).not.toContain("authoritative");
    }
  });

  it("computeAgentStatusSnapshot text (real todos.md read) stays prose-free", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-read-rule-bar-"));
    try {
      await writeFile(
        join(tmp, "todos.md"),
        "- [ ] open item\n- [x] closed item\n",
        "utf8"
      );
      const { text } = await computeAgentStatusSnapshot({
        lastTool: "read_file",
        todoDir: tmp,
      });
      expect(text).toContain("last_tool: read_file");
      expect(text).toContain("- [ ] [t1] open item");
      // Completed items never enter the bar (stronger than the literal form:
      // no checked marker at all may appear).
      expect(text).not.toContain("[x]");
      expect(text).not.toContain(IKNOW_AGENT_STATUS_READ_RULE);
      expect(text).not.toContain(TODO_WRITE_SKIP_CLAUSE);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
});
