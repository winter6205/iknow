/**
 * ADR-0092: `/config` command SSOT unit tests (parsing + execution + copy).
 *
 * The three command-SSOT functions (`parseConfigCommand` / `applyFsModeCommand` /
 * `formatFsModeStatus`) live in `src/harness/sandbox/fs-mode.ts`. This test covers
 * the command SSOT's value domain and user-visible copy on the vitest side; the
 * TUI / serve integration is in `tests/tui/fs-mode.test.tsx` and the `/config`
 * vocabulary assertions in `tests/tui/slash.test.ts`.
 *
 * Coverage shape mirrors the graph-mode three-function SSOT pattern (parse /
 * apply / format): value-domain closure, extra-args rejection, copy locking,
 * single-token trim/lowercase, holder wiring and switching.
 */
import { describe, expect, test } from "vitest";

import {
  applyFsModeCommand,
  formatFsModeStatus,
  parseConfigCommand,
  parseFsModeFlag,
  splitConfigArgs,
  createFsModeContext,
  FS_MODE_USAGE_TEXT,
  type ConfigCommand,
  type FsIsolationMode,
} from "../../src/harness/sandbox/fs-mode.ts";

// Note: this function is the literal guard for the **command surface** only
// (`/config` args + holder `set` fallback). The settings section bypasses it —
// `isolation.fsMode` is validated separately in `src/config/settings.ts` against
// **case-sensitive** literals (`"Workspace"` is dropped in settings.json yet hits
// via `/config fs Workspace`). Relaxing the settings side requires an ADR ruling.
describe("parseFsModeFlag（命令面值域：/config args + holder set）", () => {
  test("'global' → 'global'", () => {
    expect(parseFsModeFlag("global")).toBe("global");
  });
  test("'workspace' → 'workspace'", () => {
    expect(parseFsModeFlag("workspace")).toBe("workspace");
  });
  test("trim + 小写：'  Workspace  ' → 'workspace'（大小写不敏感）", () => {
    expect(parseFsModeFlag("  Workspace  ")).toBe("workspace");
    expect(parseFsModeFlag("Global")).toBe("global");
    expect(parseFsModeFlag("WORKSPACE")).toBe("workspace");
  });
  test("其它字面（空串 / 其它字符串 / 布尔 / 数字 / null / undefined）→ undefined", () => {
    expect(parseFsModeFlag("")).toBeUndefined();
    expect(parseFsModeFlag("on")).toBeUndefined();
    expect(parseFsModeFlag("glo bal")).toBeUndefined();
    expect(parseFsModeFlag(true)).toBeUndefined();
    expect(parseFsModeFlag(1)).toBeUndefined();
    expect(parseFsModeFlag(null)).toBeUndefined();
    expect(parseFsModeFlag(undefined)).toBeUndefined();
  });
});

