/**
 * T7 (#344) — MCP manager：连接生命周期 + 状态机 + registerExternal 接线。
 *
 * 围绕一个小抽象 `McpClientHandle`，把 `@modelcontextprotocol/client`
 * 的 `Client` + `StdioClientTransport` 包成可注入的协议形态。生产路径
 * 默认用 `createRealClient`（同文件末），单测用内存假 client，不启真 server。
 *
 * 状态机（per server）：
 *   pending → connected   connect + 首次 listTools 完成，registerExternal(defs)
 *   pending → failed      connect/listTools 抛错或超时（30s）
 *   pending → disabled    config.status === "disabled"，不建 client
 *   connected → failed    onclose 回调命中（不重连）
 *   connected → connected list_changed 触发增量重注册
 *
 * 并发语义（SC15 / SC16）：
 *   - list_changed：handler 在 in-flight callTool 期间到达 → 重注册仅追加
 *     新名字（同名跳过），但**不打断** callTool；callTool 通过 `signal`
 *     解除 await（manager 持有 AbortController）。
 *   - shutdown：取消 in-flight callTool 的 signal + 调 client.close +
 *     spawn 出来的 stdio 子进程 SIGTERM。in-flight 调用以 `abort` 错误
 *     终结（不会 resolve 成功，也不会悬挂）。
 *
 * 不用 schema-normalize：见 D1 探针结论 + spec 假设 9（ajv strict × MCP
 * inputSchema 三组形态全 PASS）。registerExternal 走 T1 已有的 ajv 实例。
 */
import {
  Client as SdkClient,
  type CallToolResult as SdkCallToolResult,
  type Tool as SdkTool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport as SdkStdioTransport } from "@modelcontextprotocol/client/stdio";
import type { AciToolDef } from "../aci/types.js";
import { toAciToolDef } from "./adapter.js";
import type { McpServerConfig, McpStdioServer } from "./config.js";

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** 每个 server 的状态机拍快照。 */
export type McpServerState = "pending" | "connected" | "failed" | "disabled";

export interface McpServerStatus {
  readonly name: string;
  readonly state: McpServerState;
  readonly source: McpServerConfig["source"];
  readonly error?: string;
}

/** 注册阶段一对 server + 工具。 */
export interface McpToolEntry {
  readonly server: string;
  readonly tool: SdkTool;
}

/** 调用一次的入参 + 返回。 */
export interface McpCallResult {
  readonly result: SdkCallToolResult;
}

/**
 * 抽象的 MCP client 句柄。让单测注入 stub，避免启动真子进程。
 *  - `connect()` → 建立到 server 的会话；
 *  - `listTools()` → 拉取工具清单；
 *  - `callTool(name, args, { timeout, signal, resetTimeoutOnProgress })`
 *  - `close()` → 关闭会话；
 *  - `onListChanged(tools)` → server 推送的工具变更；
 *  - `onClose()` → SDK 端连接关闭通知（用于触发 failed 不重连）。
 */
export interface McpClientHandle {
  readonly connect: () => Promise<void>;
  readonly listTools: () => Promise<readonly SdkTool[]>;
  readonly callTool: (
    name: string,
    args: unknown,
    options?: {
      readonly timeout?: number;
      readonly signal?: AbortSignal;
      readonly resetTimeoutOnProgress?: boolean;
    }
  ) => Promise<McpCallResult>;
  readonly close: () => Promise<void>;
  readonly onListChanged: (cb: (tools: readonly SdkTool[]) => void) => void;
  readonly onClose: (cb: () => void) => void;
}

export interface McpManagerOptions {
  /** T3 产物的两级合并 server 列表。 */
  readonly config: readonly McpServerConfig[];
  /** T1 的 registerExternal 缝，把 mcp__ 工具追加进 ACI registry。 */
  readonly registerExternal: (defs: readonly AciToolDef[]) => void;
  /**
   * reload 缝：按名撤回旧 slot 已注册的 mcp__* 工具。缺席时 reload
   * 静默跳过 unregister（stale 名会残留 externalByExt，重名 register
   * 触发 Gate2 duplicate —— 生产装配必须注入）。
   */
  readonly unregisterExternal?: (names: readonly string[]) => void;
  /**
   * 连接超时毫秒（spec 假设 9：30s）。测试可注入短超时。
   * 默认 30_000。
   */
  readonly timeoutMsOverride?: number;
  /** 工具调用超时（adapter 把 tier=long 映射到 30 min，这里给单测覆盖口）。 */
  readonly callTimeoutMsOverride?: number;
  /** 抽象 client 工厂；测试覆盖；生产 = `createRealClient`。 */
  readonly createClient?: (server: McpServerConfig) => McpClientHandle;
}

