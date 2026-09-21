/**
 * Unit tests for the two-level MCP config resolver.
 *
 * Acceptance:
 *  1. two-level union: `~/.iknow/mcp.json` (user) + `<mcpConfigRoot>/.iknow/mcp.json`
 *     (project); same-named server → **whole entry-level override** (no field-wise deep merge).
 *  2. project level reads **only** `mcpConfigRoot`, never the task worktree / `process.cwd()`.
 *  3. missing file → empty for that level; any other IO / JSON / top-level structure
 *     failure → `McpLifecycleError` kind `config_load_failed`.
 *  4. discriminated union / disabled / bad-entry skip+warn / Never zone keep the existing contract.
 *
 * Tests use only tmp fixtures (never the real ~/.iknow); warnings are
 * collected via a console.warn spy and asserted for content.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  McpLifecycleError,
  type McpLifecycleErrorKind,
} from "../../src/harness/errors.ts";
import {
  loadMcpConfig,
  type McpServerSource,
} from "../../src/harness/mcp/config.ts";

/** Write a fixture file, mkdir'ing the parent automatically. */
async function writeJsonFixture(path: string, body: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  if (typeof body === "string") {
    await writeFile(path, body, "utf8");
    return;
  }
  await writeFile(path, JSON.stringify(body), "utf8");
}

/** Assert an async call throws a typed error of the given kind. */
async function expectLifecycleError(
  call: () => Promise<unknown>,
  kind: McpLifecycleErrorKind
): Promise<McpLifecycleError> {
  let caught: unknown;
  try {
    await call();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(McpLifecycleError);
  const error = caught as McpLifecycleError;
  expect(error.kind).toBe(kind);
  expect(error.message.trim()).not.toBe("");
  expect(error.detail.trim()).not.toBe("");
  return error;
}

/** Collect console.warn calls; returns the snapshot at test end. */
let warnCalls: string[] = [];
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnCalls = [];
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  warnSpy.mockImplementation((...args: unknown[]) => {
    warnCalls.push(args.map((a) => String(a)).join(" "));
  });
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("loadMcpConfig — mcpConfigRoot-only project path", () => {
  it("reads project config from mcpConfigRoot, never from task worktree", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-product-"));
    const taskWorktree = await mkdtemp(join(tmpdir(), "iknow-mcp-task-"));
    await writeJsonFixture(join(productRoot, ".iknow", "mcp.json"), {
      mcpServers: {
        fromProduct: { type: "stdio", command: "product-cmd" },
      },
    });
    await writeJsonFixture(join(taskWorktree, ".iknow", "mcp.json"), {
      mcpServers: {
        fromTask: { type: "stdio", command: "task-cmd" },
      },
    });

    const result = await loadMcpConfig({
      home,
      mcpConfigRoot: productRoot,
    });

    expect(result.servers.map((s) => s.name)).toEqual(["fromProduct"]);
    expect(result.servers[0]?.source).toBe<McpServerSource>("project");
    if (result.servers[0]?.kind !== "stdio") throw new Error("stdio");
    expect(result.servers[0].entry.command).toBe("product-cmd");
  });

  it("never calls process.cwd() while loading", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(mcpConfigRoot, ".iknow", "mcp.json"), {
      mcpServers: { a: { type: "stdio", command: "x" } },
    });
    const cwdSpy = vi.spyOn(process, "cwd");

    await loadMcpConfig({ home, mcpConfigRoot });

    expect(cwdSpy).not.toHaveBeenCalled();
    cwdSpy.mockRestore();
  });

  it("missing project file → empty project level, user still loads", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: { onlyUser: { type: "stdio", command: "u" } },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });

    expect(result.servers.map((s) => s.name)).toEqual(["onlyUser"]);
    expect(warnCalls).toEqual([]);
  });
});

