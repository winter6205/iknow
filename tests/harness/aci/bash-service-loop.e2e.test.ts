/**
 * #503 T11 — bash-service-loop 闭环集成 e2e（两轨汇合点）。
 *
 * 全流程：
 *   1. bash({command: 起 http server, background: true, network: true}) 经
 *      permission-executor ask 批准 → manager.spawn 立即返 task_id
 *   2. handler 毫秒级返回 {task_id, log_path}（不阻塞、不占 tier）
 *   3. bash_output 轮询读到 server LISTENING 证据
 *   4. host 侧真实 client 连上 127.0.0.1:<port> 收到响应体
 *   5. bash_stop(task_id) → 端口释放：host client 再连失败（ECONNREFUSED）
 *   6. registry json 状态收敛 killed
 *
 * 物理事实：network:true 是闭环必要条件 —— 默认 fence(--unshare-net) 下
 * 沙箱有自己的 netns，host client 连不进沙箱 listener；network:true 共享宿主
 * netns，沙箱内起的 http server 绑 127.0.0.1:<port> 对 host 可见可连。
 *
 * 端口策略：先 host 侧 listen(0) 拿空闲高端口再关掉，沙箱内用该端口；竞态
 * 容忍 ~2s 连接重试。WSL2 出站丢弃只影响 outbound，不影响 loopback inbound。
 *
 * 沙箱内起服务用 node 单行 http server（沙箱里 /usr/bin 有 node；probe
 * 「node runs」证实 v22）—— 比 nc 循环稳：node 进程自然保持 event loop。
 *
 * Permission 形态：bash network:true 在 policy 层强制 ask，full_auto 不豁免
 * （T10 + ADR-0022）。permission ask 本身由 tests/harness/permission/
 * bash-network-ask.test.ts 覆盖。本期 e2e 聚焦「批准后闭环」，askUser 注入
 * always-true + assert ask ctx 含 [请求宿主网络] +  network:true 字段透传。
 *
 * fresh workspaceRoot（test.md 命令 handler 契约）：mkdtemp temp dir，不预存
 * session/tasks 文件。fresh conversationId：ctx.conversationId 透传 spawn，
 * bash_output / bash_stop 用同 conversationId 过 scope 过滤。
 *
 * 收尾 afterEach：manager.shutdown() + temp dir 清理，保证无泄漏进程
 * （AI 易错点：测试服务器必须停干净）。
 */

import assert from "node:assert/strict";
import { createServer as createHttpServer, get as httpGet } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
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

// ── Registry 适配器(本地 mini 版,镜像 bash-network-ask.test.ts) ────────────────
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

// ── 端口 + 连接辅助 ───────────────────────────────────────────────────────────

async function getFreePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function canConnect(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ host: "127.0.0.1", port });
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

async function httpGetBody(
  port: number,
  path: string,
  timeoutMs = 1_000
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    // 直接用 node:http 的 get(fetch 依赖 DNS 解析,fence 中 node 自带 http 更稳)。
    const r = httpGet({ host: "127.0.0.1", port, path }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    r.on("error", reject);
    r.setTimeout(timeoutMs, () => {
      r.destroy(new Error(`http timeout on ${port}${path}`));
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
    "起服务 → host 验证 → bash_stop 端口释放 + registry 状态收敛 killed",
    async () => {
      // 1) 准备:fresh workspaceRoot temp dir + fresh conversationId
      const tempRoot = await mkdtemp(join(tmpdir(), "iknow-svc-loop-"));
      lastTempDir = tempRoot;
      const conversationId = `conv-svc-${randomBytes(6).toString("hex")}`;

      // 2) 拿空闲端口(host listen(0) → 关闭,沙箱内复用该端口)
      const port = await getFreePort();

      // 3) 装配:manager + bash/bash_output/bash_stop 工具 + 审批 askUser
      const manager = createBackgroundTaskManager({
        tasksDir: resolveTasksDir(tempRoot),
        spawn: defaultBackgroundSpawn,
      });
      lastManager = manager;
      const bashTool = createBashTool(tempRoot, {
        backgroundManager: manager,
        workspaceRoot: tempRoot,
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

      // 4) 起服务:bash background:true + network:true → 沙箱内 node 起 http server
      const nodeCmd = `node -e 'const s=require("http").createServer((q,r)=>{r.end("iknow-svc-ok")});s.listen(${port},"127.0.0.1",()=>{console.log("listening on 127.0.0.1:${port}")})'`;
      const t0 = Date.now();
      const [spawnResult] = await executor.executeAll(
        [
          {
            id: "u1",
            name: "bash",
            input: {
              command: nodeCmd,
              background: true,
              network: true,
            },
          },
        ],
        undefined,
        undefined,
        conversationId
      );
      const elapsedMs = Date.now() - t0;

      // ask ctx 断言:network:true 强制 ask + summaryHint + ctx.network 透传
      // (T10 bash-network-ask.test.ts 锁定该形态;这里再断言一次以锁闭环)
      assert.equal(askCalls.length, 1);
      assert.equal(askCalls[0]?.network, true);
      assert.match(askCalls[0]?.summaryHint ?? "", /\[请求宿主网络\]/);

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

      // 5) bash_output 轮询读到 server LISTENING 证据(沙箱内 stdout → log)
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
          if (/listening on 127\.0\.0\.1:\d+/.test(out.text)) {
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

      // 6) host 侧真实 client 连上 127.0.0.1:<port> 收到响应体
      //    沙箱 fence 已经过 bwrap argv 形状(network:true 去 unshare-net),沙箱内
      //    http server 绑的是 host netns 的 127.0.0.1:port;host client 自然连得上。
      let bodySeen: string | null = null;
      const connectDeadline = Date.now() + 3_000;
      while (Date.now() < connectDeadline) {
        try {
          const body = await httpGetBody(port, "/");
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

      // 7) bash_stop(task_id) → 端口释放 + registry json 状态收敛
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

      // host client 再连应该失败(进程组已死 + 监听 socket 已释放)
      // 重试窗口 ~2s 容忍 SIGTERM→SIGKILL 升级与 OS socket 回收
      let portClosed = false;
      const closeDeadline = Date.now() + 3_000;
      while (Date.now() < closeDeadline) {
        if (!(await canConnect(port, 200))) {
          portClosed = true;
          break;
        }
        await sleep(50);
      }
      assert.ok(
        portClosed,
        `port ${port} should be released after bash_stop but still accepting connections`
      );

      // 8) registry json 状态收敛 killed(读 .iknow/tasks/<id>.json)
      // status flip 是 exit 事件驱动的异步 settle(manager.stop 毫秒级返回,
      // 不阻塞);端口释放可能先于 settle 的 writeFile 落盘完成 → 端口关闭后
      // 单次读 JSON 会拾到 spawn 时的 "running" 记录(full vitest 并发下偶发,
      // 单跑通过)。与上方端口轮询同型(3s 上限 / 50ms 间隔)等待收敛。
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