export interface McpManager {
  /** 后台化启动连接；早于 connect 完成返回。 */
  readonly start: () => Promise<void>;
  /**
   * 重载 server 集：收集旧 slots 已注册工具名 → unregisterExternal 撤回 →
   * shutdown 现有全部 → 清 slots → 用新 config 重建 → start()。
   * 幂等：未 start / 已 shutdown 也能调用。reload 返回前不阻塞在连接上
   * （内部 start() fire-and-forget，与既有 start 同语义）。
   */
  readonly reload: (config: readonly McpServerConfig[]) => Promise<void>;
  /** 关闭所有 client + 取消 in-flight + SIGTERM stdio 子孙。 */
  readonly shutdown: () => Promise<void>;
  /** 当前状态拍快照（按 name 字母序）。 */
  readonly status: () => readonly McpServerStatus[];
}

// ---------------------------------------------------------------------------
// 内部状态
// ---------------------------------------------------------------------------

interface Slot {
  readonly config: McpServerConfig;
  state: McpServerState;
  error?: string;
  handle?: McpClientHandle;
  /** shutdown 时 abort 所有在途 callTool。 */
  callAbort?: AbortController;
  /** 当前已注册工具的本地 mirror，用于 list_changed 增量 diff（不重复注册同名）。 */
  registered?: Set<string>;
  /** 后台 connect 任务引用，shutdown 时取消（abort 不会 cancel promise，仅作诊断）。 */
  bg?: Promise<void>;
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 1_800_000; // long 档（参见 aci/types.ts TIMEOUT_TIER_MS）

export function createMcpManager(opts: McpManagerOptions): McpManager {
  const timeoutMs = opts.timeoutMsOverride ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const callTimeoutMs = opts.callTimeoutMsOverride ?? DEFAULT_CALL_TIMEOUT_MS;

  /** 按 name 索引 slot。 */
  const slots = new Map<string, Slot>();

  /**
   * 按 config 重置 slots —— 构造器 + reload 共用（reload 先 await
   * shutdown 终结旧 slots，再调本函数清空 + 重建）。字母序保证
   * 测试稳定性。
   */
  function rebuildSlots(config: readonly McpServerConfig[]): void {
    slots.clear();
    for (const cfg of [...config].sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      slots.set(cfg.name, {
        config: cfg,
        state: cfg.status === "disabled" ? "disabled" : "pending",
      });
    }
  }

  rebuildSlots(opts.config);

  /** 把 slot 的工具列表通过 registerExternal 追加（增量 diff）。 */
  function registerTools(slot: Slot, tools: readonly SdkTool[]): void {
    const seen = slot.registered ?? new Set<string>();
    slot.registered = seen;
    const defs: AciToolDef[] = [];
    for (const t of tools) {
      const name = `mcp__${slot.config.name}__${sanitize(t.name)}`;
      if (seen.has(name)) continue;
      seen.add(name);
      defs.push(
        toAciToolDef({
          server: slot.config.name,
          tool: t,
          call: async (toolName, args, callOpts) => {
            const handle = slot.handle;
            if (!handle) {
              throw new Error(`MCP server ${slot.config.name} not connected`);
            }
            // 把 caller 的 signal + slot 的 shutdown signal 合并，
            // shutdown() 取消时在途 callTool 收到 abort（SC16）。
            const sig = mergeAbort(callOpts?.signal, slot.callAbort?.signal);
            const result = await handle.callTool(toolName, args, {
              timeout: callOpts?.timeout ?? callTimeoutMs,
              signal: sig,
              resetTimeoutOnProgress: callOpts?.resetTimeoutOnProgress ?? true,
            });
            return result.result;
          },
          timeoutMs: callTimeoutMs,
        })
      );
    }
    if (defs.length > 0) opts.registerExternal(defs);
  }

  /** 把 slot 标 failed + warn 一行。 */
  function markFailed(slot: Slot, reason: string): void {
    if (slot.state === "failed" || slot.state === "disabled") return;
    slot.state = "failed";
    // 如果 createRealClient 接管了子进程 stderr（stderr: "pipe"），失败时
    // 把缓冲尾段附进 error —— 便于排查 server 启动失败/协议异常根因。
    // stub client（manager.test.ts 用）无 _stderrTail，保持纯 reason。
    const tail = (
      slot.handle as unknown as { _stderrTail?: () => string } | undefined
    )?._stderrTail?.();
    slot.error =
      tail && tail.length > 0 ? `${reason}\n[server stderr]\n${tail}` : reason;
    console.warn(
      `[mcp/manager] server '${slot.config.name}' failed: ${slot.error}`
    );
  }

  /** 后台启动某一个 server。 */
  function bootSlot(slot: Slot): Promise<void> {
    const created = opts.createClient
      ? opts.createClient(slot.config)
      : createRealClient(slot.config);
    slot.handle = created;
    slot.callAbort = new AbortController();

    const timeoutHandle = setTimeout(() => {
      markFailed(slot, "connect timeout");
    }, timeoutMs);

    // 注册 onclose → failed（不重连）。list_changed → 增量重注册。
    created.onClose(() => {
      if (slot.state !== "connected") return;
      markFailed(slot, "connection closed by server");
    });
    created.onListChanged((tools) => {
      if (slot.state !== "connected") return;
      try {
        registerTools(slot, tools);
      } catch (err) {
        // 重注册冲突 → warn but 不破坏本 server；已注册的留任。
        console.warn(
          `[mcp/manager] server '${slot.config.name}' list_changed re-registration skipped: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    });

    return (async () => {
      try {
        await created.connect();
      } catch (err) {
        clearTimeout(timeoutHandle);
        markFailed(slot, err instanceof Error ? err.message : String(err));
        return;
      }
      // connect 期间可能已被超时器标 failed
      if (slot.state !== "pending") {
        clearTimeout(timeoutHandle);
        return;
      }
      try {
        const tools = await created.listTools();
        clearTimeout(timeoutHandle);
        if (slot.state !== "pending") return;
        registerTools(slot, tools);
        slot.state = "connected";
      } catch (err) {
        clearTimeout(timeoutHandle);
        markFailed(slot, err instanceof Error ? err.message : String(err));
      }
    })();
  }

  /**
   * 后台启动所有非 disabled slot。start / reload 共用。
   * 不 await —— 返回的 tasks 仅用于静默吞错，连接在后台完成（SC8）。
   */
  function bootstrapAll(): void {
    const tasks: Promise<void>[] = [];
    for (const slot of slots.values()) {
      if (slot.state === "disabled") continue;
      slot.bg = bootSlot(slot);
      tasks.push(slot.bg);
    }
    void Promise.allSettled(tasks);
  }

  async function start(): Promise<void> {
    bootstrapAll();
  }

  async function reload(config: readonly McpServerConfig[]): Promise<void> {
    // 先在 shutdown/rebuild 前抓旧 slots 已注册工具全名（mcp__<server>__<tool>）：
    // slot.registered 属于 slot，rebuildSlots 的 slots.clear() 会把它一并清掉，
    // 漏抓将导致外部 registry 残留 stale 名（重名 register 触发 Gate2 duplicate）。
    // disabled / 未连接过的 slot 无 registered，flat 后为空，unregister 幂等忽略。
    const oldNames: string[] = [];
    for (const slot of slots.values()) {
      if (slot.registered) oldNames.push(...slot.registered);
    }
    // shutdown 取消 in-flight + close + 标 failed —— 旧状态彻底终结后，撤回
    // 这些名字的外部注册（此后不再有 call 穿过 stale 名）。unregisterExternal
    // 缺席（未注入装配）静默跳过，保证幂等。
    await shutdown();
    opts.unregisterExternal?.(oldNames);
    rebuildSlots(config);
    bootstrapAll();
  }

  async function shutdown(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const slot of slots.values()) {
      if (slot.state === "disabled") continue;
      const handle = slot.handle;
      const abort = slot.callAbort;
      // 取消所有 in-flight 调用
      if (abort) abort.abort();
      if (handle) {
        tasks.push(
          handle.close().catch((err) => {
            // close 失败仅 warn
            console.warn(
              `[mcp/manager] server '${slot.config.name}' close error: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          })
        );
      }
    }
    await Promise.allSettled(tasks);
    // 在 handle.close() 完成前 SIGTERM 由 createRealClient 的 close 路径负责；
    // SDK 的 StdioClientTransport.close() 自带 SIGTERM 兜底（destroy child），
    // 这里再加一层兜底：直接拿 transport.pid 发 SIGTERM。
    for (const slot of slots.values()) {
      const child = (
        slot.handle as unknown as { _stdioPid?: number } | undefined
      )?._stdioPid;
      if (child && typeof child === "number") {
        try {
          process.kill(child, "SIGTERM");
        } catch {
          /* ESRCH 等忽略 */
        }
      }
    }
    for (const slot of slots.values()) {
      if (slot.state !== "disabled") slot.state = "failed";
    }
  }