describe("loadMcpConfig — 两级 union", () => {
  it("user 级独有 server:返回 + source=user", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        onlyUser: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@a/server"],
        },
      },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });

    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.name).toBe("onlyUser");
    expect(result.servers[0]?.source).toBe<McpServerSource>("user");
    expect(result.servers[0]?.kind).toBe("stdio");
    expect(warnCalls).toEqual([]);
  });

  it("project 级独有 server:并入 + source=project", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(mcpConfigRoot, ".iknow", "mcp.json"), {
      mcpServers: {
        onlyProject: {
          type: "remote",
          url: "https://example.com/mcp",
        },
      },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });

    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.name).toBe("onlyProject");
    expect(result.servers[0]?.source).toBe<McpServerSource>("project");
    expect(result.servers[0]?.kind).toBe("remote");
  });

  it("同名 server:project 整体替换 user(无字段级深合并)", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
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
    await writeJsonFixture(join(mcpConfigRoot, ".iknow", "mcp.json"), {
      mcpServers: {
        shared: {
          type: "stdio",
          command: "project-cmd",
          args: ["--from-project"],
        },
      },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });

    expect(result.servers).toHaveLength(1);
    const s = result.servers[0];
    expect(s?.name).toBe("shared");
    expect(s?.source).toBe<McpServerSource>("project");
    expect(s?.kind).toBe("stdio");
    if (s?.kind !== "stdio") throw new Error("expected stdio");

    expect(s.entry.env).toBeUndefined();
    expect(s.entry.command).toBe("project-cmd");
    expect(s.entry.args).toEqual(["--from-project"]);
    expect(JSON.stringify(s)).not.toContain("USER_ONLY_SECRET");
    expect(JSON.stringify(s)).not.toContain("must-not-leak");
  });

  it("project + user 混合:输出顺序稳定(按字母序),project 标记覆盖 user", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        alpha: { type: "stdio", command: "u-alpha" },
        beta: { type: "stdio", command: "u-beta" },
        gamma: { type: "stdio", command: "u-gamma" },
      },
    });
    await writeJsonFixture(join(mcpConfigRoot, ".iknow", "mcp.json"), {
      mcpServers: {
        beta: { type: "stdio", command: "p-beta" },
        delta: { type: "stdio", command: "p-delta" },
      },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });
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
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        d: { type: "stdio", command: "x", disabled: true },
      },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.status).toBe("disabled");
  });

  it("enabled:false → status=disabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        e: { type: "remote", url: "https://x", enabled: false },
      },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });
    expect(result.servers[0]?.status).toBe("disabled");
  });

  it("enabled:true 覆盖 disabled:true → enabled(以 enabled 为权威)", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        b: { type: "stdio", command: "x", disabled: true, enabled: true },
      },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });
    expect(result.servers[0]?.status).toBe("enabled");
  });

  it("缺 type 且有 url → 推断 remote", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: { r: { url: "https://x" } },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });
    expect(result.servers[0]?.kind).toBe("remote");
  });

  it("缺 type 且无 url → 推断 stdio", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: { s: { command: "npx", args: ["x"] } },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });
    expect(result.servers[0]?.kind).toBe("stdio");
  });
});

describe("loadMcpConfig — 坏条目隔离", () => {
  it("stdio 缺 command → skip + warn 恰好 1 行", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        bad: { type: "stdio", args: ["x"] },
        good: { type: "stdio", command: "ok" },
      },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });

    const names = result.servers.map((s) => s.name).sort();
    expect(names).toEqual(["good"]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("bad");
    expect(warnCalls[0]).toContain("[mcp/config]");
  });

  it("remote 缺 url → skip + warn", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: { r: { type: "remote" } },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });
    expect(result.servers).toHaveLength(0);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("r");
  });

  it("非法 type → skip + warn(不会强行推断)", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: { x: { type: "websocket" } },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });
    expect(result.servers).toHaveLength(0);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("x");
  });

  it("SC7:warn 行绝不包含 env 值 / command 值", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    const SECRET = "sk-very-secret-token-abc-123";
    const CMD = "/usr/local/private/binary";
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        leakProbe: {
          args: ["--secret", SECRET],
          env: { TOKEN: SECRET, PWD_SECRET: SECRET },
        },
      },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });

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
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        a: { type: "stdio" },
        b: { type: "remote" },
        c: { type: "stdio", command: "ok" },
        d: { type: "websocket" },
      },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });
    expect(result.servers.map((s) => s.name)).toEqual(["c"]);
    expect(warnCalls).toHaveLength(3);
    expect(warnCalls.some((w) => w.includes("a"))).toBe(true);
    expect(warnCalls.some((w) => w.includes("b"))).toBe(true);
    expect(warnCalls.some((w) => w.includes("d"))).toBe(true);
  });
});

