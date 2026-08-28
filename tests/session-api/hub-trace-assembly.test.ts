import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockState = vi.hoisted(() => ({
  diagnosticsDir: undefined as string | undefined,
}));

vi.mock("../../src/harness/build-engine.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/harness/build-engine.ts")
    >();
  return {
    ...actual,
    buildHarnessEngine: vi.fn(async (opts) => {
      mockState.diagnosticsDir = opts.subagentDiagnosticsDir;
      return {
        deps: (await import("../cli/_fixtures.ts")).makeDeps([]),
        engine: {} as never,
      };
    }),
  };
});

import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";

let baseDir: string | undefined;

afterEach(async () => {
  if (baseDir !== undefined) {
    await rm(baseDir, { recursive: true, force: true });
    baseDir = undefined;
  }
  mockState.diagnosticsDir = undefined;
});

describe("SessionHub — subagent diagnostics assembly", () => {
  it("passes traceOut to the production subagent manager diagnosticsDir", async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-trace-assembly-"));
    const traceOut = join(baseDir, "trace");
    const root = baseDir;

    const hub = new SessionHub({
      store: new SessionStore(join(baseDir, "sessions")),
      askUser: createNoAskUser(),
      surface: "serve",
      traceOut,
    });
    await hub.bindWorkspace(root);
    const created = await hub.createSession();

    await hub.postMessage({
      conversationId: created.session.conversation_id,
      text: "hello",
    });

    expect(mockState.diagnosticsDir).toBe(traceOut);
    assert.ok(mockState.diagnosticsDir);
  });
});
