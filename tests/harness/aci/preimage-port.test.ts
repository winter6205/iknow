/**
 * T1 (ADR-0036 / Gate B): the harness-owned capturePreimageBeforeWrite seam.
 * Pure unit — verifies the port is fired with the correctly-derived payload and
 * that a throwing port propagates (so the write tool can abort). Pins:
 *   - opts with no preimageCapture → no-op (never touches the callback path)
 *   - relPath derived as relative(rootAtCall, absPath)
 *   - rootIdentity falls back to rootAtCall; opts.rootIdentity wins when present
 *   - preBytes/postBytes are Buffers equal to the input strings
 *   - toolUseId / conversationId forwarded from the call arg
 *   - a throwing port propagates (write must abort)
 * The harness must NOT import session-api (Gate B): this file imports only the
 * port module, exercising the seam with a hand-written capture spy.
 */
import assert from "node:assert/strict";
import { relative } from "node:path";
import { describe, it } from "vitest";

import { capturePreimageBeforeWrite } from "../../../src/harness/aci/preimage-port.ts";
import type { PreimageCaptureInput } from "../../../src/harness/aci/preimage-port.ts";

describe("capturePreimageBeforeWrite", () => {
  it("(a) opts 无 preimageCapture → no-op, 不抛 (无端口可调)", async () => {
    // 端口缺席时 helper 必须原样 resolve, 不制造任何失败面。
    // 有 call/bytes 但 opts 里没有 preimageCapture:
    await capturePreimageBeforeWrite(
      { rootIdentity: "/id" },
      { toolUseId: "t", conversationId: "c" },
      "/root",
      "/root/a.ts",
      "old",
      "new"
    );
    // opts 整体 undefined 同样 no-op
    await capturePreimageBeforeWrite(
      undefined,
      undefined,
      "/root",
      "/root/a.ts",
      "o",
      "n"
    );
  });

  it("(b/c) 端口收到正确 relPath/rootIdentity/preBytes/postBytes + 转发的 ids", async () => {
    const seen: PreimageCaptureInput[] = [];
    const capture = (inp: PreimageCaptureInput) => {
      seen.push(inp);
    };
    const rootAtCall = "/root";
    const absPath = "/root/src/deep/a.ts";

    await capturePreimageBeforeWrite(
      { preimageCapture: capture },
      { toolUseId: "tool-42", conversationId: "conv-7" },
      rootAtCall,
      absPath,
      "OLD BYTES",
      "NEW BYTES"
    );

    assert.equal(seen.length, 1);
    const inp = seen[0]!;
    assert.equal(inp.relPath, relative(rootAtCall, absPath));
    assert.equal(inp.relPath, "src/deep/a.ts");
    // opts.rootIdentity 缺席 → 回退到 rootAtCall
    assert.equal(inp.rootIdentity, rootAtCall);
    assert.ok(Buffer.isBuffer(inp.preBytes));
    assert.ok(Buffer.isBuffer(inp.postBytes));
    assert.equal(inp.preBytes.toString("utf8"), "OLD BYTES");
    assert.equal(inp.postBytes.toString("utf8"), "NEW BYTES");
    // ids 从 call 转发
    assert.equal(inp.toolUseId, "tool-42");
    assert.equal(inp.conversationId, "conv-7");
  });

  it("(b2) opts.rootIdentity 存在时优先于 rootAtCall", async () => {
    let captured: PreimageCaptureInput | undefined;
    await capturePreimageBeforeWrite(
      {
        preimageCapture: (i) => {
          captured = i;
        },
        rootIdentity: "/canonical/id",
      },
      {},
      "/live/root",
      "/live/root/x.ts",
      "",
      ""
    );
    assert.equal(captured?.rootIdentity, "/canonical/id");
    // relPath 仍相对 rootAtCall 计算, 不受 rootIdentity 影响
    assert.equal(captured?.relPath, "x.ts");
  });

  it("call undefined → toolUseId/conversationId 为 undefined, 仍调用端口", async () => {
    let captured: PreimageCaptureInput | undefined;
    await capturePreimageBeforeWrite(
      {
        preimageCapture: (i) => {
          captured = i;
        },
      },
      undefined,
      "/root",
      "/root/f.ts",
      "p",
      "q"
    );
    assert.equal(captured?.toolUseId, undefined);
    assert.equal(captured?.conversationId, undefined);
    assert.equal(captured?.relPath, "f.ts");
  });

  it("(c) 抛出的端口 → 从 helper 传播 (写工具须据此 abort)", async () => {
    const boom = new Error("capture exploded");
    await assert.rejects(
      () =>
        capturePreimageBeforeWrite(
          {
            preimageCapture: async () => {
              throw boom;
            },
          },
          { toolUseId: "t", conversationId: "c" },
          "/root",
          "/root/a.ts",
          "o",
          "n"
        ),
      /capture exploded/
    );
  });
});