describe("loadMcpConfig — 文件缺失 / hard fail / 形态", () => {
  it("两个文件都缺失 → 空 config,不抛", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));

    const result = await loadMcpConfig({ home, mcpConfigRoot });
    expect(result.servers).toEqual([]);
    expect(warnCalls).toEqual([]);
  });

  it("JSON 损坏 → McpLifecycleError config_load_failed", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), "{ not json");
    await writeJsonFixture(join(mcpConfigRoot, ".iknow", "mcp.json"), {
      mcpServers: { ok: { type: "stdio", command: "x" } },
    });

    const err = await expectLifecycleError(
      () => loadMcpConfig({ home, mcpConfigRoot }),
      "config_load_failed"
    );
    expect(err.detail).not.toMatch(/sk-|secret|TOKEN|password/i);
  });

  it("顶层是数组(非对象) → McpLifecycleError config_load_failed", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), [
      "not",
      "an",
      "object",
    ]);

    await expectLifecycleError(
      () => loadMcpConfig({ home, mcpConfigRoot }),
      "config_load_failed"
    );
  });

  it("非缺失 IO 错误 → McpLifecycleError config_load_failed", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    const projectPath = join(mcpConfigRoot, ".iknow", "mcp.json");
    await writeJsonFixture(projectPath, {
      mcpServers: { a: { type: "stdio", command: "x" } },
    });
    // remove read permission → EACCES (where the platform enforces perms; otherwise this assertion is moot).
    await chmod(projectPath, 0);
    try {
      await expectLifecycleError(
        () => loadMcpConfig({ home, mcpConfigRoot }),
        "config_load_failed"
      );
    } finally {
      await chmod(projectPath, 0o644);
      await rm(home, { recursive: true, force: true }).catch(() => {});
      await rm(mcpConfigRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("顶层就是 server map(无 mcpServers 包裹)— 也兼容", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      direct: { type: "stdio", command: "x" },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });
    expect(result.servers.map((s) => s.name)).toEqual(["direct"]);
  });

  it("空对象 → 空 config,不 warn", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {});

    const result = await loadMcpConfig({ home, mcpConfigRoot });
    expect(result.servers).toEqual([]);
    expect(warnCalls).toEqual([]);
  });

  it("server 条目不是对象(string) → skip + warn", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: { weird: "not-an-object" },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });
    expect(result.servers).toEqual([]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("weird");
  });
});

describe("loadMcpConfig — 返回值类型稳定", () => {
  it("返回的 entry 是判别联合:stdio 一定有 command,remote 一定有 url", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-mcp-home-"));
    const mcpConfigRoot = await mkdtemp(join(tmpdir(), "iknow-mcp-root-"));
    await writeJsonFixture(join(home, ".iknow", "mcp.json"), {
      mcpServers: {
        s: { type: "stdio", command: "c", args: ["a"] },
        r: { type: "remote", url: "https://e" },
      },
    });

    const result = await loadMcpConfig({ home, mcpConfigRoot });
    const s = result.servers.find((x) => x.name === "s");
    const r = result.servers.find((x) => x.name === "r");
    expect(s?.kind).toBe("stdio");
    expect(r?.kind).toBe("remote");
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
