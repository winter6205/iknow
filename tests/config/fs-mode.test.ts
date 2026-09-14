/**
 * ADR-0092 / SC13: `/config` 命令 SSOT 单测（解析 + 执行 + 文案）。
 *
 * 命令 SSOT 三函数（`parseConfigCommand` / `applyFsModeCommand` /
 * `formatFsModeStatus`）落在 `src/harness/sandbox/fs-mode.ts`（T7 持有该
 * 文件主体；T8 仅追加这三个函数 + 相关类型 / 用法常量）。本测试在
 * vitest 面覆盖命令 SSOT 的值域与文案，TUI / serve 集成面见
 * `tests/tui/fs-mode.test.tsx` 与 `tests/tui/slash.test.ts` 的 `/config`
 * 词表断言。
 *
 * 镜像 `tests/harness/graph-mode.test.ts`（D-α V1）的 `parseGraphCommand`
 * / `applyGraphCommand` / `formatGraphStatus` 三函数 SSOT 覆盖形态：
 * 值域闭环、多余 args 拒绝、文案锁定、单字 trim/小写、holder 接通与切换。
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

// 注意：本函数是**命令面**（`/config` args + holder `set` 兜底）的字面守卫。
// settings 段不走它 —— `isolation.fsMode` 在 `src/config/settings.ts` 按
// **大小写敏感**字面量单独校验（`"Workspace"` 在 settings.json 被丢弃，
// 走 `/config fs Workspace` 却命中）。放宽 settings 侧需 ADR 裁定。
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

  // 穷尽性纪律（镜像 tests/harness/isolation/recoverability.test.ts 的
  // RECOVERABILITY 形态）：Record 的键类型是 ConfigCommand["kind"]，所以
  // 增删 kind 而不同步本表 → `npm run typecheck` 失败（主防线）；下表再把
  // 「每个 kind 确实能被解析器产出来」钉成运行时断言（副防线）。
  const KIND_PROBE: Record<ConfigCommand["kind"], () => ConfigCommand["kind"]> =
    {
      status: () => parseConfigCommand([]).kind,
      set: () => parseConfigCommand(["fs", "global"]).kind,
      usage: () => parseConfigCommand(["nope"]).kind,
    };

  test("每个 kind 都有可达的解析入口，且解析结果落在声明闭集内", () => {
    const observed = Object.entries(KIND_PROBE).map(([declared, probe]) => {
      // 探针返回的 kind 必须就是它自称覆盖的那个 —— 否则「有入口」是假的。
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
    // 上限：wire 来的 args 未必干净。`?? ""` 只在 [0] 兜底，[1] 直接透传
    // 给 parseFsModeFlag（后者 typeof 守卫）。这些输入不得抛。
    expect(parseConfigCommand([undefined as unknown as string])).toEqual({
      kind: "usage",
    });
    expect(parseConfigCommand(["fs", undefined as unknown as string])).toEqual({
      kind: "usage",
    });
    expect(parseConfigCommand(["fs", null as unknown as string])).toEqual({
      kind: "usage",
    });
    // 下限：超长 args 只认前两 token，多余一律 usage。
    expect(parseConfigCommand(["fs", "global", "a", "b", "c"])).toEqual({
      kind: "usage",
    });
  });
});

describe("formatFsModeStatus（状态回显文案单点）", () => {
  test("global 档文案：明示「宿主真路径可读写，拦写靠权限 + hard-wall」", () => {
    const text = formatFsModeStatus("global");
    expect(text).toContain("global");
    // 文案必须可读、与 spec SC13 / ADR-0092 概念一致。
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
    expect(ctx.get()).toBe("global"); // 不动 holder
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
    expect(before).toBe("global"); // 旧 snapshot 不变
    expect(ctx.get()).toBe("workspace");
  });
});
