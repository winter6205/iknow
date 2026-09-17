/**
 * #503 T11 — bash-service-loop 闭环集成 e2e（两轨汇合点）。
 *
 * 全流程：
 *   1. bash({command: 起 http server on unix socket, background: true}) 经
 *      permission-executor ask 批准 → manager.spawn 立即返 task_id
 *   2. handler 毫秒级返回 {task_id, log_path}（不阻塞、不占 tier）
 *   3. bash_output 轮询读到 server LISTENING 证据
 *   4. host 侧真实 client 经同一 unix socket 收到响应体
 *   5. bash_stop(task_id) → 监听资源释放：host client 再连失败
 *   6. registry json 状态收敛 killed
 *
 * 传输选型（ADR-0097：`--unshare-net` 恒在）：沙箱有独立 netns，TCP
 * loopback listener 只活在该 netns 内，host 侧既连不进也观测不到端口
 * 生命周期。unix domain socket 的可见性由**文件系统**决定、与 netns 正交，
 * 经 `--bind / /` 的同一条宿主路径两侧同物 —— 故本 e2e 用 UDS 保持
 * 「沙箱内服务对 host 真实可见 → bash_stop 后真实释放」闭环，且不依赖
 * 出网通路（egress 缝只承载出向 CONNECT，不承载 inbound 连接）。
 *
 * 端口策略：host 侧 mkdtemp 目录内的 socket 路径（UDS 无端口概念）；连接
 * 重试窗口容忍 ~2s 的进程启动 / 回收延迟。
 *
 * 沙箱内起服务用 node 单行 http server（沙箱里 /usr/bin 有 node；probe
 * 「node runs」证实 v22）—— 比 nc 循环稳：node 进程自然保持 event loop。
 *
 * Permission 形态：bash 的 category 默认 ask，askUser 注入 always-true 聚焦
 * 「批准后闭环」；hint 走 summarizeInput 的 JSON 形态。
 *
 * fresh workspaceRoot（test.md 命令 handler 契约）：mkdtemp temp dir，不预存
 * session/tasks 文件。fresh conversationId：ctx.conversationId 透传 spawn，
 * bash_output / bash_stop 用同 conversationId 过 scope 过滤。
 *
 * 收尾 afterEach：manager.shutdown() + temp dir 清理，保证无泄漏进程
 * （AI 易错点：测试服务器必须停干净）。
 */

import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "vitest";

import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { createBashOutputTool } from "../../../src/harness/aci/tools/bash-output.js";
import { createBashStopTool } from "../../../src/harness/aci/tools/bash-stop.js";
import { createPermissionExecutor } from "../../../src/harness/permission/permission-executor.js";
import { createPermissionPolicy } from "../../../src/harness/permission/policy.js";
import type { AskUser } from "../../../src/harness/permission/types.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";
import type {
  Executor,
  Registry,
  ToolCall,
  ToolDef,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.ts";
import {
  createBackgroundTaskManager,
  defaultBackgroundSpawn,
} from "../../../src/harness/background/manager.ts";
import type { BackgroundTaskManager } from "../../../src/harness/background/manager.ts";
import { resolveTasksDir } from "../../../src/harness/background/paths.ts";

// ── bwrap 守卫 ───────────────────────────────────────────────────────────────

function hasBwrap(): boolean {
  const probe = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

// ── Registry 适配器(本地 mini 版) ────────────────────────────────────────────
// 保留 aci 元数据 —— permission-executor 的 createAciCatalog 投影依赖
// def.aci；把 aci 丢掉会让 catalog 为空 → Step 0 直接 delegate inner,
// 绕过权限层(askUser 永不被调)。

function makeRegistry(defs: AciToolDef[]): Registry {
  const list: ToolDef[] = defs.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema as Record<string, unknown>,
    handler: d.handler,
    ...(d.aci ? { aci: d.aci } : {}),
  }));
  return Object.freeze({
    list: () => list,
    get: (name: string) => list.find((d) => d.name === name),
  });
}

// ── unix socket 连接 / HTTP 辅助 ─────────────────────────────────────────────

/** socket 可连接 = 监听进程活着（stale socket 文件 → ECONNREFUSED）。 */
function canConnectSocket(
  socketPath: string,
  timeoutMs = 500
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ path: socketPath });
    sock.setTimeout(timeoutMs);
    const settle = (ok: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => settle(true));
    sock.once("error", () => settle(false));
    sock.once("timeout", () => settle(false));
  });
}

