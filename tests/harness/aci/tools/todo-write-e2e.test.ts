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
 * 隔离：mkdtemp todoDir；tests 不共享 fs 状态。
 */
import { afterAll, describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAciRegistry } from "../../../../src/harness/aci/aci-registry.ts";
import { createAciExecutor } from "../../../../src/harness/aci/aci-executor.ts";
import { createExecutor } from "../../../../src/harness/tools/executor.ts";
import { createNoAskUser } from "../../../../src/harness/permission/ask-user.ts";
import { createPermissionPolicy } from "../../../../src/harness/permission/policy.ts";
import { createTodoWriteTool } from "../../../../src/harness/aci/tools/todo-write.ts";

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
