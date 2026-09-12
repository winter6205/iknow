// #646 T2 / ADR-0028 / plans/agent-status-bar.md T2: system 前缀一句稳定读规则
// + todo_write 跳过条件的「不进栏」边界。
//
// 覆盖 T2 Acceptance:
//   ① 装配后的 system 含一句稳定读法(以最后一条 `<agent_status>` 消息为准;
//      todo 段缺席即当前无未勾项)—— 仅在栏会注入的表面在场;ask(-shaped)
//      装配不含该句(placement option a:ask / worker 永远看不到栏,读一条
//      absent 栏的规则是永久噪音)。
//   ② 相邻两轮同输入 → 整段 system(含该句)字节级相同(KV cache 契约,
//      形态对齐 identity-assemble-skills.test.ts:118)。
//   ③ 栏文本本身既不含读规则句、也不含 todo_write 跳过条件句
//      (ADR-0028:栏只承载代码算出的现势,不含政策散文;read-only 引用
//      src/harness/agent-status.ts 既有导出,不改该文件)。
//   ④ todo_write description 跳过条件的正面钉死在
//      tests/harness/aci/tools/todo-write.test.ts D9 块(本文件不重复)。
//   ⑤ 既有 identity / 装配 / build-engine 测试不因本段降级(由 scoped 全量
//      运行守住,本文件只加不减)。

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
// T2 ① 读规则句:仅栏会注入的表面在场(gated additive segment,option a)
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
    // 一句:全文只出现一次(不印在每条栏上、不重复注入)。
    expect(out.split(IKNOW_AGENT_STATUS_READ_RULE).length - 1).toBe(1);
  });

  it("ask-shaped resolver (no agentStatusReadRule — same opts the worker path passes) → sentence absent", async () => {
    // option a 的另一半:ask / worker 装配不传 agentStatusReadRule(build-engine
    // 单一 gate `surface !== "ask" && opts.todoDir`;subagent/worker.ts 的
    // resolver 走 surface "ask" 且不传本缝)→ 段缺席,字节级零变化。
    // 读一条永不在场的栏的规则是永久噪音,所以这些表面不注入。
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
// T2 ①(build-engine 缝):同一 gate 表达式驱动 deps.agentStatus 与读规则段
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
        // 本文件验 agentStatus 门禁与读规则句,不验溢出退场 / 索引降档
        // (专测见 build-engine-tool-overflow.test.ts、disclosure-index-align/)。
        // 旁路装配期 countTokens:缝语义见 BuildEngineOpts.skipCountTokens 注释。
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
        skipCountTokens: true, // 同上:验同一 gate 的另一臂。
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
        skipCountTokens: true, // 同上:验未注入 todoDir 时栏与读规则句同时缺席。
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
// T2 ② 跨回合字节稳定(KV cache 契约;形态对齐 identity-assemble-skills:118)
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
    // 无任何 per-turn 插值的机器可查代理:句子里不含运行期才知道的值占位
    // (cwd / 时间 / 工具名),只引用固定词汇。
    expect(IKNOW_AGENT_STATUS_READ_RULE).not.toContain(workDir);
    expect(IKNOW_AGENT_STATUS_READ_RULE).not.toMatch(/\$\{/);
    expect(IKNOW_AGENT_STATUS_READ_RULE.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// T2 ③ 栏文本只承载现势:不含读规则句、不含跳过条件句
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
      // 关键词级兜底:读规则散文的标志词不进栏。
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
      expect(text).toContain("- [ ] open item");
      expect(text).not.toContain(IKNOW_AGENT_STATUS_READ_RULE);
      expect(text).not.toContain(TODO_WRITE_SKIP_CLAUSE);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
});