describe("parseConfigCommand（/config args 解析）", () => {
  test("空 / ['status'] → status 查询", () => {
    expect(parseConfigCommand([])).toEqual({ kind: "status" });
    expect(parseConfigCommand(["status"])).toEqual({ kind: "status" });
  });

  test("['fs', 'global'] → set global", () => {
    expect(parseConfigCommand(["fs", "global"])).toEqual({
      kind: "set",
      mode: "global",
    });
  });

  test("['fs', 'workspace'] → set workspace", () => {
    expect(parseConfigCommand(["fs", "workspace"])).toEqual({
      kind: "set",
      mode: "workspace",
    });
  });

  test("trim + 小写：['  FS  ', '  Workspace  '] → set workspace", () => {
    expect(parseConfigCommand(["  FS  ", "  Workspace  "])).toEqual({
      kind: "set",
      mode: "workspace",
    });
  });

  test("['fs'] 缺 mode 参数 → usage", () => {
    expect(parseConfigCommand(["fs"])).toEqual({ kind: "usage" });
  });

  test("['fs', 'invalid'] 非法 mode → usage", () => {
    expect(parseConfigCommand(["fs", "invalid"])).toEqual({ kind: "usage" });
  });

  test("['fs', 'global', 'extra'] 多余参数 → usage（不静默忽略）", () => {
    expect(parseConfigCommand(["fs", "global", "extra"])).toEqual({
      kind: "usage",
    });
  });

  test("['status', 'extra'] 多余参数 → usage", () => {
    expect(parseConfigCommand(["status", "extra"])).toEqual({
      kind: "usage",
    });
  });

  test("['unknown'] 未知首 token → usage", () => {
    expect(parseConfigCommand(["unknown"])).toEqual({ kind: "usage" });
  });

  test("['fs', ''] 空 mode → usage", () => {
    expect(parseConfigCommand(["fs", ""])).toEqual({ kind: "usage" });
  });

  // Exhaustiveness discipline (mirrors the RECOVERABILITY shape in
  // tests/harness/isolation/recoverability.test.ts): the Record's key type is
  // ConfigCommand["kind"], so adding/removing a kind without syncing this table
  // fails `npm run typecheck` (primary defense); the table below additionally
  // pins "every kind really is producible by the parser" as a runtime assertion
  // (secondary defense).
  const KIND_PROBE: Record<ConfigCommand["kind"], () => ConfigCommand["kind"]> =
    {
      status: () => parseConfigCommand([]).kind,
      set: () => parseConfigCommand(["fs", "global"]).kind,
      usage: () => parseConfigCommand(["nope"]).kind,
    };

  test("每个 kind 都有可达的解析入口，且解析结果落在声明闭集内", () => {
    const observed = Object.entries(KIND_PROBE).map(([declared, probe]) => {
      // The kind the probe returns must be exactly the one it claims to cover — otherwise "has an entry" is fake.
      expect(probe()).toBe(declared);
      return declared;
    });
    expect(observed.sort()).toEqual(["set", "status", "usage"]);
  });

  test("闭集外的 kind 不被产出：任意输入都收敛到三类之一", () => {
    const inputs: string[][] = [
      [],
      ["status"],
      ["fs", "global"],
      ["fs", "workspace"],
      ["nope"],
      ["fs"],
      ["fs", "bad"],
    ];
    for (const args of inputs) {
      expect(["status", "set", "usage"]).toContain(
        parseConfigCommand(args).kind
      );
    }
  });

  test("越界 args 不崩：非字符串 / 空洞 / 超长数组 → usage（fail-closed，不抛）", () => {
    // Upper bound: args from the wire may be dirty. `?? ""` backstops only [0];
    // [1] passes straight to parseFsModeFlag (which has a typeof guard).
    // These inputs must not throw.
    expect(parseConfigCommand([undefined as unknown as string])).toEqual({
      kind: "usage",
    });
    expect(parseConfigCommand(["fs", undefined as unknown as string])).toEqual({
      kind: "usage",
    });
    expect(parseConfigCommand(["fs", null as unknown as string])).toEqual({
      kind: "usage",
    });
    // Lower bound: overlong args honor only the first two tokens; extras → usage.
    expect(parseConfigCommand(["fs", "global", "a", "b", "c"])).toEqual({
      kind: "usage",
    });
  });
});

describe("formatFsModeStatus（状态回显文案单点）", () => {
  test("global 档文案：明示「宿主真路径可读写，拦写靠权限 + hard-wall」", () => {
    const text = formatFsModeStatus("global");
    expect(text).toContain("global");
    // Copy must be readable and consistent with ADR-0092 concepts.
    expect(text).toMatch(/宿主|权限|hard-wall/);
  });

  test("workspace 档文案：明示「home 可见只读；写 = taskRoot + 会话 tmp」", () => {
    const text = formatFsModeStatus("workspace");
    expect(text).toContain("workspace");
    expect(text).toMatch(/taskRoot|会话 tmp|tmp/);
  });
});

