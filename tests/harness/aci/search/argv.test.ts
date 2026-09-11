/**
 * rg argv 构造 + 语言类型词表单测（SC12「argv 构造」；契约 D4；SC10）。
 *
 * 锁的不变式：
 *   - 三种出法各自的 argv 形状（paths → `-l`；count → `--count`；
 *     content → `--line-number`）。
 *   - `--null` 常开（路径分隔符由 NUL 承担，见 rg-output.ts）。
 *   - `context` 只在 content 出法转成 `-C N`；`paths` / `count` 不带。
 *   - `glob` / `type` 与 `path` 并列生效（D4）。
 *   - 未知 `type` 是 typed 错误，且**文案与坏正则不同**（SC10）。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
  buildRgArgs,
  resolveTypeName,
  KNOWN_TYPE_SAMPLE,
} from "../../../../src/harness/aci/search/argv.ts";
import { compilePattern } from "../../../../src/harness/aci/search/pattern.ts";
import type { QuerySpec } from "../../../../src/harness/aci/search/types.ts";

function spec(overrides: Partial<QuerySpec> = {}): QuerySpec {
  return {
    pattern: "hit",
    withinLines: 5,
    ignoreCase: false,
    output: "paths",
    context: 0,
    offset: 0,
    headLimit: 50,
    ...overrides,
  };
}

/** 搜索路径按生产口径喂**相对**形态（cwd = workspace 根，见 rg-engine）。 */
function argv(specOverrides: Partial<QuerySpec> = {}): string[] {
  return buildRgArgs(spec(specOverrides), ".", 2000);
}

describe("buildRgArgs — 出法", () => {
  it("paths → -l（每个唯一文件一条）", () => {
    assert.deepEqual(argv({ output: "paths" }), [
      "-l",
      "--engine=auto",
      "--null",
      "--color",
      "never",
      "--no-messages",
      "-H",
      "--",
      "hit",
      ".",
    ]);
  });

  it("count → --count", () => {
    assert.deepEqual(argv({ output: "count" }), [
      "--count",
      "--engine=auto",
      "--null",
      "--color",
      "never",
      "--no-messages",
      "-H",
      "--",
      "hit",
      ".",
    ]);
  });

  it("`--engine=auto` 常开：rg 的接受集与 Node 引擎的 JS RegExp 对齐", () => {
    // 默认的 Rust 引擎不支持 look-around / backreference，JS RegExp 支持；
    // 不带 auto，`(?=hit)` 会在 rg 路径 rc=2 失败、在 Node 路径正常命中 ——
    // 同一 pattern 的含义取决于哪条引擎在跑（D6 禁止）。auto 只在模式需要
    // 时才切 PCRE2，普通模式仍走默认引擎（零开销）。
    for (const output of ["content", "paths", "count"] as const) {
      assert.ok(argv({ output }).includes("--engine=auto"));
    }
  });

  it("`-H` 常开：path 指向单文件时 rg 不再省掉文件名（两种引擎同形状）", () => {
    assert.ok(argv({ output: "content" }).includes("-H"));
    assert.ok(argv({ output: "paths" }).includes("-H"));
    assert.ok(argv({ output: "count" }).includes("-H"));
  });

  it("`--no-messages` 常开：文件级告警不升成整次查询失败", () => {
    // 不可读的邻居文件让 rg 以 rc=2 收尾；没有这道开关，stderr 会被当成
    // 「查询被拒」而整次抛错，而 Node 引擎只是跳过该文件（SC9）。
    for (const output of ["content", "paths", "count"] as const) {
      assert.ok(argv({ output }).includes("--no-messages"));
    }
  });

  it("content → --line-number --no-heading + 超长行两道闸", () => {
    const args = argv({ output: "content" });

    assert.deepEqual(args.slice(0, 2), ["--line-number", "--no-heading"]);
    // 第一道闸交给 rg（否则整行 1MB 原样回传），第二道在投影层按 code point。
    assert.ok(args.includes("--max-columns=2000"));
    assert.ok(args.includes("--max-columns-preview"));
  });

  it("content + context>0 → -C N（对称上下文）", () => {
    const args = argv({ output: "content", context: 2 });

    assert.ok(args.includes("-C"));
    assert.equal(args[args.indexOf("-C") + 1], "2");
  });

  it("paths / count 即便 context 有值也不带 -C（出法裁剪）", () => {
    assert.equal(argv({ output: "paths", context: 3 }).includes("-C"), false);
    assert.equal(argv({ output: "count", context: 3 }).includes("-C"), false);
  });
});

describe("buildRgArgs — 收窄（D4）", () => {
  it("ignoreCase → --ignore-case", () => {
    assert.ok(argv({ ignoreCase: true }).includes("--ignore-case"));
    assert.equal(argv({ ignoreCase: false }).includes("--ignore-case"), false);
  });

  it("glob → --glob <pattern>", () => {
    const args = argv({ glob: "*.ts" });

    assert.equal(args[args.indexOf("--glob") + 1], "*.ts");
  });

  it("type → --type <name>", () => {
    const args = argv({ type: "ts" });

    assert.equal(args[args.indexOf("--type") + 1], "ts");
  });

  it("glob 与 type 并列时同时带上（D4 两者是并列维度）", () => {
    const args = argv({ glob: "src/**", type: "ts" });

    assert.equal(args[args.indexOf("--glob") + 1], "src/**");
    assert.equal(args[args.indexOf("--type") + 1], "ts");
  });

  it("pattern 与搜索路径始终以 `--` 收尾（pattern 以 - 开头不被当 flag）", () => {
    const args = argv({ pattern: "-weird" });

    assert.equal(args[args.length - 3], "--");
    assert.equal(args[args.length - 2], "-weird");
    assert.equal(args[args.length - 1], ".");
  });
});

describe("resolveTypeName — 未知 type（SC10）", () => {
  it("已知类型原样返回", () => {
    assert.equal(resolveTypeName("ts"), "ts");
    assert.equal(resolveTypeName("py"), "py");
  });

  it("未知类型 → typed 拒绝，文案点名 type 与类型名、且不含 pattern", () => {
    assert.throws(
      () => resolveTypeName("nosuchtype"),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /type/.test(error.message) &&
        /nosuchtype/.test(error.message) &&
        !/pattern/.test(error.message)
    );
  });

  it("坏正则与未知 type 是两种 typed 错误，文案互不包含对方关键词（SC10）", () => {
    const messageOf = (fn: () => unknown): string => {
      try {
        fn();
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    };
    // 两条都是**真实**编译器产物，不是手抄的期望串。
    const typeError = messageOf(() => resolveTypeName("nosuchtype"));
    const regexError = messageOf(() => compilePattern("(unclosed", false));

    assert.notEqual(typeError, "");
    assert.notEqual(regexError, "");
    // 不可混为「illegal regex」一种：各自关键词互不出现。
    assert.equal(
      /pattern/.test(typeError),
      false,
      `type error leaked pattern: ${typeError}`
    );
    assert.equal(
      /type/.test(regexError),
      false,
      `regex error leaked type: ${regexError}`
    );
    // 且各自都必须点名自己的失败域。
    assert.ok(/type/.test(typeError));
    assert.ok(/pattern/.test(regexError));
  });

  it("KNOWN_TYPE_SAMPLE 覆盖常用语言且不含空串", () => {
    for (const name of ["ts", "js", "py", "rust", "go", "md", "json"]) {
      assert.ok(KNOWN_TYPE_SAMPLE.includes(name), `${name} missing`);
    }
    assert.equal(KNOWN_TYPE_SAMPLE.includes(""), false);
  });
});
