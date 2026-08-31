import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import type { AciCatalog, AciToolDef } from "../../../src/harness/aci/types.ts";
import { createPermissionPolicy } from "../../../src/harness/permission/policy.ts";
import type { AskUser } from "../../../src/harness/permission/types.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";

describe("ACI permission gate — caller abort", () => {
  it("cancels a pending approval and ignores a late approval", async () => {
    let handlerCalls = 0;
    const tool: AciToolDef = Object.freeze({
      name: "edit_file",
      description: "test edit_file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      handler: async () => {
        handlerCalls += 1;
        return "must not execute";
      },
      aci: Object.freeze({
        category: "write" as const,
        isConcurrencySafe: false,
        interruptBehavior: "block" as const,
        timeoutTier: "default" as const,
      }),
    });
    const registry = createRegistry([tool]);
    const catalog: AciCatalog = Object.freeze({
      get: (name) => (name === tool.name ? tool : undefined),
      all: () => Object.freeze([tool]),
    });

    let resolvePromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      resolvePromptStarted = resolve;
    });
    let lateApprove!: () => void;
    let receivedSignal: AbortSignal | undefined;
    const askUser: AskUser = ({ signal }) => {
      receivedSignal = signal;
      return new Promise<boolean>((resolve) => {
        const promptTimeout = setTimeout(() => resolve(false), 10_000);
        promptTimeout.unref?.();
        const finish = (approved: boolean): void => {
          clearTimeout(promptTimeout);
          resolve(approved);
        };
        lateApprove = () => finish(true);
        signal?.addEventListener("abort", () => finish(false), { once: true });
        resolvePromptStarted();
      });
    };

    const controller = new AbortController();
    const aciExecutor = createAciExecutor({
      inner: createExecutor(registry),
      catalog,
      policy: createPermissionPolicy(),
      askUser,
    });
    const execution = aciExecutor.executeAll(
      [{ id: "u1", name: tool.name, input: { path: "x.ts" } }],
      controller.signal
    );

    await promptStarted;
    controller.abort();

    const results = await Promise.race([
      execution,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("permission ask did not cancel within 100ms")),
          100
        );
        timer.unref?.();
      }),
    ]);
    const result = results[0]!;
    assert.equal(receivedSignal, controller.signal);
    assert.equal(result.kind, "execution_failed");
    if (result.kind === "execution_failed") {
      assert.equal(result.message, "cancelled");
    }

    lateApprove();
    await Promise.resolve();
    assert.equal(handlerCalls, 0);
  });

  it("does not execute after an uncooperative AskUser approves late", async () => {
    let handlerCalls = 0;
    const tool: AciToolDef = Object.freeze({
      name: "edit_file",
      description: "test edit_file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      handler: async () => {
        handlerCalls += 1;
        return "must not execute";
      },
      aci: Object.freeze({
        category: "write" as const,
        isConcurrencySafe: false,
        interruptBehavior: "block" as const,
        timeoutTier: "default" as const,
      }),
    });
    const registry = createRegistry([tool]);
    const catalog: AciCatalog = Object.freeze({
      get: (name) => (name === tool.name ? tool : undefined),
      all: () => Object.freeze([tool]),
    });

    let resolvePromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      resolvePromptStarted = resolve;
    });
    let lateApprove!: () => void;
    const askUser: AskUser = async () => {
      resolvePromptStarted();
      return new Promise<boolean>((resolve) => {
        lateApprove = () => resolve(true);
      });
    };

    const controller = new AbortController();
    const aciExecutor = createAciExecutor({
      inner: createExecutor(registry),
      catalog,
      policy: createPermissionPolicy(),
      askUser,
    });
    const execution = aciExecutor.executeAll(
      [{ id: "u1", name: tool.name, input: { path: "x.ts" } }],
      controller.signal
    );

    await promptStarted;
    controller.abort();
    lateApprove();

    const result = (await execution)[0]!;
    assert.equal(handlerCalls, 0, "late approval must not reach the handler");
    assert.equal(result.kind, "execution_failed");
    if (result.kind === "execution_failed") {
      assert.equal(result.message, "cancelled");
    }
  });

  it("fails closed when AskUser throws without rejecting the ACI execution", async () => {
    let handlerCalls = 0;
    const tool: AciToolDef = Object.freeze({
      name: "edit_file",
      description: "test edit_file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      handler: async () => {
        handlerCalls += 1;
        return "must not execute";
      },
      aci: Object.freeze({
        category: "write" as const,
        isConcurrencySafe: false,
        interruptBehavior: "block" as const,
        timeoutTier: "default" as const,
      }),
    });
    const registry = createRegistry([tool]);
    const catalog: AciCatalog = Object.freeze({
      get: (name) => (name === tool.name ? tool : undefined),
      all: () => Object.freeze([tool]),
    });
    const aciExecutor = createAciExecutor({
      inner: createExecutor(registry),
      catalog,
      policy: createPermissionPolicy(),
      askUser: async () => {
        throw new Error("approval inlet failed");
      },
    });

    const results = await aciExecutor.executeAll([
      { id: "u1", name: tool.name, input: { path: "x.ts" } },
    ]);

    const result = results[0]!;
    assert.equal(result.kind, "execution_failed");
    if (result.kind === "execution_failed") {
      assert.ok(result.message.startsWith("[user_denied]"));
    }
    assert.equal(handlerCalls, 0);
  });
});
