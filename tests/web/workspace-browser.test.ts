/**
 * serve-workspace T3 — picker 子目录浏览器纯逻辑单测 (node + vitest)。
 *
 * 镜像 `tests/web/session-info.test.ts` 模式 (直接 import 纯函数, 不依赖
 * jsdom / fetch)。web 包禁装 vitest (spec A8/A10), 这些测试由根 vitest
 * 收集。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  breadcrumbs,
  entryToInputPath,
  resolveBrowserRoot,
  WSL_DEFAULT_BASE,
} from "../../web/src/lib/workspace-browser.ts";

describe("resolveBrowserRoot — mount base 决议", () => {
  it("currentRoot 有值 → 优先 currentRoot (已绑定不跳回 default)", () => {
    assert.equal(resolveBrowserRoot("/abs/bound/root"), "/abs/bound/root");
  });

  it("currentRoot = null → 走 WSL_DEFAULT_BASE", () => {
    assert.equal(resolveBrowserRoot(null), WSL_DEFAULT_BASE);
  });

  it("currentRoot 空串 / 纯空白 → 视为缺席, 走 default", () => {
    assert.equal(resolveBrowserRoot(""), WSL_DEFAULT_BASE);
    assert.equal(resolveBrowserRoot("   "), WSL_DEFAULT_BASE);
  });

  it("可注入 defaultBase (测试用, 避免污染 WSL_DEFAULT_BASE)", () => {
    assert.equal(
      resolveBrowserRoot(null, "/custom/default"),
      "/custom/default"
    );
  });
});

describe("breadcrumbs — 路径切片", () => {
  it("POSIX 绝对路径 → 含根的 5 段", () => {
    const segs = breadcrumbs("/home/winner/projects/iknow");
    assert.equal(segs.length, 5);
    assert.deepEqual(
      segs.map((s) => s.name),
      ["/", "home", "winner", "projects", "iknow"]
    );
    assert.deepEqual(
      segs.map((s) => s.path),
      [
        "/",
        "/home",
        "/home/winner",
        "/home/winner/projects",
        "/home/winner/projects/iknow",
      ]
    );
  });

  it("根 '/' → 单段 (picker 永远至少展示一段)", () => {
    const segs = breadcrumbs("/");
    assert.equal(segs.length, 1);
    assert.equal(segs[0]?.name, "/");
    assert.equal(segs[0]?.path, "/");
  });

  it("空串 / 纯空白 → 兜底为根段", () => {
    assert.deepEqual(breadcrumbs(""), [{ name: "/", path: "/" }]);
    assert.deepEqual(breadcrumbs("   "), [{ name: "/", path: "/" }]);
  });

  it("POSIX 尾斜杠不产生空段", () => {
    const segs = breadcrumbs("/home/winner/");
    assert.deepEqual(
      segs.map((s) => s.name),
      ["/", "home", "winner"]
    );
  });

  it("Windows 反斜杠路径 → 同样按层级切片 (镜像 WorkspaceChip.basename 兼容)", () => {
    const segs = breadcrumbs("C:\\Users\\winner\\projects");
    assert.deepEqual(
      segs.map((s) => s.name),
      ["/", "C:", "Users", "winner", "projects"]
    );
  });
});

describe("entryToInputPath — 后端 entry → input 值", () => {
  it("直接透传 entry.path (后端 SSOT, 不重新 join)", () => {
    assert.equal(
      entryToInputPath({ name: "iknow", path: "/home/winner/iknow" }),
      "/home/winner/iknow"
    );
  });
});
