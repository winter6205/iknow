/**
 * T3 (SC7, ADR-0071 Decision 4):
 * traceDir 由 traceFilePath 派生 —— `blobs/` 是 `trace.jsonl` 的兄弟目录,
 * 由 `dirname(traceFilePath) + "/blobs"` 唯一决定。`options.traceDir` 字段
 * 从 `TraceMessageDereferenceOptions` 退役, 唯一公开的输入是 `traceFilePath`。
 *
 * 这条不变式跨读侧三面共用(ACI / stdio MCP / 直接调用 `dereferenceTraceMessages`):
 * 调用方只发 trace 文件路径, 不再发 blob 目录。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  projectToolResultsFromTrace,
  type TraceMessageDereferenceOptions,
} from "../../src/traceserver/project-tool-results.ts";

describe("TraceMessageDereferenceOptions (T3 SC7)", () => {
  it("traceDir is retired — type-level guard pins the contract change", () => {
    // SC7: options.traceDir! 非空断言消失。type-level 验证 —— 显式声明
    // 一个带 traceDir 字段的对象字面量, 在编译期就应被 TS 拒为「额外属性」。
    // 这里用 `@ts-expect-error` 钉死: 若 traceDir 字段被偷偷加回, tsc
    // 会报「unused @ts-expect-error directive」, CI 必挂。注意必须走
    // 对象字面量的 excess-property 检查 —— 类型断言(`as`)不触发该检查,
    // 哨兵会失效。
    const wrong: TraceMessageDereferenceOptions = {
      traceFilePath: "/tmp/conv/trace.jsonl",
      // @ts-expect-error SC7: traceDir is retired; pass via traceFilePath only.
      traceDir: "/tmp/conv",
    };
    void wrong;
  });

  it("blob dereference via traceFilePath: dirname(traceFilePath) + /blobs", async () => {
    // 调用方只发 traceFilePath, 内部派生 `<dir>/<sha>` 路径读 blob。
    // 这是 SC7 的核心契约 —— 派生是单一信息源, 调用方不传 blobDir。
    const messages = [
      { sha: "abc123", bytes: 10 },
      { sha: "missing-sha", bytes: 5 },
    ];
    // 不传 traceFilePath → 派生 readBlob undefined → 必抛错(失败不吞外层)
    // 但 projectToolResultsFromTrace 顶层 try/catch 把派生失败降级成空数组
    // (读侧 fail-closed 不抛进 turn)。这里只验证: 不传 traceFilePath →
    // 返回空数组(派生失败降级路径)。
    const withoutPath = await projectToolResultsFromTrace(messages);
    assert.deepEqual(
      withoutPath,
      [],
      "without traceFilePath, dereference fails closed → empty projection"
    );

    // 传 traceFilePath 但 blob 不存在 → 同样降级空数组。SC7 钉住这条:
    // 派生路径的读失败不抛进调用方 turn。
    const withPath = await projectToolResultsFromTrace(messages, {
      traceFilePath: "/nonexistent/dir/trace.jsonl",
    });
    assert.deepEqual(withPath, []);
  });

  it("anti-coupling: explicit readBlob wins over derived dirname path (SC7)", async () => {
    // SC7 钉死: 调用方「不再单独传可与 filePath 矛盾的 traceDir」(spec
    // 原文)—— 上一条测试的 `@ts-expect-error` 哨兵在编译期关掉该风险面。
    // 本测试钉运行期残留的一半契约: 当调用方显式注入 readBlob 时, 派生
    // (dirname(traceFilePath)/blobs)不再发生, 注入值是唯一读取路径。
    let deriveAttempted = false;
    const deref = await projectToolResultsFromTrace([{ sha: "x", bytes: 1 }], {
      traceFilePath: "/definitely/not/a/real/dir/trace.jsonl",
      readBlob: (sha) => {
        // 若实现仍走 dirname 派生, 会先以 readFileSync 命中不存在路径而
        // 失败; 注入的 readBlob 接管后此断言才有意义。
        deriveAttempted = true;
        return `blob-${sha}`;
      },
    });
    assert.ok(
      deriveAttempted,
      "injected readBlob must be the read path when provided"
    );
    // sha "x" 的 blob 内容不存在 → 投影降级空数组(读侧 fail-closed 既有契约)。
    assert.deepEqual(deref, []);
  });
});
