/**
 * todo_write end-to-end — real executor path + fresh todoDir (no pre-existing
 * todos.md), covering:
 *
 *   a. happy path: read / add / update all work, and the persisted todos.md has
 *      the right shape (`- [ ] [tN] item` / `- [x] [tN] item`)
 *   b. the typed-error catch rendering contract (code-quality.md): for a
 *      ToolExecutionError the executor renders a message with the
 *      `[todo_write]` prefix while keeping error.name ===
 *      "ToolExecutionError", strictly separating legal states (mode=read with
 *      missing file → "") from real faults (empty item / unknown-id update /
 *      >64KB). Schema failures (bad mode enum / non-object input) go through
 *      the AJV layer as validation_failed, distinguished from handler-layer
 *      ToolExecutionError execution_failed (dispatch by kind).
 *
 * `mode=replace` on the **real executor + real conversationId** path —
 * conversationId flows from `executeAll`'s 4th positional argument through the
 * permission runtime → inner executor → `ctx.conversationId` → handler, so the
 * ledger lands in the per-conversation directory
 * (`resolveConversationTodoPath`) rather than the shared root. Unit-level
 * direct `tool.handler(input, ctx)` calls bypass this assembly chain, hence the
 * separate pin here: if the chain breaks (conversationId lost), the ledger
 * silently reverts to the root todos.md while unit tests stay green.
 *
 * Isolation: mkdtemp todoDir; tests share no fs state.
 */
import { afterAll, describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createAciRegistry } from "../../../../src/harness/aci/aci-registry.ts";
import { createAciExecutor } from "../../../../src/harness/aci/aci-executor.ts";
import { createExecutor } from "../../../../src/harness/tools/executor.ts";
import { createNoAskUser } from "../../../../src/harness/permission/ask-user.ts";
import { createPermissionPolicy } from "../../../../src/harness/permission/policy.ts";
import {
  createTodoWriteTool,
  resolveConversationTodoPath,
} from "../../../../src/harness/aci/tools/todo-write.ts";

const tempDirs: string[] = [];

async function freshTodoDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iknow-todo-write-e2e-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** Extract the string text from an executor result payload (AJV content-block [{type,text}] shape). */
function readText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (
    Array.isArray(payload) &&
    payload.length > 0 &&
    typeof payload[0] === "object" &&
    payload[0] !== null &&
    "text" in payload[0]
  ) {
    return String((payload[0] as { text: unknown }).text);
  }
  return "";
}

/**
 * Assemble a real single-tool todo_write executor: createAciRegistry single
 * factory → reg.inner frozen snapshot → createExecutor(reg.inner) →
 * createAciExecutor decoration (permission policy included; default write
 * category → ask → todo_write read mode bypasses ask via the code-built-in
 * rule; add/update never triggers ask in these happy paths).
 */
function buildE2EHarness(todoDir: string): {
  readonly exec: ReturnType<typeof createAciExecutor>;
} {
  const reg = createAciRegistry([createTodoWriteTool({ todoDir })]);
  const innerExec = createExecutor(reg.inner);
  const exec = createAciExecutor({
    inner: innerExec,
    catalog: reg.catalog,
    policy: createPermissionPolicy(),
    askUser: createNoAskUser(),
  });
  return { exec };
}

