/**
 * T7 (#344) — MCP manager：连接生命周期 + 状态机 + registerExternal 接线。
 *
 * 围绕一个小抽象 `McpClientHandle`，把 `@modelcontextprotocol/client`
 * 的 `Client` + `StdioClientTransport` 包成可注入的协议形态。生产路径
 * 默认用 `createRealClient`（同文件末），单测用内存假 client，不启真 server。
 *
 * 状态机（per server）：
 *   pending → connected   connect + 首次 listTools 完成，registerExternal(defs)
 *   pending → failed      connect/listTools 抛错或超时（默认 60s，可注入）
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
import path from "node:path";

import {
  Client as SdkClient,
  type CallToolResult as SdkCallToolResult,
  type Resource as SdkResource,
  type ResourceContents as SdkResourceContents,
  type Tool as SdkTool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport as SdkStdioTransport } from "@modelcontextprotocol/client/stdio";
import { McpLifecycleError, ToolExecutionError, errorMessage } from "../errors.js";
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
 * wayfinder #440 Stream B T8 — MCP resource 通道共享类型（manager 层 ↔ 工具层共享）。
 *
 * 与 p04 commit 2 同形：McpResource / McpResourceContent / McpPerServerState /
 * ListResourcesOpts / ListResourcesResult / ReadResourceResult 全部 readonly,
 * 聚合循环里 push 进 mutable 形态再冻结返回（见 MutableListResourcesResult）。
 */
export interface McpResource {
  readonly server: string;
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpPerServerState {
  readonly server: string;
  readonly state: McpServerState;
  readonly nextCursor?: string;
}

export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}

