/**
 * T3 (#344) — MCP 两级 config 解析器单测。
 *
 * 验收(参见 plans/337-skill-mcp-extension.md §T3 + specs/337 §G2 D1):
 *  1. 两级 union:`~/.iknow/mcp.json`(user) + `<cwd>/.iknow/mcp.json`(project),
 *     同名 server **条目级整体覆盖**(无字段级深合并)。
 *  2. 判别联合 `{type:"stdio"|"remote"}`;`disabled:true` / `enabled:false`
 *     → disabled 态;坏条目跳过 + warn 恰好一行 + 不含 env 值。
 *  3. 不读 `~/.claude.json` / `.kiro/settings/mcp.json`(Never 区)。
 *
 * 测试只用 tmp fixture(never 真实 ~/.iknow);warn 通过 console.warn spy
 * 收集并断言内容。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadMcpConfig,
  type McpServerConfig,
  type McpServerSource,
} from "../../src/harness/mcp/config.ts";

/** 写一个 fixture 文件,自动 mkdir parent。 */
async function writeJsonFixture(path: string, body: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(body), "utf8");
}

/** 收集 console.warn 调用,返回单测结束时的快照。 */
let warnCalls: string[] = [];
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnCalls = [];
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  // 把每个 call 的 args 序列化成单行字符串,断言 reason 时只看字符串。
  warnSpy.mockImplementation((...args: unknown[]) => {
    warnCalls.push(args.map((a) => String(a)).join(" "));
  });
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("loadMcpConfig — 两级 union", () => {
  it("user 级独有 server:返回 + source=user", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        onlyUser: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@a/server"],
        },
      },
    });

    const result = await loadMcpConfig({ home, cwd });

    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.name).toBe("onlyUser");
    expect(result.servers[0]?.source).toBe<McpServerSource>("user");
    expect(result.servers[0]?.kind).toBe("stdio");
    expect(warnCalls).toEqual([]);
  });

  it("project 级独有 server:并入 + source=project", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(cwd, ".iknow", "mcp.json"), {
      mcpServers: {
        onlyProject: {
          type: "remote",
          url: "https://example.com/mcp",
        },
      },
    });

    const result = await loadMcpConfig({ home, cwd });

    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.name).toBe("onlyProject");
    expect(result.servers[0]?.source).toBe<McpServerSource>("project");
    expect(result.servers[0]?.kind).toBe("remote");
  });

  it("同名 server:project 整体替换 user(无字段级深合并)", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        shared: {
          type: "stdio",
          command: "user-cmd",
          args: ["--from-user"],
          env: { USER_ONLY_SECRET: "must-not-leak", SHARED_KEEP: "1" },
        },
      },
    });
    // project 改了 command,但**没有** env 字段;期望覆盖后:
    //  - command = "project-cmd"
    //  - args = ["--from-project"]
    //  - env 整段不存在(被整体替换,user 的 env 不会保留)
    await writeJsonFixture(join(cwd, ".iknow", "mcp.json"), {
      mcpServers: {
        shared: {
          type: "stdio",
          command: "project-cmd",
          args: ["--from-project"],
        },
      },
    });

    const result = await loadMcpConfig({ home, cwd });

    expect(result.servers).toHaveLength(1);
    const s = result.servers[0];
    expect(s?.name).toBe("shared");
    expect(s?.source).toBe<McpServerSource>("project");
    expect(s?.kind).toBe("stdio");
    if (s?.kind !== "stdio") throw new Error("expected stdio");

    // 关键断言:user 的 env 整段消失,不是字段 merge
    expect(s.entry.env).toBeUndefined();
    expect(s.entry.command).toBe("project-cmd");
    expect(s.entry.args).toEqual(["--from-project"]);
    // user 的 USER_ONLY_SECRET 绝不能出现在最终配置里
    expect(JSON.stringify(s)).not.toContain("USER_ONLY_SECRET");
    expect(JSON.stringify(s)).not.toContain("must-not-leak");
  });

  it("project + user 混合:输出顺序稳定(按字母序),project 标记覆盖 user", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        alpha: { type: "stdio", command: "u-alpha" },
        beta: { type: "stdio", command: "u-beta" },
        gamma: { type: "stdio", command: "u-gamma" },
      },
    });
    await writeJsonFixture(join(cwd, ".iknow", "mcp.json"), {
      mcpServers: {
        beta: { type: "stdio", command: "p-beta" }, // 覆盖
        delta: { type: "stdio", command: "p-delta" }, // 新增
      },
    });

    const result = await loadMcpConfig({ home, cwd });
    const byName = new Map(result.servers.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual([
      "alpha",
      "beta",
      "delta",
      "gamma",
    ]);
    expect(byName.get("alpha")?.source).toBe<McpServerSource>("user");
    expect(byName.get("beta")?.source).toBe<McpServerSource>("project");
    expect(byName.get("delta")?.source).toBe<McpServerSource>("project");
    expect(byName.get("gamma")?.source).toBe<McpServerSource>("user");
    if (byName.get("beta")?.kind !== "stdio") throw new Error("stdio");
    expect(byName.get("beta")?.entry.command).toBe("p-beta");
  });
});

