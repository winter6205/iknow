import { describe, expect, it } from "vitest";
import { probeVerifyCommand } from "../../../src/harness/verify/command-probe.js";

/**
 * Auto-probe matrix:
 *   - each marker file hits the right command (pyproject.toml / pytest.ini /
 *     package.json+vitest / package.json+jest / go.mod / Cargo.toml);
 *   - conflict → null: multiple markers (pyproject+go.mod), both vitest+jest
 *     deps in one package.json, split across two content entries, or content
 *     mixed with a marker;
 *   - no marker / empty input / parse failure / unexpected shape → null (fail-closed);
 *   - the same candidate hit twice (pyproject+pytest.ini) still returns that
 *     command (not a conflict).
 */

describe("D2 自动探测 - 标志文件命中", () => {
  it("pyproject.toml → pytest", () => {
    expect(probeVerifyCommand(["pyproject.toml"])).toBe("pytest");
  });

  it("pytest.ini → pytest", () => {
    expect(probeVerifyCommand(["pytest.ini"])).toBe("pytest");
  });

  it("pyproject.toml + pytest.ini 同候选 → pytest (不冲突)", () => {
    expect(probeVerifyCommand(["pyproject.toml", "pytest.ini"])).toBe("pytest");
  });

  it("go.mod → go test ./...", () => {
    expect(probeVerifyCommand(["go.mod"])).toBe("go test ./...");
  });

  it("Cargo.toml → cargo test", () => {
    expect(probeVerifyCommand(["Cargo.toml"])).toBe("cargo test");
  });
});

describe("D2 自动探测 - package.json 内容形态", () => {
  it("dependencies 含 vitest → npx vitest run", () => {
    const content = JSON.stringify({
      name: "x",
      dependencies: { vitest: "^1.0.0" },
    });
    expect(probeVerifyCommand([content])).toBe("npx vitest run");
  });

  it("devDependencies 含 vitest → npx vitest run", () => {
    const content = JSON.stringify({
      name: "x",
      devDependencies: { vitest: "^1.0.0" },
    });
    expect(probeVerifyCommand([content])).toBe("npx vitest run");
  });

  it("dependencies 含 jest → npx jest", () => {
    const content = JSON.stringify({
      name: "x",
      dependencies: { jest: "^29.0.0" },
    });
    expect(probeVerifyCommand([content])).toBe("npx jest");
  });

  it("devDependencies 含 jest → npx jest", () => {
    const content = JSON.stringify({
      name: "x",
      devDependencies: { jest: "^29.0.0" },
    });
    expect(probeVerifyCommand([content])).toBe("npx jest");
  });

  it("解析成功但无 vitest/jest dep → null", () => {
    const content = JSON.stringify({
      name: "x",
      devDependencies: { lodash: "^4.0.0" },
    });
    expect(probeVerifyCommand([content])).toBeNull();
  });

  it("JSON 解析失败 → null (fail-closed)", () => {
    expect(probeVerifyCommand(["{not valid json"])).toBeNull();
  });

  it("package.json 纯路径条目不贡献候选", () => {
    expect(probeVerifyCommand(["package.json"])).toBeNull();
  });
});

describe("D2 自动探测 - 冲突 (fail-closed null)", () => {
  it("多标志 (pyproject.toml + go.mod) → null", () => {
    expect(probeVerifyCommand(["pyproject.toml", "go.mod"])).toBeNull();
  });

  it("多标志 (pytest.ini + Cargo.toml) → null", () => {
    expect(probeVerifyCommand(["pytest.ini", "Cargo.toml"])).toBeNull();
  });

  it("同 package.json 同时含 vitest + jest → null", () => {
    const content = JSON.stringify({
      name: "x",
      devDependencies: { vitest: "^1.0.0", jest: "^29.0.0" },
    });
    expect(probeVerifyCommand([content])).toBeNull();
  });

  it("vitest + jest 分处两个 package.json 内容条目 → null", () => {
    const a = JSON.stringify({
      name: "a",
      devDependencies: { vitest: "^1.0.0" },
    });
    const b = JSON.stringify({
      name: "b",
      devDependencies: { jest: "^29.0.0" },
    });
    expect(probeVerifyCommand([a, b])).toBeNull();
  });

  it("package.json(vitest) + go.mod 标志混合 → null", () => {
    const content = JSON.stringify({
      name: "x",
      devDependencies: { vitest: "^1.0.0" },
    });
    expect(probeVerifyCommand([content, "go.mod"])).toBeNull();
  });

  it("package.json(jest) + pyproject.toml 标志混合 → null", () => {
    const content = JSON.stringify({
      name: "x",
      devDependencies: { jest: "^29.0.0" },
    });
    expect(probeVerifyCommand([content, "pyproject.toml"])).toBeNull();
  });
});

describe("D2 自动探测 - 无候选 (fail-closed null)", () => {
  it("空数组 → null", () => {
    expect(probeVerifyCommand([])).toBeNull();
  });

  it("未识别路径 (无 { 前缀, 不在标志表) → null", () => {
    expect(probeVerifyCommand(["README.md", "src/index.ts"])).toBeNull();
  });
});

describe("D2 自动探测 - 契约形状", () => {
  it("返回 string | null", () => {
    const hit = probeVerifyCommand(["pyproject.toml"]);
    expect(typeof hit).toBe("string");
    const miss = probeVerifyCommand([]);
    expect(miss).toBeNull();
  });
});