function httpGetBodyOverSocket(
  socketPath: string,
  path: string,
  timeoutMs = 1_000
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const r = httpGet({ socketPath, path }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    r.on("error", reject);
    r.setTimeout(timeoutMs, () => {
      r.destroy(new Error(`http timeout on ${socketPath}${path}`));
    });
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── 收尾追踪(每 it 一个 manager + temp dir;afterEach 关停) ──────────────────

let lastManager: BackgroundTaskManager | undefined;
let lastTempDir: string | undefined;

afterEach(async () => {
  if (lastManager) {
    try {
      await lastManager.shutdown();
    } catch {
      /* shutdown best-effort */
    }
  }
  if (lastTempDir) {
    try {
      await rm(lastTempDir, { recursive: true, force: true });
    } catch {
      /* cleanup best-effort */
    }
  }
  lastManager = undefined;
  lastTempDir = undefined;
});

// ── 闭合 e2e ────────────────────────────────────────────────────────────────

describe("bash-service-loop closed loop e2e (#502 + #503)", () => {
  it.skipIf(!hasBwrap())(
    "起服务 → host 验证 → bash_stop 监听释放 + registry 状态收敛 killed",
    async () => {
      // 1) 准备:fresh workspaceRoot temp dir + fresh conversationId
      const tempRoot = await mkdtemp(join(tmpdir(), "iknow-svc-loop-"));
      lastTempDir = tempRoot;
      const conversationId = `conv-svc-${randomBytes(6).toString("hex")}`;
      // socket 落在同一 temp dir（host / 沙箱同路径；UDS 与 netns 正交）。
      const socketPath = join(tempRoot, "svc.sock");

      // 2) 装配:manager + bash/bash_output/bash_stop 工具 + 审批 askUser
      const manager = createBackgroundTaskManager({
        tasksDir: resolveTasksDir({
          dataDir: tempRoot,
          projectIdentityRoot: tempRoot,
        }),
        spawn: defaultBackgroundSpawn,
      });
      lastManager = manager;
      const bashTool = createBashTool(tempRoot, {
        backgroundManager: manager,
      });
      const bashOutputTool = createBashOutputTool({
        backgroundManager: manager,
      });
      const bashStopTool = createBashStopTool({ backgroundManager: manager });

      const askCalls: Array<Parameters<AskUser>[0]> = [];
      const askUser: AskUser = async (ctx) => {
        askCalls.push(ctx);
        return true; // 批准:聚焦批准后闭环
      };
      const inner: Executor = Object.freeze({
        executeAll: async (
          calls: ReadonlyArray<ToolCall>,
          signal,
          _timeoutMs,
          convId
        ): Promise<ReadonlyArray<ToolExecutionResult>> => {
          const call = calls[0]!;
          // Dispatch by call.name to the right handler — bash handler 校验
          // input.command 存在,bash_output/bash_stop 不带 command 字段,
          // 不能统一走 bash.handler。
          const toolByName: Record<string, AciToolDef> = {
            bash: bashTool,
            bash_output: bashOutputTool,
            bash_stop: bashStopTool,
          };
          const def = toolByName[call.name];
          if (!def) {
            throw new Error(`e2e inner: unknown tool ${call.name}`);
          }
          const payload = await def.handler(call.input, {
            ...(signal ? { signal } : {}),
            ...(convId ? { conversationId: convId } : {}),
          });
          const text =
            typeof payload === "string" ? payload : JSON.stringify(payload);
          return [
            {
              kind: "ok",
              toolUseId: call.id,
              payload: [{ type: "text", text }],
            },
          ];
        },
      });
      const executor = createPermissionExecutor({
        inner,
        registry: makeRegistry([bashTool, bashOutputTool, bashStopTool]),
        policy: createPermissionPolicy(),
        askUser,
      });

      // 3) 起服务:bash background:true → 沙箱内 node 在 host 可见路径上起 UDS http server
      const nodeCmd = `node -e 'const s=require("http").createServer((q,r)=>{r.end("iknow-svc-ok")});s.listen(${JSON.stringify(socketPath)},()=>{console.log("listening on ${socketPath}")})'`;
      const t0 = Date.now();
      const [spawnResult] = await executor.executeAll(
        [
          {
            id: "u1",
            name: "bash",
            input: {
              command: nodeCmd,
              background: true,
            },
          },
        ],
        undefined,
        undefined,
        conversationId
      );
      const elapsedMs = Date.now() - t0;

      // ask ctx 断言:bash 类别默认 ask,hint 走 summarizeInput 的 JSON 形态
      // —— 单条 summaryHint,无第二套网络批准轴标记。
      assert.equal(askCalls.length, 1);
      assert.equal(askCalls[0]?.tool, "bash");
      assert.match(askCalls[0]?.summaryHint ?? "", /^\{"command":/);
      assert.equal(
        (askCalls[0]?.summaryHint ?? "").includes("network-guard"),
        false
      );

      // handler 毫秒级返回 ok(不阻塞、不占 tier)
      assert.equal(spawnResult.kind, "ok");
      assert.ok(
        elapsedMs < 5_000,
        `background spawn should return in ms, got ${elapsedMs}ms`
      );
      const spawnPayload = JSON.parse(
        (spawnResult as Extract<ToolExecutionResult, { kind: "ok" }>)
          .payload[0]!.text
      ) as { task_id: string; log_path: string };
      assert.match(spawnPayload.task_id, /^bg-[0-9a-f]{12}$/);
      assert.ok(spawnPayload.log_path.endsWith(`${spawnPayload.task_id}.log`));
      const { task_id: taskId, log_path: logPath } = spawnPayload;

      // 4) bash_output 轮询读到 server LISTENING 证据(沙箱内 stdout → log)
      let listeningSeen = false;
      const outputDeadline = Date.now() + 5_000;
      while (Date.now() < outputDeadline) {
        const [outResult] = await executor.executeAll(
          [
            {
              id: "u2",
              name: "bash_output",
              input: { task_id: taskId, max_bytes: 4_096 },
            },
          ],
          undefined,
          undefined,
          conversationId
        );
        if (outResult.kind === "ok") {
          const out = JSON.parse(
            (outResult as Extract<ToolExecutionResult, { kind: "ok" }>)
              .payload[0]!.text
          ) as { text: string; status: string };
          if (out.text.includes(`listening on ${socketPath}`)) {
            listeningSeen = true;
            break;
          }
        }
        await sleep(50);
      }
      assert.ok(
        listeningSeen,
        `bash_output never showed listening evidence; log tail=${await safeTail(
          logPath
        )}`
      );

      // 5) host 侧真实 client 经同一 socket 收到响应体 —— 沙箱内进程持有
      //    的监听资源在宿主视角真实存在（UDS 可见性由文件系统承载）。
      let bodySeen: string | null = null;
      const connectDeadline = Date.now() + 3_000;
      while (Date.now() < connectDeadline) {
        try {
          const body = await httpGetBodyOverSocket(socketPath, "/");
          if (body === "iknow-svc-ok") {
            bodySeen = body;
            break;
          }
        } catch {
          /* retry */
        }
        await sleep(50);
      }
      assert.equal(bodySeen, "iknow-svc-ok");

      // 6) bash_stop(task_id) → 监听释放 + registry json 状态收敛
      const [stopResult] = await executor.executeAll(
        [{ id: "u3", name: "bash_stop", input: { task_id: taskId } }],
        undefined,
        undefined,
        conversationId
      );
      assert.equal(stopResult.kind, "ok");
      const stopPayload = JSON.parse(
        (stopResult as Extract<ToolExecutionResult, { kind: "ok" }>).payload[0]!
          .text
      ) as { task_id: string; status: string };
      assert.equal(stopPayload.task_id, taskId);
      assert.equal(stopPayload.status, "stopped");

      // host client 再连应该失败(进程组已死 → socket 不再 accept)
      // 重试窗口 ~2s 容忍 SIGTERM→SIGKILL 升级与 OS socket 回收
      let listenerReleased = false;
      const closeDeadline = Date.now() + 3_000;
      while (Date.now() < closeDeadline) {
        if (!(await canConnectSocket(socketPath, 200))) {
          listenerReleased = true;
          break;
        }
        await sleep(50);
      }
      assert.ok(
        listenerReleased,
        `socket ${socketPath} should be released after bash_stop but still accepting connections`
      );

      // 7) registry json 状态收敛 killed(读 <pool>/projects/<slug>/tasks/<id>.json)
      // status flip 是 exit 事件驱动的异步 settle(manager.stop 毫秒级返回,
      // 不阻塞);监听释放可能先于 settle 的 writeFile 落盘完成 → 监听关闭后
      // 单次读 JSON 会拾到 spawn 时的 "running" 记录(full vitest 并发下偶发,
      // 单跑通过)。与上方连接轮询同型(3s 上限 / 50ms 间隔)等待收敛。
      const jsonPath = logPath.replace(/\.log$/, ".json");
      let rec:
        | { status: string; task_id: string; conversation_id: string }
        | undefined;
      const regDeadline = Date.now() + 3_000;
      while (Date.now() < regDeadline) {
        try {
          rec = JSON.parse(await readFile(jsonPath, "utf8")) as typeof rec;
        } catch {
          rec = undefined;
        }
        if (rec && rec.status !== "running") break;
        await sleep(50);
      }
      assert.ok(rec, "registry json should exist and be parseable");
      assert.equal(rec.task_id, taskId);
      assert.equal(rec.conversation_id, conversationId);
      assert.equal(
        rec.status,
        "killed",
        `registry json status should converge to killed after stop; got ${rec.status}`
      );
    },
    25_000
  );
});

/** 日志尾部读 —— 当 bash_output 始终未显示 listening 时输出诊断。 */
async function safeTail(logPath: string): Promise<string> {
  try {
    const raw = await readFile(logPath, "utf8");
    return raw.slice(-512);
  } catch {
    return "(log missing)";
  }
}
