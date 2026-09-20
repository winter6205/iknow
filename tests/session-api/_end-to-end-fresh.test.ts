/**
 * Fresh-conversation end-to-end: real SessionHub + real SessionStore
 * (temp dir), with chat-session /goal slash surfaces sharing one store and
 * conversationId.
 *
 * Complements `goal-slash-runtime.test.ts` (chat-session-only /goal units):
 * this is the integration where serve-form SessionHub and chat-form
 * processChatLine share the same persistence, covering:
 *
 * typed-error catch contract routing: legitimate `not_found` state
 * (fresh conversation + /goal status) vs real fault `schema_invalid`
 * (malformed session file + /goal status rendering
 * `${kind}: ${conversation_id}`). Real SessionStore + fresh conversationId
 * (no pre-stored session file), per the test.md command-handler integration
 * spec.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processChatLine } from "../../src/cli/chat-session.ts";
import {
  CURRENT_SCHEMA_VERSION,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import { makeCtx } from "../cli/_fixtures.ts";

const tempDirs: string[] = [];

async function storeFor(): Promise<{
  readonly store: SessionStore;
  readonly baseDir: string;
}> {
  const baseDir = await mkdtemp(join(tmpdir(), "iknow-end-to-end-fresh-"));
  tempDirs.push(baseDir);
  return { store: new SessionStore(baseDir, process.cwd()), baseDir };
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("typed-error catch 契约 (fresh conversation + 真实 SessionStore)", () => {
  it("not_found 合法态: 永未 create 的 conversationId + /goal status → output 友好, stderr 静默", async () => {
    const { store } = await storeFor();
    const id = "never-created-conversationId";
    // No createSession call → store.load(id) throws the not_found typed
    // error, which must be classified as a legitimate fresh-conversation
    // state, not a fault (test.md).
    const r = await processChatLine({
      line: "/goal status",
      ctx: makeCtx({
        responses: [],
        checkpointStore: store,
        stateOverrides: { conversationId: id },
      }),
    });
    expect(r.output).toContain("未设置 goal");
    expect(r.stderr).toBeUndefined();
    // Store stays empty: the load throw is caught, no side effects.
    expect(await store.list()).toEqual([]);
  });

  it("schema_invalid 真实故障: 畸形 session 文件 + /goal status → stderr `${kind}: ${conversation_id}`", async () => {
    const { store, baseDir } = await storeFor();
    const id = "schema-invalid-fresh";
    const dir = resolveConversationDir({
      projectDir: resolveProjectSessionDir(baseDir, process.cwd()),
      conversationId: id,
    });
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    // Malformed goal: text is a number → isValidGoal false → sanitize throws
    // the schema_invalid typed error → render contract
    // `${kind}: ${conversation_id}`.
    const bad: SessionFileV1 = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      messages: [],
      jsonMode: false,
      turnCount: 0,
      updatedAt: now,
      title: "",
      cwd: process.cwd(),
      sanitized_at: now,
      checkpoints: [],
      // Deliberately malformed: goal.text must be a string; number here.
      goal: { text: 123 } as unknown as SessionFileV1["goal"],
    };
    await writeFile(join(dir, `${id}.json`), JSON.stringify(bad), "utf8");
    const r = await processChatLine({
      line: "/goal status",
      ctx: makeCtx({
        responses: [],
        checkpointStore: store,
        stateOverrides: { conversationId: id },
      }),
    });
    expect(r.output).toBe("");
    expect(r.stderr).toBe(`schema_invalid: ${id}`);
  });
});
