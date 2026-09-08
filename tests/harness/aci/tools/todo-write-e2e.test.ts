/**
 * #440 T7: todo_write 端到端 — 真实 executor 路径 + fresh todoDir（不预存
 * todos.md 文件），覆盖：
 *
 *   a. happy path: list / add / check 三 mode 全跑通,todos.md 落盘内容
 *      形态正确（`- [ ] item` / `- [x] item` 形态持久化）
 *   b. typed-error catch 渲染契约（code-quality.md §typed-error catch 契约）：
 *      executor 对 ToolExecutionError 渲染 message 含 `[todo_write]` 前缀,
 *      保留 error.name === "ToolExecutionError" 区分,合法态（mode=list
 *      缺文件 → ""）与真实故障（empty item / no-match check / 超 64KB）
 *      严格分流。schema 校验失败（mode 枚举外 / 非对象 input）走 AJV 层
 *      validation_failed,与 handler 层 ToolExecutionError execution_failed
 *      区分（typed-error catch 契约:按 kind 分流）。
 *
 * #903 SC6: `mode=replace` 在**真实 executor + 真实 conversationId** 路径上
 * 跑通 —— conversationId 由 `executeAll` 第 4 个位置参数流经 permission
 * runtime → inner executor → `ctx.conversationId` → handler,账本落在
 * per-conversation 目录（`resolveConversationTodoPath`），而非共享根。unit 层
 * 直呼 `tool.handler(input, ctx)` 绕过了这条装配链,故此处单独钉住：装配链
 * 断了(conversationId 丢失)时账本会退回根 todos.md,unit 测试仍全绿。
 *
 * 隔离：mkdtemp todoDir；tests 不共享 fs 状态。
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

/** 从 executor result.payload 提取字符串文本（AJV 内容块 [{type,text}] 形态）。 */
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
 * 装配 todo_write 单工具真实 executor:createAciRegistry 单工厂 → reg.inner
 * 冻结快照 → createExecutor(reg.inner) → createAciExecutor 装饰层（含
 * permission policy,默认 write category → ask → todo_write list mode
 * bypass ask via code-built-in rule,add/check 在本 happy path 不触发）。
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
  it("list mode 缺文件 → ok + empty string（fresh conversation 合法态）", async () => {
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);
    const [result] = await exec.executeAll([
      { id: "t7-list-empty", name: "todo_write", input: { mode: "list" } },
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      // 合法态:文件不存在 → 空字符串(typed-error catch 契约:合法态 ≠ 故障)
      expect(readText(result.payload)).toBe("");
    }
  });

  it("add mode → todos.md 落盘 `- [ ] <item>` + 短 receipt `Updated todos.md`", async () => {
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
      expect(readText(addResult.payload)).toBe("Updated todos.md");
    }

    // 落盘文件正确
    const onDisk = await readFile(join(todoDir, "todos.md"), "utf8");
    expect(onDisk).toBe("- [ ] ship T7\n");

    // list mode 回读 → 同一内容
    const [listResult] = await exec.executeAll([
      { id: "t7-list-1", name: "todo_write", input: { mode: "list" } },
    ]);
    expect(listResult.kind).toBe("ok");
    if (listResult.kind === "ok") {
      expect(readText(listResult.payload)).toBe("- [ ] ship T7\n");
    }
  });

  it("check mode → 把首个 `- [ ] <item>` 翻为 `- [x] <item>`", async () => {
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);

    // 先 add 一条
    await exec.executeAll([
      {
        id: "t7-check-add",
        name: "todo_write",
        input: { mode: "add", item: "first task" },
      },
    ]);

    // check → 翻为 closed
    const [checkResult] = await exec.executeAll([
      {
        id: "t7-check-1",
        name: "todo_write",
        input: { mode: "check", item: "first task" },
      },
    ]);
    expect(checkResult.kind).toBe("ok");
    if (checkResult.kind === "ok") {
      expect(readText(checkResult.payload)).toBe("Updated todos.md");
    }

    // 落盘文件正确
    const onDisk = await readFile(join(todoDir, "todos.md"), "utf8");
    expect(onDisk).toBe("- [x] first task\n");
  });

  it("happy + failure 混合: add × 2 + check first + list → 全 ok + 落盘正确", async () => {
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
        input: { mode: "check", item: "first" },
      },
      { id: "t7-mix-4", name: "todo_write", input: { mode: "list" } },
    ]);
    // 全 ok
    for (const r of results) {
      expect(r.kind).toBe("ok");
    }
    const finalContent = await readFile(join(todoDir, "todos.md"), "utf8");
    expect(finalContent).toBe("- [x] first\n- [ ] second\n");
  });

  it("schema validation 失败: invalid mode → validation_failed (AJV 层先于 handler 拒绝)", async () => {
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);
    const [result] = await exec.executeAll([
      { id: "t7-bad-mode", name: "todo_write", input: { mode: "bogus" } },
    ]);
    // typed-error catch 契约: schema 校验失败 ≠ handler ToolExecutionError,
    // 走 AJV validation_failed kind(内层 executor)。
    expect(result.kind).toBe("validation_failed");
    if (result.kind === "validation_failed") {
      // 错误消息含 AJV 错误描述(不保证 [todo_write] 前缀 — AJV 层不带工具名前缀,
      // handler 层 ToolExecutionError 才带)。记录契约分流:
      //   - validation_failed → AJV 层(无 [todo_write] 前缀)
      //   - execution_failed → handler 层 ToolExecutionError([todo_write] 前缀)
      expect(result.message).toBeDefined();
    }
  });

  it("typed-error: add 缺 item (空串) → execution_failed + `[todo_write]` 前缀", async () => {
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);
    // item: "" 满足 schema (type:string) 但 handler 拒绝(非空校验)
    const [result] = await exec.executeAll([
      {
        id: "t7-no-item",
        name: "todo_write",
        input: { mode: "add", item: "" },
      },
    ]);
    expect(result.kind).toBe("execution_failed");
    if (result.kind === "execution_failed") {
      // typed-error catch 渲染契约:message 含 [todo_write] 前缀 + 描述
      expect(result.message).toMatch(/^\[todo_write\]/);
      expect(result.message).toContain("non-empty");
    }
  });

  it("typed-error: check no-match → execution_failed + `[todo_write] no open item matches`", async () => {
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);
    const [result] = await exec.executeAll([
      {
        id: "t7-nomatch",
        name: "todo_write",
        input: { mode: "check", item: "ghost" },
      },
    ]);
    expect(result.kind).toBe("execution_failed");
    if (result.kind === "execution_failed") {
      expect(result.message).toMatch(/^\[todo_write\]/);
      expect(result.message).toContain("no open item matches");
      expect(result.message).toContain("ghost");
    }
  });

  it("typed-error: 文件超 64KB → execution_failed + `file would exceed 65536 bytes`", async () => {
    const todoDir = await freshTodoDir();
    const { exec } = buildE2EHarness(todoDir);
    // 先 seed 一个接近上限的文件 (400-char items × 161 行 ≈ 65000 bytes)
    const seedItem = "x".repeat(400);
    for (let i = 0; i < 161; i++) {
      await exec.executeAll([
        {
          id: `t7-seed-${i}`,
          name: "todo_write",
          input: { mode: "add", item: seedItem },
        },
      ]);
    }
    // 再 add 一条 400-char item → 必超 64 KB
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
// #903 SC6: replace 走真实 executor + 真实 conversationId
//
// 与 todo-write.test.ts 的 replace 用例的区别（不重复）：unit 层直呼
// `tool.handler(input, ctx)` 自带 ctx；这里 conversationId 只作为
// `executeAll(calls, signal, timeoutMs, conversationId)` 的位置参数交给装配
// 链，由 permission runtime → inner executor 合成 `ctx.conversationId`。因此
// 本节钉住的不变式是「装配链把 conversationId 送到了 replace 分支」——
// 断链时账本静默退回共享根 todos.md，unit 层察觉不到。
// ---------------------------------------------------------------------------

/** per-conversation 目录下的快照文件名（`todos.<unixMs>.<hex>.md`）。 */
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

    // 现行非空：两条未勾项，经真实 executor 落盘。
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

    // 账本必须落在 per-conversation 目录 —— 证明 conversationId 真的流到了
    // handler（断链则会写共享根 todos.md）。
    const beforeReplace = await readFile(currentPath, "utf8");
    expect(beforeReplace).toBe("- [ ] old-step-1\n- [ ] old-step-2\n");
    expect(await listSnapshots(currentPath)).toHaveLength(0);

    // replace：整表换新。
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
      // D5 短回执，与 add/check 同形。
      expect(readText(replaceResult.payload)).toBe("Updated todos.md");
    }

    // 现行恰好是新两行未勾项。
    expect(await readFile(currentPath, "utf8")).toBe(
      "- [ ] new-step-1\n- [ ] new-step-2\n"
    );

    // 快照落盘且内容 === replace 之前的现行全文。
    const snapshots = await listSnapshots(currentPath);
    expect(snapshots).toHaveLength(1);
    expect(
      await readFile(join(dirname(currentPath), snapshots[0]), "utf8")
    ).toBe(beforeReplace);

    // list 只读新现行，不含快照正文。
    const [listResult] = await exec.executeAll(
      [{ id: "e2e-rep-list", name: "todo_write", input: { mode: "list" } }],
      undefined,
      undefined,
      conversationId
    );
    expect(listResult.kind).toBe("ok");
    if (listResult.kind === "ok") {
      const listed = readText(listResult.payload);
      expect(listed).toBe("- [ ] new-step-1\n- [ ] new-step-2\n");
      expect(listed).not.toContain("old-step");
    }
  });

  it("replace 后 add/check 语义不变：新现行上继续 add + check 首个未勾项", async () => {
    // SC6 回归：replace 不是终态 —— 换表之后 add/check 仍在**新**现行上工作，
    // 不会误碰快照。
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
          input: { mode: "check", item: "fresh-a" },
        },
      ],
      undefined,
      undefined,
      conversationId
    );
    for (const r of results) expect(r.kind).toBe("ok");

    expect(await readFile(currentPath, "utf8")).toBe(
      "- [x] fresh-a\n- [ ] fresh-b\n- [ ] fresh-c\n"
    );
    // 快照仍是 replace 当时的旧全文，后续 add/check 不回写快照。
    const snapshots = await listSnapshots(currentPath);
    expect(snapshots).toHaveLength(1);
    expect(
      await readFile(join(dirname(currentPath), snapshots[0]), "utf8")
    ).toBe("- [ ] stale-plan\n");
  });

  it("typed-error: replace 带 item 字段 → execution_failed + `[todo_write]` 前缀,现行不动", async () => {
    // 字段互斥错误经真实 executor 渲染为 execution_failed（handler 层 typed
    // error），不是 AJV validation_failed —— schema 允许 item/items 并存，
    // per-mode 互斥只有 handler 知道。
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

    // 失败不半写：现行保持旧内容，无快照。
    expect(await readFile(currentPath, "utf8")).toBe("- [ ] keep-me\n");
    expect(await listSnapshots(currentPath)).toHaveLength(0);
  });
});
