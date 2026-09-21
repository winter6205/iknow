/**
 * /goal runtime integration tests across the three entry points — real
 * SessionStore (temp dir) + fresh conversationId (no pre-existing session file).
 *
 * Per the project test rules (commands-handler integration tests must use a
 * real store + fresh conversationId), this covers the typed-error catch
 * contract: not_found on a fresh conversation is a legitimate state (not an
 * error — silent stderr + friendly output), split from real schema_invalid
 * failures in the catch (flat `instanceof Error` is forbidden).
 *
 * Covers:
 *  - happy path: fresh + pin → on disk goal.status="active" && goal.text=args
 *  - fresh + status → legitimate not_found → output 「未设置 goal」 ("no goal set"), stderr silent
 *  - fresh + clear → legitimate not_found → output 「无 goal 可清」 ("nothing to clear"), no side effects
 *  - legacy on-disk taskFocus (sanitize-dropped) + pinned goal → /goal status
 *    output must not leak the taskFocus section
 *  - real schema_invalid failure → stderr `${kind}: ${conversation_id}`
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
} from "../../src/session-api/store/index.ts";
import { ValidationError } from "../../src/shared/errors.ts";
import { makeCtx } from "./_fixtures.ts";

const tempDirs: string[] = [];
async function storeFor(): Promise<{ store: SessionStore; baseDir: string }> {
  const baseDir = await mkdtemp(join(tmpdir(), "iknow-goal-slash-"));
  tempDirs.push(baseDir);
  return { store: new SessionStore(baseDir, process.cwd()), baseDir };
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("/goal 三面 runtime（真实 SessionStore + fresh conversationId）", () => {
  it("happy path: fresh conversationId + pin → 落盘 goal.status=active && goal.text=args (user_pin)", async () => {
    const { store, baseDir } = await storeFor();
    const id = "fresh-pin";
    const ctx = makeCtx({
      responses: [],
      checkpointStore: store,
      stateOverrides: { conversationId: id },
    });
    ctx.workspaceRoot = baseDir;
    const r = await processChatLine({
      line: "/goal write a type checker",
      ctx,
    });
    expect(r.quit).toBe(false);
    expect(r.output).toBe("goal pinned: write a type checker");
    expect(r.stderr).toBeUndefined();
    const file = await store.load(id);
    expect(file.goal?.status).toBe("active");
    expect(file.goal?.source).toBe("user_pin");
    expect(file.goal?.text).toBe("write a type checker");
    expect(file.workspaceRoot).toBe(baseDir);
    expect(file.cwd).toBe(baseDir);
  });

  it("fresh + pin without workspaceRoot → refuse bootstrap with typed error", async () => {
    const { store } = await storeFor();
    const id = "fresh-pin-rootless";
    const ctx = makeCtx({
      responses: [],
      checkpointStore: store,
      stateOverrides: { conversationId: id },
    });
    await expect(
      processChatLine({ line: "/goal write a type checker", ctx })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await store.list()).toEqual([]);
  });

  it("fresh + status → not_found 合法态:output「未设置 goal」,stderr 静默", async () => {
    const { store } = await storeFor();
    const id = "fresh-status";
    const ctx = makeCtx({
      responses: [],
      checkpointStore: store,
      stateOverrides: { conversationId: id },
    });
    const r = await processChatLine({ line: "/goal status", ctx });
    expect(r.quit).toBe(false);
    expect(r.stderr).toBeUndefined();
    expect(r.output).toContain("未设置 goal");
    expect(await store.list()).toEqual([]);
  });

  it("fresh + clear → not_found 合法态：output「无 goal 可清」，无副作用", async () => {
    const { store } = await storeFor();
    const id = "fresh-clear";
    const ctx = makeCtx({
      responses: [],
      checkpointStore: store,
      stateOverrides: { conversationId: id },
    });
    const r = await processChatLine({ line: "/goal clear", ctx });
    expect(r.quit).toBe(false);
    expect(r.stderr).toBeUndefined();
    expect(r.output).toContain("无 goal 可清");
    expect(await store.list()).toEqual([]);
  });

  it("typed-error 契约：schema_invalid 真实故障 → stderr `${kind}: ${conversation_id}`", async () => {
    const { store, baseDir } = await storeFor();
    const id = "schema-invalid";
    const dir = resolveConversationDir({
      projectDir: resolveProjectSessionDir(baseDir, process.cwd()),
      conversationId: id,
    });
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    // Malformed goal: text is a number → isValidGoal false → sanitize throws schema_invalid.
    const bad = {
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
      goal: { text: 123 },
    };
    await writeFile(join(dir, `${id}.json`), JSON.stringify(bad), "utf8");
    const ctx = makeCtx({
      responses: [],
      checkpointStore: store,
      stateOverrides: { conversationId: id },
    });
    const r = await processChatLine({ line: "/goal status", ctx });
    expect(r.output).toBe("");
    expect(r.stderr).toBe(`schema_invalid: ${id}`);
  });

  it("pinned goal + legacy on-disk taskFocus → /goal status excludes taskFocus text", async () => {
    // Regression guard: a legacy on-disk taskFocus key is sanitize-dropped;
    // /goal status output must not leak the taskFocus section or its text.
    const { store, baseDir } = await storeFor();
    const id = "pinned-with-legacy-taskfocus";
    const dir = resolveConversationDir({
      projectDir: resolveProjectSessionDir(baseDir, process.cwd()),
      conversationId: id,
    });
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const file = {
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
      goal: {
        text: "pinned-goal-text",
        source: "user_pin",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      taskFocus: {
        text: "stale-focused-task-text",
        updatedAt: now,
      },
    };
    await writeFile(join(dir, `${id}.json`), JSON.stringify(file), "utf8");
    const ctx = makeCtx({
      responses: [],
      checkpointStore: store,
      stateOverrides: { conversationId: id },
    });
    const r = await processChatLine({ line: "/goal status", ctx });
    expect(r.quit).toBe(false);
    expect(r.output).toContain("pinned-goal-text");
    expect(r.output).not.toContain("stale-focused-task-text");
    expect(r.output).not.toContain("taskFocus");
  });
});