describe("loadMcpConfig — 判别联合 + disabled", () => {
  it("disabled:true → status=disabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        d: { type: "stdio", command: "x", disabled: true },
      },
    });

    const result = await loadMcpConfig({ home, cwd });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.status).toBe("disabled");
  });

  it("enabled:false → status=disabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        e: { type: "remote", url: "https://x", enabled: false },
      },
    });

    const result = await loadMcpConfig({ home, cwd });
    expect(result.servers[0]?.status).toBe("disabled");
  });

  it("enabled:true 覆盖 disabled:true → enabled(以 enabled 为权威)", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        b: { type: "stdio", command: "x", disabled: true, enabled: true },
      },
    });

    const result = await loadMcpConfig({ home, cwd });
    expect(result.servers[0]?.status).toBe("enabled");
  });

  it("缺 type 且有 url → 推断 remote", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: { r: { url: "https://x" } },
    });

    const result = await loadMcpConfig({ home, cwd });
    expect(result.servers[0]?.kind).toBe("remote");
  });

  it("缺 type 且无 url → 推断 stdio", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: { s: { command: "npx", args: ["x"] } },
    });

    const result = await loadMcpConfig({ home, cwd });
    expect(result.servers[0]?.kind).toBe("stdio");
  });
});

describe("loadMcpConfig — 坏条目隔离", () => {
  it("stdio 缺 command → skip + warn 恰好 1 行", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        bad: { type: "stdio", args: ["x"] }, // 缺 command
        good: { type: "stdio", command: "ok" },
      },
    });

    const result = await loadMcpConfig({ home, cwd });

    const names = result.servers.map((s) => s.name).sort();
    expect(names).toEqual(["good"]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("bad");
    expect(warnCalls[0]).toContain("[mcp/config]");
  });

  it("remote 缺 url → skip + warn", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: { r: { type: "remote" } },
    });

    const result = await loadMcpConfig({ home, cwd });
    expect(result.servers).toHaveLength(0);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("r");
  });

  it("非法 type → skip + warn(不会强行推断)", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: { x: { type: "websocket" } },
    });

    const result = await loadMcpConfig({ home, cwd });
    expect(result.servers).toHaveLength(0);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("x");
  });

  it("SC7:warn 行绝不包含 env 值 / command 值", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    const SECRET = "sk-very-secret-token-abc-123";
    const CMD = "/usr/local/private/binary";
    // 故意构造坏条目:无 type + 无 url + 无 command → 走 stdio 推断再校验失败 → skip + warn
    // 但条目里仍带 env / args,验证 warn 不抄写它们的值。
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        leakProbe: {
          args: ["--secret", SECRET],
          env: { TOKEN: SECRET, PWD_SECRET: SECRET },
          // 不给 type / command / url → 必然被 skip + warn,
          // 同时 env 里埋 SECRET 验证 warn 不外泄
        },
      },
    });

    const result = await loadMcpConfig({ home, cwd });

    expect(result.servers).toHaveLength(0);
    expect(warnCalls).toHaveLength(1);
    const w = warnCalls[0] ?? "";
    expect(w).not.toContain(SECRET);
    expect(w).not.toContain(CMD);
    expect(w).not.toContain("TOKEN");
    expect(w).not.toContain("PWD_SECRET");
  });

  it("warn 一条坏条目一行 — 多条坏条目产生多行 warn", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        a: { type: "stdio" },
        b: { type: "remote" },
        c: { type: "stdio", command: "ok" },
        d: { type: "websocket" },
      },
    });

    const result = await loadMcpConfig({ home, cwd });
    expect(result.servers.map((s) => s.name)).toEqual(["c"]);
    expect(warnCalls).toHaveLength(3);
    expect(warnCalls.some((w) => w.includes("a"))).toBe(true);
    expect(warnCalls.some((w) => w.includes("b"))).toBe(true);
    expect(warnCalls.some((w) => w.includes("d"))).toBe(true);
  });
});