export interface ListResourcesOpts {
  readonly server?: string;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export interface ListResourcesResult {
  readonly resources: ReadonlyArray<McpResource>;
  readonly perServer: ReadonlyArray<McpPerServerState>;
}

/** 内部 mutable 形态 — 聚合循环里 push；返回前冻结成 ListResourcesResult。 */
interface MutableListResourcesResult {
  resources: McpResource[];
  perServer: McpPerServerState[];
}

export interface ReadResourceResult {
  readonly server: string;
  readonly uri: string;
  readonly contents: ReadonlyArray<McpResourceContent>;
}

/**
 * 抽象的 MCP client 句柄。让单测注入 stub，避免启动真子进程。
 *  - `connect()` → 建立到 server 的会话；
 *  - `listTools()` → 拉取工具清单；
 *  - `callTool(name, args, { timeout, signal, resetTimeoutOnProgress })`
 *  - `close()` → 关闭会话；
 *  - `onListChanged(tools)` → server 推送的工具变更；
 *  - `onClose()` → SDK 端连接关闭通知（用于触发 failed 不重连）；
 *  - `listResources({ cursor, signal })` → SDK 原语 `resources/list`（T8）。
 *  - `readResource(uri, { signal })` → SDK 原语 `resources/read`（T8）。
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
  /**
   * T8 — list resources exposed by the server. Optional `cursor` for pagination.
   * Returns SDK `{ resources, nextCursor? }` shape — manager 透传到调用方，仅做
   * 服务端归并。
   */
  readonly listResources: (opts?: {
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly resources: readonly SdkResource[];
    readonly nextCursor?: string;
  }>;
  /**
   * T8 — read a specific resource by URI. Returns SDK `{ contents }` shape
   * (TextResourceContents | BlobResourceContents 联合)。
   */
  readonly readResource: (
    uri: string,
    opts?: {
      readonly signal?: AbortSignal;
    }
  ) => Promise<{ readonly contents: readonly SdkResourceContents[] }>;
}

/** createClient / createRealClient 共用的 stdio transport 参数。 */
export interface McpTransportOpts {
  /** stdio 子进程 cwd（= resolver 返回的 workspaceRoot）。 */
  readonly cwd: string;
}

export interface McpManagerOptions {
  /** T3 产物的两级合并 server 列表。 */
  readonly config: readonly McpServerConfig[];
  /**
   * T4 — resolver 返回的当前 session/task root。stdio child 的 cwd，
   * 也是 MCP 工具 FS root。缺席 / 空白 / 非绝对 → 构造期抛
   * `McpLifecycleError`（`missing_cwd` / `invalid_cwd`），绝不回退
   * `process.cwd()`。
   */
  readonly workspaceRoot: string;
  /** T1 的 registerExternal 缝，把 mcp__ 工具追加进 ACI registry。 */
  readonly registerExternal: (defs: readonly AciToolDef[]) => void;
  /**
   * reload 缝：按名撤回旧 slot 已注册的 mcp__* 工具。缺席时 reload
   * 静默跳过 unregister（stale 名会残留 externalByExt，重名 register
   * 触发 Gate2 duplicate —— 生产装配必须注入）。
   */
  readonly unregisterExternal?: (names: readonly string[]) => void;
  /**
   * 连接超时毫秒（#378 根因 B：默认 60_000，缓解 npx cold start；生产装配点
   * 经 env 注入）。测试可注入短超时。
   */
  readonly timeoutMsOverride?: number;
  /** 工具调用超时（adapter 把 tier=long 映射到 30 min，这里给单测覆盖口）。 */
  readonly callTimeoutMsOverride?: number;
  /**
   * 抽象 client 工厂；测试覆盖；生产 = `createRealClient`。
   * 第二参 `transport.cwd` 恒等于 manager 持有的 `workspaceRoot`。
   */
  readonly createClient?: (
    server: McpServerConfig,
    transport: McpTransportOpts
  ) => McpClientHandle;
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
  /**
   * T8 — list resources across all connected servers (or one if `server`
   * specified). Aggregates per-server `listResources` calls,按 server 字母序
   * 合并 `resources` 数组,并附 `perServer` 状态快照（含 `nextCursor`）。
   * 未连接的 server 跳过，不抛；调用方用 `perServer[].state` 自检。SDK
   * 抛错 → 该 server 抛 ToolExecutionError。
   */
  readonly listResources: (
    opts?: ListResourcesOpts
  ) => Promise<ListResourcesResult>;
  /**
   * T8 — read a resource by server + URI。`server` 与 `uri` 都必填。
   * server 未配置 → 抛 ToolExecutionError。server 存在但未 connected /
   * failed → 抛 ToolExecutionError（携带 slot 当前 state 上下文）。
   */
  readonly readResource: (
    server: string,
    uri: string,
    opts?: { readonly signal?: AbortSignal }
  ) => Promise<ReadResourceResult>;
}

// ---------------------------------------------------------------------------
// 内部状态
// ---------------------------------------------------------------------------

interface Slot {
  readonly config: McpServerConfig;
  state: McpServerState;
  error?: string;
  /**
   * 超时标记（#378 根因 A）：仅 connect 超时路径（L-setTimeout 回调）设置。
   * 用于把"超时后迟到成功"与"真失败"区分开：bootSlot 在
   * 同一任务内允许把 failed 翻回 connected（flip-back），真失败不可翻。
   * flip-back 成功或正常 connected 后必须清除（见 bootSlot）。
   */
  timedOut?: boolean;
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

// 与 src/config/env.ts 的 IKNOW_MCP_CONNECT_TIMEOUT_MS 默认(60_000)对齐——
// 生产装配点(deps.ts / build-engine.ts)均经 env 注入 timeoutMsOverride,
// 此处兜底给独立调用 createMcpManager 且未注入的测试/脚本用, 避免双默认漂移。
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 1_800_000; // long 档（参见 aci/types.ts TIMEOUT_TIER_MS）

export function createMcpManager(opts: McpManagerOptions): McpManager {
  const workspaceRoot = requireWorkspaceRoot(opts.workspaceRoot);
  const timeoutMs = opts.timeoutMsOverride ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const callTimeoutMs = opts.callTimeoutMsOverride ?? DEFAULT_CALL_TIMEOUT_MS;

  /** 按 name 索引 slot。 */
  const slots = new Map<string, Slot>();

  /**
   * 生命周期代数：shutdown / reload 入口递增。bootSlot 捕获启动时的代数，
   * 迟到的 connect/listTools/list_changed 若代数已变 → 跳过注册与 flip-back
   * （T4：late connect 不能越过已终结的 manager 生命周期）。
   */
  let bootGeneration = 0;

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
    const gen = bootGeneration;
    const transportOpts: McpTransportOpts = { cwd: workspaceRoot };
    const created = opts.createClient
      ? opts.createClient(slot.config, transportOpts)
      : createRealClient(slot.config, transportOpts);
    slot.handle = created;
    slot.callAbort = new AbortController();

    const timeoutHandle = setTimeout(() => {
      // 超时先设标记再标 failed：bootSlot 靠它判断"迟到成功可否翻回"（#378）。
      // 真抛错路径不设此标记 —— 失败即定型，不翻。
      // 生命周期已终结（shutdown/reload）则跳过：避免把已 failed 槽再写超时残因。
      if (gen !== bootGeneration) return;
      slot.timedOut = true;
      markFailed(slot, "connect timeout");
    }, timeoutMs);

    // 注册 onclose → failed（不重连）。list_changed → 增量重注册。
    created.onClose(() => {
      if (gen !== bootGeneration) return;
      if (slot.state !== "connected") return;
      markFailed(slot, "connection closed by server");
    });
    created.onListChanged((tools) => {
      if (gen !== bootGeneration) return;
      if (slot.state !== "connected") return;
      try {
        registerTools(slot, tools);
      } catch (err) {
        // 重注册冲突 → warn but 不破坏本 server；已注册的留任。
        console.warn(
          `[mcp/manager] server '${slot.config.name}' list_changed re-registration skipped: ${errorMessage(
            err
          )}`
        );
      }
    });

    return (async () => {
      try {
        await created.connect();
      } catch (err) {
        clearTimeout(timeoutHandle);
        if (gen !== bootGeneration) return;
        markFailed(slot, errorMessage(err));
        return;
      }
      // 生命周期已终结：迟到 connect 不得继续 listTools / 注册 / flip-back。
      if (gen !== bootGeneration) {
        clearTimeout(timeoutHandle);
        return;
      }
      // connect 期间可能已被超时器标 failed。仅"超时后迟到成功"允许继续走
      // listTools（flip-back 入口，#378 根因 A）；真失败（无 timedOut 标记）
      // 一律 return —— failed 定型。
      if (slot.state !== "pending") {
        if (slot.state !== "failed" || !slot.timedOut) {
          clearTimeout(timeoutHandle);
          return;
        }
        // timedOut 标记不清除：flip-back 成功由第二守卫负责清除，
        // 若 listTools 真抛错则 catch 保持 failed（标记残留无影响）。
      }
      try {
        const tools = await created.listTools();
        clearTimeout(timeoutHandle);
        if (gen !== bootGeneration) return;
        if (slot.state !== "pending") {
          // 超时后迟到成功：同一 bootSlot 任务内翻回 connected。
          // registerTools 由 `registered` 集合去重，重复调用幂等。
          if (slot.state === "failed" && slot.timedOut) {
            registerTools(slot, tools);
            slot.state = "connected";
            delete slot.timedOut;
            // 恢复 connected 时清掉 error：status() 只在 failed+error 时
            // 填 error，避免把超时残因带到已恢复的连接上。
            delete slot.error;
          }
          return;
        }
        registerTools(slot, tools);
        slot.state = "connected";
      } catch (err) {
        clearTimeout(timeoutHandle);
        if (gen !== bootGeneration) return;
        markFailed(slot, errorMessage(err));
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
    // 先递增代数，阻断一切在途 bootSlot / list_changed 的迟到注册。
    bootGeneration += 1;
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
              `[mcp/manager] server '${slot.config.name}' close error: ${errorMessage(
                err
              )}`
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

  // -------------------------------------------------------------------------
  // T8 — resource 通道 (list/read)
  // -------------------------------------------------------------------------

  /**
   * 把单个 slot 的 resources 聚合进 out。未 connected slot → perServer 记录
   * 当前 state（不抛）；SDK 抛错 → 抛 ToolExecutionError（屏蔽 SDK 类型）。
   */
  async function collectSlotResources(
    slot: Slot,
    opts: ListResourcesOpts | undefined,
    out: MutableListResourcesResult
  ): Promise<void> {
    if (!slot.handle || slot.state !== "connected") {
      out.perServer.push({ server: slot.config.name, state: slot.state });
      return;
    }
    let result: {
      readonly resources: readonly SdkResource[];
      readonly nextCursor?: string;
    };
    try {
      result = await slot.handle.listResources({
        cursor: opts?.cursor,
        // 把 caller 的 signal + slot 的 shutdown signal 合并，与 callTool 路径一致：
        // shutdown() 取消时在途 listResources 收到 abort（SC16）。
        signal: mergeAbort(opts?.signal, slot.callAbort?.signal),
      });
    } catch (err) {
      throw new ToolExecutionError(
        `mcp server '${slot.config.name}' listResources failed: ${errorMessage(err)}`
      );
    }
    for (const r of result.resources) {
      out.resources.push({
        server: slot.config.name,
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      });
    }
    out.perServer.push({
      server: slot.config.name,
      state: slot.state,
      nextCursor: result.nextCursor,
    });
  }

  /** 按 server 名找 slot 并校验 connected；失败抛 ToolExecutionError。 */
  function lookupConnectedSlot(server: string, op: string): Slot {
    if (!server) {
      throw new ToolExecutionError(`mcp ${op}: server name is required`);
    }
    const slot = slots.get(server);
    if (!slot) {
      throw new ToolExecutionError(`mcp server '${server}' not configured`);
    }
    if (!slot.handle || slot.state !== "connected") {
      throw new ToolExecutionError(
        `mcp server '${server}' not connected (state=${slot.state})`
      );
    }
    return slot;
  }

  /**
   * 聚合 listResources：`server` 缺省 → 全 server；指定 → 仅该 server。
   * 跳过未 connected 的 slot（不抛，perServer 暴露当前 state）。
   * SDK 抛错 → 抛 ToolExecutionError（manager 层屏蔽 SDK 错误类型）。
   * `cursor` 透传给每个 server；不分页聚合（SDK 内部 listResources
   * 在 `cursor` 缺席时已自动聚合，cursor 存在时按 page 协议透传）。
   */
  async function listResources(
    opts?: ListResourcesOpts
  ): Promise<ListResourcesResult> {
    const out: MutableListResourcesResult = { resources: [], perServer: [] };
    // 按 name 字母序遍历，确保聚合顺序测试稳定
    const ordered = [...slots.values()].sort((a, b) =>
      a.config.name.localeCompare(b.config.name)
    );
    for (const slot of ordered) {
      if (opts?.server && slot.config.name !== opts.server) continue;
      await collectSlotResources(slot, opts, out);
    }
    return out;
  }

  /**
   * 读单个 server 的 resource URI。server 未配置（config 内不存在）
   * → 抛 ToolExecutionError "not configured"。server 存在但未 connected
   * → 抛 ToolExecutionError（带当前 state）。SDK 抛错 → 抛 ToolExecutionError。
   */
  async function readResource(
    server: string,
    uri: string,
    opts?: { readonly signal?: AbortSignal }
  ): Promise<ReadResourceResult> {
    if (!uri) {
      throw new ToolExecutionError(
        `mcp readResource: uri is required (server='${server}')`
      );
    }
    const slot = lookupConnectedSlot(server, "readResource");
    let raw: { readonly contents: readonly SdkResourceContents[] };
    try {
      raw = await slot.handle!.readResource(uri, {
        // 把 caller 的 signal + slot 的 shutdown signal 合并，与 callTool 路径一致：
        // shutdown() 取消时在途 readResource 收到 abort（SC16）。
        signal: mergeAbort(opts?.signal, slot.callAbort?.signal),
      });
    } catch (err) {
      throw new ToolExecutionError(
        `mcp server '${server}' readResource('${uri}') failed: ${errorMessage(err)}`
      );
    }
    return {
      server,
      uri,
      contents: raw.contents.map(projectResourceContent),
    };
  }

  const manager: McpManager = {
    start,
    reload,
    shutdown,
    status,
    listResources,
    readResource,
  };

  // 测试钩子：暴露 slot 内 handle 数组（用于 in-flight callTool + 触发 list_changed）。
  // live getter：每次读时从 slots 收集当前 handle，避免静态快照过期。
  Object.defineProperty(manager, "_handles", {
    get() {
      const arr: McpClientHandle[] = [];
      for (const s of slots.values()) if (s.handle) arr.push(s.handle);
      return arr;
    },
  });

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
 *
 * `opts.cwd` 是 stdio 子进程工作目录（= manager 的 workspaceRoot）；相对
 * command / 相对 args 路径均相对此根解析，不继承 `process.cwd()`。
 */
export function createRealClient(
  server: McpServerConfig,
  opts: McpTransportOpts
): McpClientHandle {
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
    cwd: opts.cwd,
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
    // T8 — 转发 resources/list + resources/read SDK 原语
    listResources: async (opts) => {
      const result = await sdk.listResources(
        { cursor: opts?.cursor } as never,
        { signal: opts?.signal } as never
      );
      const page = result as { resources: SdkResource[]; nextCursor?: string };
      return {
        resources: (page.resources ?? []) as readonly SdkResource[],
        nextCursor: page.nextCursor,
      };
    },
    readResource: async (uri, opts) => {
      const result = await sdk.readResource(
        { uri } as never,
        { signal: opts?.signal } as never
      );
      const page = result as { contents: SdkResourceContents[] };
      return {
        contents: (page.contents ?? []) as readonly SdkResourceContents[],
      };
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

/**
 * 构造期校验 manager 的 workspaceRoot。缺席 → `missing_cwd`；空白 / 非绝对
 * / 含 NUL → `invalid_cwd`。不做 process.cwd() 回退；规范化与 roots.ts 同形
 * （manager 只消费已解析的 workspaceRoot，不引入 productRoot）。
 */
function requireWorkspaceRoot(value: string | undefined): string {
  if (typeof value !== "string") {
    throw new McpLifecycleError(
      "missing_cwd",
      "workspaceRoot is required and was not provided"
    );
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("\0")) {
    throw new McpLifecycleError(
      "invalid_cwd",
      "workspaceRoot must be a normalizable absolute path"
    );
  }
  const normalized = path.normalize(trimmed);
  if (!path.isAbsolute(normalized)) {
    throw new McpLifecycleError(
      "invalid_cwd",
      "workspaceRoot must be an absolute path"
    );
  }
  // 去掉结尾分隔符，但保留文件系统根本身。
  const { root } = path.parse(normalized);
  let out = normalized;
  while (
    out.length > root.length &&
    (out.endsWith(path.sep) || out.endsWith("/"))
  ) {
    out = out.slice(0, -1);
  }
  return out;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * ResourceContents 是 TextResourceContents | BlobResourceContents 联合
 * —— 仅透传存在的字段,类型守卫后在对象文案层统一形态。
 */
function projectResourceContent(c: SdkResourceContents): McpResourceContent {
  const text = (c as { text?: string }).text;
  const blob = (c as { blob?: string }).blob;
  return {
    uri: c.uri,
    mimeType: c.mimeType,
    text,
    blob,
  };
}

/**
 * 合并两个 AbortSignal:任一被 abort → 结果被 abort。
 * 任一为 undefined → 返回另一个的引用。
 * package.json engines.node >= 20 → AbortSignal.any 一定可用（无 fallback）。
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
  return AbortSignal.any([a, b]);
}
