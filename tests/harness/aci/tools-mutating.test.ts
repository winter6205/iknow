/**
 * ACI 原型 Layer 1:fs_edit + shell_exec 单元测试。
 * 覆盖:lintPatch 配对（含 `\\` 转义 / 字符串内异种引号 / Windows 路径字面量）
 * / 各类不配对拒绝;fs_edit lint 拒绝坏补丁 + old_str 出现 0 / >1 次报错 +
 * 成功替换 + `$&` 字面量替换不被 String.replace 特殊模式展开;
 * shell_exec allowlist-first 拒绝危险 / 接受安全。
 */

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lintPatch } from "../../../src/harness/aci/tools/fs-edit.ts";
import { createFsEditTool } from "../../../src/harness/aci/tools/fs-edit.ts";
import { createShellExecTool } from "../../../src/harness/aci/tools/shell-exec.ts";
import { ToolExecutionError } from "../../../src/harness/errors.ts";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "aci-mut-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("lintPatch", () => {
  it("accepts balanced parentheses / brackets / braces", () => {
    assert.deepEqual(lintPatch("foo(bar) [baz] {qux}"), { ok: true });
  });

  it("rejects unmatched ')' (more close than open)", () => {
    const r = lintPatch("foo(bar))");
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("'"));
  });

  it("rejects unmatched ']' at end", () => {
    const r = lintPatch("foo([bar]");
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("unmatched"));
  });

  it("rejects unclosed '{' at end of patch", () => {
    const r = lintPatch("function f() { return 1");
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("unclosed"));
  });

  it("rejects mismatched pair (')' for '[')", () => {
    const r = lintPatch("[1, 2)");
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("expected"));
  });

  it("rejects unclosed double quote", () => {
    const r = lintPatch(`const x = "hello`);
    assert.equal(r.ok, false);
  });

  it("accepts escaped quotes (\\\" / \\' do not break pairing)", () => {
    // 字符串字面量 "a \\\" b" 内部带 \" 转义,不影响配对
    assert.deepEqual(lintPatch(`"a \\\" b"`), { ok: true });
    assert.deepEqual(lintPatch(`'a \\\' b'`), { ok: true });
  });

  it("accepts balanced single quotes", () => {
    assert.deepEqual(lintPatch(`'hello' + "world"`), { ok: true });
  });

  it("accepts empty string", () => {
    assert.deepEqual(lintPatch(""), { ok: true });
  });

  // ── Code review 后新增：状态机正确性回归 ──────────────────────────

  it("accepts `\"it's a test\"` (双引号字符串内的单引号 = 字面量)", () => {
    // 旧实现会把双引号内的 ' 误判为字符串开启,导致 ok=false。
    const r = lintPatch(`"it's a test"`);
    assert.deepEqual(r, { ok: true });
  });

  it("accepts `\"C:\\\\Users\\\\x\"` (Windows 路径字面量,含 `\\\\` 转义)", () => {
    // 旧实现不处理 \\ 转义,会把第一个 \\" 中的 \" 误闭合,导致 ok=false。
    const r = lintPatch(`"C:\\Users\\x"`);
    assert.deepEqual(r, { ok: true });
  });

  it("accepts nested string: `\"outer 'inner' outer\"`", () => {
    const r = lintPatch(`"outer 'inner' outer"`);
    assert.deepEqual(r, { ok: true });
  });

  it("accepts `\"a\\\\b\"` (\\\\ 视为字面量反斜杠,不误闭合)", () => {
    // 字符串字面量包含 \\ → 末位 \ 是 \\ 第二段,正确闭合。
    const r = lintPatch(`"a\\b"`);
    assert.deepEqual(r, { ok: true });
  });

  it("rejects unclosed single quote", () => {
    const r = lintPatch(`'unclosed`);
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("unclosed"));
  });

  it("rejects genuinely mismatched `\"a\"b` (单引号后无配对)", () => {
    // 双引号已闭合,然后一个孤立单引号 → unclosed '
    const r = lintPatch(`"a"b'`);
    assert.equal(r.ok, false);
  });

  it("rejects when `\\\\` at end of string leaves trailing backslash", () => {
    // `"abc\\` —— 在字符串内末尾的 \\ 会触发 "trailing backslash"
    const r = lintPatch(`"abc\\`);
    assert.equal(r.ok, false);
  });
});