  function status(): readonly McpServerStatus[] {
    const out: McpServerStatus[] = [];
    for (const slot of slots.values()) {
      out.push(
        slot.state === "failed" && slot.error
          ? {
              name: slot.config.name,
              state: slot.state,
              source: slot.config.source,
              error: slot.error,
            }
          : {
              name: slot.config.name,
              state: slot.state,
              source: slot.config.source,
            }
      );
    }
    // 按 name 字母序输出，确保测试稳定
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  const manager: McpManager = { start, reload, shutdown, status };

  // 测试钩子：暴露 slot 内 handle 数组（用于 in-flight callTool + 触发 list_changed）。
  // 生产路径由 createRealClient 实现，无副作用。
  (manager as unknown as { _handles: McpClientHandle[] })._handles = [];
  const wire = (slot: Slot) => {
    const orig = slot.handle;
    if (orig)
      (manager as unknown as { _handles: McpClientHandle[] })._handles.push(
        orig
      );
  };
  // We need to intercept after boot resolves; simplest is to expose via status reads.
  // Tests poke _handles directly after connect; we keep pointer fresh via wrapper.
  Object.defineProperty(manager, "_handles", {
    get() {
      const arr: McpClientHandle[] = [];
      for (const s of slots.values()) if (s.handle) arr.push(s.handle);
      return arr;
    },
  });
  void wire;

  return Object.freeze(manager);
}

// ---------------------------------------------------------------------------
// 生产路径 — 真 SDK client + stdio transport（单测用 stub）
// ---------------------------------------------------------------------------

/**
 * 生产 client 工厂。把 MCP SDK 的 `Client` + `StdioClientTransport` 包成
 * McpClientHandle。list_changed 在 constructor 通过 `Client` 的
 * `listChanged.tools.onChanged` 订阅；onclose 通过 transport 的
 * `onclose` 监听。
 *
 * 仅 stdio 走此路径；remote (url) 暂不实现，registerTo 时 manager 应当
 * 过滤掉 remote，或上层装配层把 remote 视为 disabled（spec 假设 9 + T7
 * 验收 bound）。
 */
export function createRealClient(server: McpServerConfig): McpClientHandle {
  if (server.kind !== "stdio") {
    throw new Error(
      `createRealClient: only stdio is wired up, got kind=${server.kind} for server '${server.name}'`
    );
  }

  // stderr: "pipe"（默认 "inherit"）—— 见下：MCP server 子进程的结构化日志
  // （如 codebase-memory-mcp 的 slog 行 `level=info msg=mcp.request ...`）默认
  // 直通父进程 stderr，TUI 运行期会把父进程 stderr 画进渲染区/底栏。接管后
  // 缓冲尾段，正常状态丢弃，仅 markFailed 时附进 error 保留诊断价值。
  const transport = new SdkStdioTransport({
    command: (server as McpStdioServer).entry.command,
    args: [...((server as McpStdioServer).entry.args ?? [])],
    env: (server as McpStdioServer).entry.env
      ? { ...(server as McpStdioServer).entry.env }
      : undefined,
    stderr: "pipe",
  });

  // stderr 环形缓冲：仅保留最近一段（2KB），失败时供 markFailed 附尾段。
  // SDK 在 stderr:"pipe" 时于构造器立即创建 PassThrough（_stderrStream），
  // 这里可以直接挂 data 监听器，无需等 spawn。
  const MAX_STDERR_TAIL = 2048;
  let stderrTail = "";
  transport.stderr?.on("data", (chunk: unknown) => {
    const s = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    stderrTail = (stderrTail + s).slice(-MAX_STDERR_TAIL);
  });

  // SDK 内部通过 Client._onclose 触发 transport close；这里再 hook 一次保险。
  transport.onclose = () => {
    closeCallbacks.forEach((cb) => cb());
  };

  let listChangedCallbacks: Array<(tools: readonly SdkTool[]) => void> = [];
  let closeCallbacks: Array<() => void> = [];

  const sdk = new SdkClient(
    { name: "iknow", version: "0.0.0" },
    {
      listChanged: {
        tools: {
          autoRefresh: true,
          onChanged: (err, items) => {
            if (err) {
              console.warn(
                `[mcp/manager] '${server.name}' list_changed error: ${err.message}`
              );
              return;
            }
            const tools = items ?? [];
            for (const cb of listChangedCallbacks) cb(tools);
          },
        },
      },
    }
  );

  // 记录 pid（关闭信号路径回退）—— SDK transport.start() 之后 transport.pid 可读。
  // 这里在 connect 后再绑定，避免 start 前 get pid 返回 null。
  let started = false;
  const originalConnect = sdk.connect.bind(sdk);
  (sdk as unknown as { connect: typeof sdk.connect }).connect = (async (
    t: unknown
  ) => {
    await originalConnect(t as never);
    started = true;
  }) as typeof sdk.connect;

  const handle: McpClientHandle = {
    connect: async () => {
      await sdk.connect(transport as never);
    },
    listTools: async () => {
      const out = await sdk.listTools();
      return out.tools as readonly SdkTool[];
    },
    callTool: async (name, args, callOpts) => {
      const result = await sdk.callTool(
        { name, arguments: (args ?? {}) as Record<string, unknown> },
        {
          timeout: callOpts?.timeout,
          signal: callOpts?.signal,
          resetTimeoutOnProgress: callOpts?.resetTimeoutOnProgress ?? true,
        }
      );
      return { result };
    },
    close: async () => {
      try {
        await sdk.close();
      } finally {
        // 兜底 SIGTERM 子进程（spec SC11：stdio 子孙必须收到 SIGTERM）
        if (started && transport.pid) {
          try {
            process.kill(transport.pid, "SIGTERM");
          } catch {
            /* ESRCH etc. */
          }
        }
      }
    },
    onListChanged: (cb) => {
      listChangedCallbacks.push(cb);
    },
    onClose: (cb) => {
      closeCallbacks.push(cb);
    },
  };

  // 暴露 pid 以便 manager.shutdown 兜底（再次 SIGTERM）
  (handle as unknown as { _stdioPid: number | undefined })._stdioPid =
    transport.pid ?? undefined;
  // 暴露 stderr 尾段，供 manager 在 markFailed 时附进 error（诊断价值）。
  (handle as unknown as { _stderrTail: () => string })._stderrTail = () =>
    stderrTail;

  return handle;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * 合并两个 AbortSignal:任一被 abort → 结果被 abort。
 * 任一为 undefined → 返回另一个的引用。
 * Node 18+ 的 AbortSignal.any 支持原生的多 signal 合并,在更老的运行时
 * 我们手写一个 fallback(本仓库 targetsNode >= 20,AbortSignal.any 一定可用)。
 */
function mergeAbort(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined
): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  // 两者都已 aborted → 直接返回 a(行为等价)
  if (a.aborted || b.aborted) return a;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([a, b]);
  }
  // 兜底:自己造 controller
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return ctrl.signal;
}