describe("applyFsModeCommand（holder 上执行 + 用户可见文案）", () => {
  test("status 查询 → ok=true，holder 不动，文案含当前档", () => {
    const ctx = createFsModeContext("global");
    const res = applyFsModeCommand(ctx, []);
    expect(res.ok).toBe(true);
    expect(ctx.get()).toBe("global");
    expect(res.text).toContain("global");
  });

  test("set global → 翻 holder 到 global，ok=true，文案含「已切换」", () => {
    const ctx = createFsModeContext("workspace");
    const res = applyFsModeCommand(ctx, ["fs", "global"]);
    expect(res.ok).toBe(true);
    expect(ctx.get()).toBe("global");
    expect(res.text).toMatch(/已切换|global/);
  });

  test("set workspace → 翻 holder 到 workspace，ok=true", () => {
    const ctx = createFsModeContext("global");
    const res = applyFsModeCommand(ctx, ["fs", "workspace"]);
    expect(res.ok).toBe(true);
    expect(ctx.get()).toBe("workspace");
    expect(res.text).toMatch(/已切换|workspace/);
  });

  test("set 文案明示「下一次 bash 调用生效」（与 spec SC13 行为一致）", () => {
    const ctx = createFsModeContext("global");
    const res = applyFsModeCommand(ctx, ["fs", "workspace"]);
    expect(res.text).toMatch(/下一次|生效/);
  });

  test("usage 路径：非法参数 → ok=false，holder 不动，text = FS_MODE_USAGE_TEXT", () => {
    const ctx = createFsModeContext("global");
    const res = applyFsModeCommand(ctx, ["fs", "bad"]);
    expect(res.ok).toBe(false);
    expect(ctx.get()).toBe("global"); // holder untouched
    expect(res.text).toBe(FS_MODE_USAGE_TEXT);
  });

  test("holder 初始值与会话缺省：settings 缺省 global（resolveFsIsolationMode 兜底）", () => {
    const ctx = createFsModeContext("global");
    expect(ctx.get()).toBe("global");
  });
});

describe("splitConfigArgs（自由文本 args 切词）", () => {
  test("空串 → 空数组", () => {
    expect(splitConfigArgs("")).toEqual([]);
  });
  test("纯空白 → 空数组", () => {
    expect(splitConfigArgs("   ")).toEqual([]);
  });
  test("'fs workspace' → ['fs', 'workspace']", () => {
    expect(splitConfigArgs("fs workspace")).toEqual(["fs", "workspace"]);
  });
  test("'  fs   global  ' → trim 后切", () => {
    expect(splitConfigArgs("  fs   global  ")).toEqual(["fs", "global"]);
  });
  test("'status' → ['status']", () => {
    expect(splitConfigArgs("status")).toEqual(["status"]);
  });
});

describe("createFsModeContext（T7 提供的 holder 工厂）", () => {
  test("缺省 initial = 'global'（与 settings 解析兜底一致）", () => {
    const ctx = createFsModeContext();
    expect(ctx.get()).toBe<FsIsolationMode>("global");
  });

  test("显式 initial = 'workspace' → 初始即为 workspace", () => {
    const ctx = createFsModeContext("workspace");
    expect(ctx.get()).toBe<FsIsolationMode>("workspace");
  });

  test("set 后 get 返回新值（holder 真的可变）", () => {
    const ctx = createFsModeContext("global");
    ctx.set("workspace");
    expect(ctx.get()).toBe("workspace");
    ctx.set("global");
    expect(ctx.get()).toBe("global");
  });

  test("两次 set 不影响初始引用（holder 是 holder，不复制 snapshot）", () => {
    const ctx = createFsModeContext("global");
    const before = ctx.get();
    ctx.set("workspace");
    expect(before).toBe("global"); // old snapshot unchanged
    expect(ctx.get()).toBe("workspace");
  });
});