describe("createFsEditTool", () => {
  it("rejects patch that fails lint — file content is NOT modified", () => {
    const file = join(scratch, "a.ts");
    const original = "const x = 1;\n";
    writeFileSync(file, original, "utf8");
    const tool = createFsEditTool(scratch);
    // new_str 缺右括号 — lint 必拒
    const broken = "const x = (1;";
    return Promise.resolve(
      tool.handler({ path: file, old_str: "const x = 1;", new_str: broken }),
    ).then(
      () => {
        throw new Error("expected lint rejection");
      },
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.ok((err as Error).message.startsWith("lint rejected:"));
        // 文件未被改动
        assert.equal(readFileSync(file, "utf8"), original);
      },
    );
  });

  it("rejects when old_str not found (0 occurrences)", () => {
    const file = join(scratch, "b.ts");
    writeFileSync(file, "hello world\n", "utf8");
    const tool = createFsEditTool(scratch);
    return Promise.resolve(
      tool.handler({ path: file, old_str: "missing", new_str: "ok" }),
    ).then(
      () => {
        throw new Error("expected not-found error");
      },
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.ok((err as Error).message.includes("old_str not found"));
      },
    );
  });

  it("rejects when old_str is ambiguous (>1 occurrences)", () => {
    const file = join(scratch, "c.ts");
    writeFileSync(file, "x = 1\nx = 1\n", "utf8");
    const tool = createFsEditTool(scratch);
    return Promise.resolve(
      tool.handler({ path: file, old_str: "x = 1", new_str: "x = 2" }),
    ).then(
      () => {
        throw new Error("expected ambiguous error");
      },
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.ok((err as Error).message.includes("ambiguous"));
      },
    );
  });

  it("successfully replaces single occurrence and returns absolute path", async () => {
    const file = join(scratch, "d.ts");
    writeFileSync(file, "const a = 1;\nconst b = 2;\n", "utf8");
    const tool = createFsEditTool(scratch);
    const result = (await tool.handler({
      path: file,
      old_str: "const a = 1;",
      new_str: "const a = 99;",
    })) as { path: string; replaced: number };
    assert.equal(result.replaced, 1);
    assert.ok(result.path.startsWith(scratch), `path should be absolute under root, got: ${result.path}`);
    assert.equal(
      readFileSync(file, "utf8"),
      "const a = 99;\nconst b = 2;\n",
    );
  });

  it("replaces with `$&` in new_str as literal — no String.replace expansion (Standards M1)", async () => {
    // 旧实现用 content.replace(old, new) 会把 `$&` 展开为 old_str 全文,
    // 静默损坏文件。新实现走 split-join,new_str 字面量原样写入。
    const file = join(scratch, "e.ts");
    writeFileSync(file, "FOO_BAR = 1;\n", "utf8");
    const tool = createFsEditTool(scratch);
    const result = (await tool.handler({
      path: file,
      old_str: "FOO_BAR = 1;",
      // new_str 包含 `$&` / `$1` / `$$` —— split-join 必须原样写入
      new_str: 'const x = "$& and $1 and $$";\n',
    })) as { path: string; replaced: number };
    assert.equal(result.replaced, 1);
    const after = readFileSync(file, "utf8");
    // 原文件以 \n 结尾,old_str 不含 \n,替换后 newline 仍保留;
    // split-join 把 new_str 字面量原样写入,$& 不被 String.replace 展开。
    assert.equal(
      after,
      'const x = "$& and $1 and $$";\n\n',
      `expected literal $& to be preserved; got: ${JSON.stringify(after)}`,
    );
    // 反向断言：$& 没被替换为 "FOO_BAR = 1;"(String.replace 会展开为全文)。
    assert.ok(!after.includes("FOO_BAR"));
  });

  it("rejects path that escapes root", () => {
    const tool = createFsEditTool(scratch);
    return Promise.resolve(
      tool.handler({
        path: join(scratch, "..", "outside.ts"),
        old_str: "x",
        new_str: "y",
      }),
    ).then(
      () => {
        throw new Error("expected escape error");
      },
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.ok((err as Error).message.includes("root"));
      },
    );
  });

  it("rejects missing file", () => {
    const tool = createFsEditTool(scratch);
    return Promise.resolve(
      tool.handler({
        path: join(scratch, "nope.ts"),
        old_str: "x",
        new_str: "y",
      }),
    ).then(
      () => {
        throw new Error("expected missing-file error");
      },
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
      },
    );
  });
});

describe("createShellExecTool (allowlist-first)", () => {
  it("rejects rm -rf / (not in allowlist)", async () => {
    const tool = createShellExecTool(scratch);
    try {
      await tool.handler({ command: "rm -rf /" });
      throw new Error("expected rejection");
    } catch (err) {
      assert.ok(err instanceof ToolExecutionError);
      assert.ok(
        (err as Error).message.includes("command not in allowlist"),
        `got: ${(err as Error).message}`,
      );
    }
  });

  it("rejects echo a > b (meta-char redirect)", async () => {
    const tool = createShellExecTool(scratch);
    try {
      await tool.handler({ command: "echo a > b" });
      throw new Error("expected rejection");
    } catch (err) {
      assert.ok(err instanceof ToolExecutionError);
      assert.ok((err as Error).message.includes("command not in allowlist"));
    }
  });

  it("rejects echo $PATH (variable expansion meta-char)", async () => {
    const tool = createShellExecTool(scratch);
    try {
      await tool.handler({ command: "echo $PATH" });
      throw new Error("expected rejection");
    } catch (err) {
      assert.ok(err instanceof ToolExecutionError);
      assert.ok((err as Error).message.includes("command not in allowlist"));
    }
  });

  it("rejects `rm -rf /` chained with `&& echo done` (rm not in allowlist)", async () => {
    const tool = createShellExecTool(scratch);
    try {
      await tool.handler({ command: "rm -rf / && echo done" });
      throw new Error("expected rejection");
    } catch (err) {
      assert.ok(err instanceof ToolExecutionError);
    }
  });

  it("executes safe command: echo hello, returns code 0 and stdout containing hello", async () => {
    const tool = createShellExecTool(scratch);
    const result = (await tool.handler({ command: "echo hello" })) as {
      code: number;
      stdout: string;
      stderr: string;
    };
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes("hello"), `stdout=${result.stdout}`);
  });

  it("executes node -v successfully", async () => {
    const tool = createShellExecTool(scratch);
    const result = (await tool.handler({ command: "node -v" })) as {
      code: number;
      stdout: string;
    };
    assert.equal(result.code, 0);
    assert.ok(result.stdout.length > 0);
  });

  it("rejects missing/empty command", async () => {
    const tool = createShellExecTool(scratch);
    try {
      await tool.handler({ command: "" });
      throw new Error("expected rejection");
    } catch (err) {
      assert.ok(err instanceof ToolExecutionError);
    }
  });

  it("rejects non-string command (object)", async () => {
    const tool = createShellExecTool(scratch);
    try {
      // 类型断言绕过 schema;handler 必须自保
      await tool.handler({ command: { evil: true } });
      throw new Error("expected rejection");
    } catch (err) {
      assert.ok(err instanceof ToolExecutionError);
    }
  });
});