describe("loadMcpConfig — 文件缺失 / 损坏 / 形态", () => {
  it("两个文件都缺失 → 空 config,不抛", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));

    const result = await loadMcpConfig({ home, cwd });
    expect(result.servers).toEqual([]);
    expect(warnCalls).toEqual([]);
  });

  it("JSON 损坏 → warn,降级为空(不影响其他级)", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), "{ not json");
    await writeJsonFixture(join(cwd, ".iknow", "mcp.json"), {
      mcpServers: { ok: { type: "stdio", command: "x" } },
    });

    const result = await loadMcpConfig({ home, cwd });
    expect(result.servers.map((s) => s.name)).toEqual(["ok"]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("[mcp/config]");
  });

  it("顶层就是 server map(无 mcpServers 包裹)— 也兼容", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      direct: { type: "stdio", command: "x" },
    });

    const result = await loadMcpConfig({ home, cwd });
    expect(result.servers.map((s) => s.name)).toEqual(["direct"]);
  });

  it("空对象 → 空 config,不 warn", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {});

    const result = await loadMcpConfig({ home, cwd });
    expect(result.servers).toEqual([]);
    expect(warnCalls).toEqual([]);
  });

  it("顶层是数组(非对象) → warn + 降级空", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), [
      "not",
      "an",
      "object",
    ]);

    const result = await loadMcpConfig({ home, cwd });
    expect(result.servers).toEqual([]);
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("server 条目不是对象(string) → skip + warn", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: { weird: "not-an-object" },
    });

    const result = await loadMcpConfig({ home, cwd });
    expect(result.servers).toEqual([]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("weird");
  });
});

describe("loadMcpConfig — 返回值类型稳定", () => {
  it("返回的 entry 是判别联合:stdio 一定有 command,remote 一定有 url", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        s: { type: "stdio", command: "c", args: ["a"] },
        r: { type: "remote", url: "https://e" },
      },
    });

    const result = await loadMcpConfig({ home, cwd });
    const s = result.servers.find((x) => x.name === "s");
    const r = result.servers.find((x) => x.name === "r");
    expect(s?.kind).toBe("stdio");
    expect(r?.kind).toBe("remote");
    // 类型守门 — 编译期不报错,运行期 narrow
    if (s?.kind === "stdio") {
      expect(s.entry.command).toBe("c");
      expect(s.entry.args).toEqual(["a"]);
    } else {
      throw new Error("s should be stdio");
    }
    if (r?.kind === "remote") {
      expect(r.entry.url).toBe("https://e");
    } else {
      throw new Error("r should be remote");
    }
  });
});