describe("todo_write 端到端 (T7): 真实 executor + fresh todoDir", () => {
  it("read mode 缺文件 → ok + empty string（fresh conversation 合法态）", async () => {
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);
    const [result] = await exec.executeAll([
      { id: "t7-list-empty", name: "todo_write", input: { mode: "read" } },
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      // Legal state: missing file → empty string (typed-error catch contract: legal ≠ fault)
      expect(readText(result.payload)).toBe("");
    }
  });

  it("add mode → todos.md 落盘 `- [ ] [t1] <item>` + receipt 含新 id", async () => {
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);
    const [addResult] = await exec.executeAll([
      {
        id: "t7-add-1",
        name: "todo_write",
        input: { mode: "add", item: "ship T7" },
      },
    ]);
    expect(addResult.kind).toBe("ok");
    if (addResult.kind === "ok") {
      // The receipt names the new id.
      expect(readText(addResult.payload)).toBe("Added 1 item: t1");
    }

    // File on disk is correct
    const onDisk = await readFile(join(todoDir, "todos.md"), "utf8");
    expect(onDisk).toBe("- [ ] [t1] ship T7\n");

    // read mode reads back → same content
    const [listResult] = await exec.executeAll([
      { id: "t7-list-1", name: "todo_write", input: { mode: "read" } },
    ]);
    expect(listResult.kind).toBe("ok");
    if (listResult.kind === "ok") {
      expect(readText(listResult.payload)).toBe("- [ ] [t1] ship T7\n");
    }
  });

  it("update mode (status=completed) → 把该 id 的行翻为 `- [x] [tN] <item>`", async () => {
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);

    // First add one item
    await exec.executeAll([
      {
        id: "t7-check-add",
        name: "todo_write",
        input: { mode: "add", item: "first task" },
      },
    ]);

    // update status=completed → flips to closed (id comes from the add receipt)
    const [checkResult] = await exec.executeAll([
      {
        id: "t7-check-1",
        name: "todo_write",
        input: { mode: "update", id: "t1", status: "completed" },
      },
    ]);
    expect(checkResult.kind).toBe("ok");
    if (checkResult.kind === "ok") {
      expect(readText(checkResult.payload)).toBe(
        "Updated t1: status=completed"
      );
    }

    // File on disk is correct
    const onDisk = await readFile(join(todoDir, "todos.md"), "utf8");
    expect(onDisk).toBe("- [x] [t1] first task\n");
  });

  it("happy 混合: add × 2 + update first + read → 全 ok + 落盘正确", async () => {
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);
    const results = await exec.executeAll([
      {
        id: "t7-mix-1",
        name: "todo_write",
        input: { mode: "add", item: "first" },
      },
      {
        id: "t7-mix-2",
        name: "todo_write",
        input: { mode: "add", item: "second" },
      },
      {
        id: "t7-mix-3",
        name: "todo_write",
        input: { mode: "update", id: "t1", status: "completed" },
      },
      { id: "t7-mix-4", name: "todo_write", input: { mode: "read" } },
    ]);
    // All ok
    for (const r of results) {
      expect(r.kind).toBe("ok");
    }
    const finalContent = await readFile(join(todoDir, "todos.md"), "utf8");
    expect(finalContent).toBe("- [x] [t1] first\n- [ ] [t2] second\n");
  });

  it("schema validation 失败: invalid mode → validation_failed (AJV 层先于 handler 拒绝)", async () => {
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);
    const [result] = await exec.executeAll([
      { id: "t7-bad-mode", name: "todo_write", input: { mode: "bogus" } },
    ]);
    // typed-error catch contract: a schema failure ≠ handler ToolExecutionError;
    // it goes through the AJV validation_failed kind (inner executor).
    expect(result.kind).toBe("validation_failed");
    if (result.kind === "validation_failed") {
      // The message carries AJV's error description (no `[todo_write]` prefix
      // guaranteed — the AJV layer omits the tool prefix; only handler-layer
      // ToolExecutionError carries it). Recorded dispatch:
      //   - validation_failed → AJV layer (no [todo_write] prefix)
      //   - execution_failed  → handler-layer ToolExecutionError ([todo_write] prefix)
      expect(result.message).toBeDefined();
    }
  });

  it("typed-error: add 缺 item (空串) → execution_failed + `[todo_write]` 前缀", async () => {
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);
    // item: "" passes the schema (type: string) but the handler rejects it (non-empty check)
    const [result] = await exec.executeAll([
      {
        id: "t7-no-item",
        name: "todo_write",
        input: { mode: "add", item: "" },
      },
    ]);
    expect(result.kind).toBe("execution_failed");
    if (result.kind === "execution_failed") {
      // typed-error catch rendering contract: message carries the [todo_write] prefix + description
      expect(result.message).toMatch(/^\[todo_write\]/);
      expect(result.message).toContain("non-empty");
    }
  });

  it("typed-error: update 未知 id → execution_failed + `[todo_write] unknown id` (SC8)", async () => {
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);
    const [result] = await exec.executeAll([
      {
        id: "t7-nomatch",
        name: "todo_write",
        input: { mode: "update", id: "t99", status: "completed" },
      },
    ]);
    expect(result.kind).toBe("execution_failed");
    if (result.kind === "execution_failed") {
      expect(result.message).toMatch(/^\[todo_write\]/);
      expect(result.message).toContain("unknown id");
      expect(result.message).toContain("t99");
    }
  });

  it("typed-error: 文件超 64KB → execution_failed + `file would exceed 65536 bytes`", async () => {
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);
    // First seed a file close to the cap (158 lines × ~414 bytes = 65304 bytes)
    const seedItem = "x".repeat(400);
    for (let i = 0; i < 158; i++) {
      await exec.executeAll([
        {
          id: `t7-seed-${i}`,
          name: "todo_write",
          input: { mode: "add", item: seedItem },
        },
      ]);
    }
    // Then add one more 400-char item → guaranteed over 64 KB
    const [result] = await exec.executeAll([
      {
        id: "t7-overflow",
        name: "todo_write",
        input: { mode: "add", item: seedItem },
      },
    ]);
    expect(result.kind).toBe("execution_failed");
    if (result.kind === "execution_failed") {
      expect(result.message).toMatch(/^\[todo_write\]/);
      expect(result.message).toContain("file would exceed 65536 bytes");
    }
  });
});

// ---------------------------------------------------------------------------
// replace on the real executor + real conversationId
//
// Difference from the replace cases in todo-write.test.ts (no duplication):
// there, unit-level direct `tool.handler(input, ctx)` calls bring their own
// ctx; here conversationId only enters as the positional argument of
// `executeAll(calls, signal, timeoutMs, conversationId)` and travels the
// assembly chain — permission runtime → inner executor synthesizes
// `ctx.conversationId`. So the invariant pinned here is "the assembly chain
// delivers conversationId to the replace branch": on a broken chain the ledger
// silently falls back to the shared-root todos.md, invisible to unit tests.
// ---------------------------------------------------------------------------

/** Snapshot file name inside the per-conversation directory (`todos.<unixMs>.<hex>.md`). */
async function listSnapshots(currentPath: string): Promise<string[]> {
  const entries = await readdir(dirname(currentPath));
  return entries.filter((n) => /^todos\.\d+\.[0-9a-f]{12}\.md$/.test(n));
}

describe("todo_write replace 端到端 (#903 SC6): 真实 executor + 真实 conversationId", () => {
  it("add × 2 → replace → 现行=新两行 + 同目录快照=旧全文 + list 只读新现行", async () => {
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);
    const conversationId = "conv-e2e-replace-happy";
    const currentPath = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId,
    });

    // Non-empty current ledger: two unchecked items, persisted via the real executor.
    const addResults = await exec.executeAll(
      [
        {
          id: "e2e-rep-add-1",
          name: "todo_write",
          input: { mode: "add", item: "old-step-1" },
        },
        {
          id: "e2e-rep-add-2",
          name: "todo_write",
          input: { mode: "add", item: "old-step-2" },
        },
      ],
      undefined,
      undefined,
      conversationId
    );
    for (const r of addResults) expect(r.kind).toBe("ok");

    // The ledger must land in the per-conversation directory — proving
    // conversationId really reached the handler (a broken chain would write the shared-root todos.md).
    const beforeReplace = await readFile(currentPath, "utf8");
    expect(beforeReplace).toBe(
      "- [ ] [t1] old-step-1\n- [ ] [t2] old-step-2\n"
    );
    expect(await listSnapshots(currentPath)).toHaveLength(0);

    // replace: swap the whole table.
    const [replaceResult] = await exec.executeAll(
      [
        {
          id: "e2e-rep-1",
          name: "todo_write",
          input: { mode: "replace", items: ["new-step-1", "new-step-2"] },
        },
      ],
      undefined,
      undefined,
      conversationId
    );
    expect(replaceResult.kind).toBe("ok");
    if (replaceResult.kind === "ok") {
      // Short receipt, same shape as add/update.
      expect(readText(replaceResult.payload)).toBe("Updated todos.md");
    }

    // The current ledger is exactly the two new unchecked items (ids renumbered from t1 — the whole table is new).
    expect(await readFile(currentPath, "utf8")).toBe(
      "- [ ] [t1] new-step-1\n- [ ] [t2] new-step-2\n"
    );

    // A snapshot is persisted with content === the pre-replace full ledger.
    const snapshots = await listSnapshots(currentPath);
    expect(snapshots).toHaveLength(1);
    expect(
      await readFile(join(dirname(currentPath), snapshots[0]), "utf8")
    ).toBe(beforeReplace);

    // read only shows the new current ledger, no snapshot bodies.
    const [listResult] = await exec.executeAll(
      [{ id: "e2e-rep-list", name: "todo_write", input: { mode: "read" } }],
      undefined,
      undefined,
      conversationId
    );
    expect(listResult.kind).toBe("ok");
    if (listResult.kind === "ok") {
      const listed = readText(listResult.payload);
      expect(listed).toBe("- [ ] [t1] new-step-1\n- [ ] [t2] new-step-2\n");
      expect(listed).not.toContain("old-step");
    }
  });

  it("replace 后 add/update 语义不变：新现行上继续 add + update 首个未勾项", async () => {
    // Regression: replace is not terminal — after the swap, add/update keep
    // working on the **new** current ledger and never touch the snapshot.
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);
    const conversationId = "conv-e2e-replace-then-addcheck";
    const currentPath = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId,
    });

    const results = await exec.executeAll(
      [
        {
          id: "e2e-ra-add-0",
          name: "todo_write",
          input: { mode: "add", item: "stale-plan" },
        },
        {
          id: "e2e-ra-replace",
          name: "todo_write",
          input: { mode: "replace", items: ["fresh-a", "fresh-b"] },
        },
        {
          id: "e2e-ra-add-1",
          name: "todo_write",
          input: { mode: "add", item: "fresh-c" },
        },
        {
          id: "e2e-ra-check",
          name: "todo_write",
          input: { mode: "update", id: "t1", status: "completed" },
        },
      ],
      undefined,
      undefined,
      conversationId
    );
    for (const r of results) expect(r.kind).toBe("ok");

    expect(await readFile(currentPath, "utf8")).toBe(
      "- [x] [t1] fresh-a\n- [ ] [t2] fresh-b\n- [ ] [t3] fresh-c\n"
    );
    // The snapshot stays the old full text from the replace moment; later add/update never write back into it.
    const snapshots = await listSnapshots(currentPath);
    expect(snapshots).toHaveLength(1);
    expect(
      await readFile(join(dirname(currentPath), snapshots[0]), "utf8")
    ).toBe("- [ ] [t1] stale-plan\n");
  });

  it("typed-error: replace 带 item 字段 → execution_failed + `[todo_write]` 前缀,现行不动", async () => {
    // The field-mutual-exclusion error renders as execution_failed through the
    // real executor (handler-layer typed error), not AJV validation_failed —
    // the schema tolerates item/items coexisting; only the handler knows the
    // per-mode exclusion.
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);
    const conversationId = "conv-e2e-replace-mixed-fields";
    const currentPath = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId,
    });

    await exec.executeAll(
      [
        {
          id: "e2e-rm-add",
          name: "todo_write",
          input: { mode: "add", item: "keep-me" },
        },
      ],
      undefined,
      undefined,
      conversationId
    );

    const [result] = await exec.executeAll(
      [
        {
          id: "e2e-rm-bad",
          name: "todo_write",
          input: { mode: "replace", items: ["x"], item: "y" },
        },
      ],
      undefined,
      undefined,
      conversationId
    );
    expect(result.kind).toBe("execution_failed");
    if (result.kind === "execution_failed") {
      expect(result.message).toMatch(/^\[todo_write\]/);
      expect(result.message).toContain("does not accept item");
    }

    // Failure leaves no half-write: current keeps the old content, no snapshot.
    expect(await readFile(currentPath, "utf8")).toBe("- [ ] [t1] keep-me\n");
    expect(await listSnapshots(currentPath)).toHaveLength(0);
  });
});
