/**
 * LSP 客户端层 — spec 251-lsp-tool（§ client.ts：getClient() 三件套缓存）。
 *
 * 职责：把 `server.ts` 的 `LspServerInfo` 句柄包成 vscode-jsonrpc 的
 * `MessageConnection`，并对同一 (root, server.id) 复用连接（S9 三件套：
 * clients 缓存 / broken 记忆 / inflight 并发去重）。
 *
 * **多语言 dispatch（spec 302-lsp-multilang § client.ts，#304 决策1）**：
 * `getClient` 不再硬编默认 `Typescript`，改按 `file` 扩展名经
 * `server.ts` 的 `resolveServer(file)` 路由到对应 server（`.py`→Pyright、
 * `.yaml`→YamlLS、`.json`→JsonLS、`Dockerfile`→DockerfileLS、`.ts`→
 * Typescript）；无匹配 → early-return `undefined`（`"(no LSP server)"`）。
 * `opts.server` 测试注入点保留，语义从「默认 server」变「覆盖 dispatch 结果」。
 *
 * 与 lsp.ts:208-297 的复用三件套同源（#247 Q8），但 iknow 无
 * InstanceContext：ctx 由调用方（handler 层）持有 `{ directory }`。
 *
 * **取消语义（Q2/A9）**：中断走 JSON-RPC `$/cancelRequest`，**绝不终止
 * tsserver 子进程**。工具路径不存在任何进程终止调用。进程终止点分两类，
 * 都在池上：回收缝（`sweepIdleClients` / worktree rebind stale sweep /
 * `disposeAll`）终结被回收 entry 的子进程，可在进程中途调用；`shutdownAll()`
 * 额外 latch，只允许在**宿主进程退出缝**调用（run.tsx shutdownExtensions /
 * combinedShutdown、cli.ts chatProcessShutdown —— 引擎 shutdown 不在其列：
 * chat rebind 收口旧引擎发生在进程中途，一旦 latch 共享池，重建引擎的 LSP
 * 将永久 spawn-failed）。常规工具操作只做 `connection.dispose()`（释放连接，
 * 不涉子进程信号）。
 *
 * **编辑同步 + 自愈（lsp-optimization plan T1）**：`notifyChange(file)` 把
 * edit_file 写盘后的最新文本经标准 `textDocument/didChange`（full sync）同步
 * 给 server，后续请求基于新内容；server 进程意外 `exit` 时把对应 key 从
 * `clients` 缓存逐出（不进 `broken`），下次调用自动重新 spawn。per-request
 * 超时（`$/cancelRequest` 取消语义）在工具层（aci/tools/lsp.ts）实现——
 * 距离 abort 桥接与错误转译更近，比在 sendRequest 内包 race 更可控。
 */
import { pathToFileURL } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";

import {
  createMessageConnection,
  CancellationTokenSource,
  CancellationToken,
} from "vscode-jsonrpc/node";
import type { MessageConnection } from "vscode-jsonrpc/node";

import type { LspCtx, LspServerInfo } from "./types.js";
import { resolveServer } from "./server.js";
import { languageIdFor } from "./language.js";

/**
 * 空闲客户端回收的缺省阈值（lsp-optimization 二期 B5）：常驻引擎
 * （build-engine）在 settings.lsp.idleTimeoutMs 未配置时注入本值，让 sweep
 * 生效；worker 不读 settings 文件，但注入本缺省值（与常驻引擎同 sweep）。
 */
export const DEFAULT_LSP_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** 客户端包装：对上层（handler）暴露薄透传的 sendRequest / sendNotification / dispose。 */
export interface LspClient {
  /** 底层 vscode-jsonrpc `MessageConnection`（cancel 等进阶用法可直达）。 */
  readonly connection: MessageConnection;
  /** tsserver 子进程句柄（仅诊断/生命周期观测用；终止走池的回收/退出缝）。 */
  readonly process: ChildProcess;
  /**
   * JSON-RPC request：透传 method/params，返回未知 payload。
   * 可选 `token`（vscode-jsonrpc `CancellationToken`）用于取消 — token 被
   * cancel 时 vscode-jsonrpc 自动发 `$/cancelRequest` 通知(Q2/A9),
   * 不杀 tsserver 子进程(spec §S)。
   */
  sendRequest(
    method: string,
    params: unknown,
    token?: CancellationToken
  ): Promise<unknown>;
  /** JSON-RPC notification：透传 method/params。 */
  sendNotification(method: string, params: unknown): Promise<void>;
  /**
   * 幂等打开文件（textDocument/didOpen）：tsserver 对未打开文件不建 project，
   * 符号类操作全返空。同一文件重复调用只发一次 didOpen（per-connection 缓存）。
   *
   * **低层 API —— 裸 ensureOpen 不释放打开**：调用后该 uri 保持打开直到
   * connection 结束。请求路径请用 `withDocumentOpen`（两次调用之间不对
   * server 保持打开，见 spec 251「打开文档生命周期」）。本方法保留给
   * 「打开即目的」的用途（warmup 预热 project 加载）。
   */
  ensureOpen(file: string): Promise<void>;
  /**
   * 请求级文档作用域（spec 251「打开文档生命周期」）：进入时按需
   * `didOpen`（refcount++），退出时 refcount-- 归零则 `didClose` 并丢弃该
   * uri 的打开记录与诊断缓存。`fn` 抛错也走归零（try/finally）——
   * timeout / RPC error / ToolExecutionError 都不泄漏打开状态。
   *
   * 并发：同一 uri 的重叠作用域共享一次 didOpen，最后一个退出者发 didClose。
   */
  withDocumentOpen<T>(file: string, fn: () => Promise<T>): Promise<T>;
  /**
   * 把磁盘上的最新文本同步给 server（lsp-optimization plan T1）：
   *   - uri 未打开过 → 等价 `ensureOpen(file)`（didOpen 读到的即最新文本）；
   *   - 已打开 → 读文件全文发 `textDocument/didChange`（full sync，
   *     tsserver / typescript-language-server 默认支持 full sync），per-uri
   *     version 从 didOpen 的 1 起每次 +1。
   *
   * 读文件失败 → reject（调用方 notifier 层已 catch，这里不额外吞）。
   */
  notifyChange(file: string): Promise<void>;
  /** 取某文件最近一次 push diagnostics（latest-wins；无 → undefined）。 */
  getDiagnostics(uri: string): ReadonlyArray<unknown> | undefined;
  /**
   * 取某文件的诊断 entry（含 items 与 pushVersion，lsp-optimization 二期 B1）。
   * `pushVersion` 是 server 推送时携带的 textDocument 版本（params.version 为
   * number 时透传，缺省 undefined）；工具层据此判断「编辑后的新诊断是否已到」。
   */
  getDiagnosticsEntry(
    uri: string
  ):
    | { readonly items: ReadonlyArray<unknown>; readonly pushVersion?: number }
    | undefined;
  /**
   * 该 uri 当前 didChange 版本（二期 B1）：didOpen=1、notifyChange 每次 +1；
   * 未打开 → undefined。工具层据此判定「编辑过」（version ≥ 2）并等待
   * pushVersion 追平 openVersion。
   */
  getOpenVersion(uri: string): number | undefined;
  /**
   * 该 uri 最近一次同步给 server 的文本指纹（内容身份，未打开 → undefined）。
   * 请求级打开下 LSP version 每次 didOpen 都从 1 起重来，版本号无法区分
   * 「同一文件的两次打开」；跨请求的缓存键（符号树）要用指纹而非版本号。
   */
  getDocumentFingerprint(uri: string): string | undefined;
  /**
   * `initialize` 响应里的 server capabilities（原样快照）。
   *
   * **缺席 ≠ 不支持**：typescript-language-server 实测不声明
   * `callHierarchyProvider` 却实现了 call hierarchy —— 据此裁剪会误伤。
   * 只有 server **显式声明 `false`** 才算「不支持，不发 RPC」。
   */
  getServerCapabilities(): Record<string, unknown>;
  /**
   * 释放连接（不杀进程）。进程生命周期由池的回收缝与退出缝收口 ——
   * 「关连接」与「终结子进程」是两件事，client 只承担前者。
   */
  dispose(): void;
}

/**
 * getClientDetailed 的失败原因（lsp-optimization 二期 B3 哨兵分层）：
 *   - `no-server`：resolveServer 无匹配扩展名，或命中的 server.id 在
 *     ctx.disabledServers（视为未配置）；
 *   - `no-root`：server.root() 未找到项目根标记；
 *   - `spawn-failed`：spawn 返回 undefined / throw（bin 缺失等），或命中的
 *     是 broken 记忆。
 * `serverId` 在已知命中目标时携带（no-server 的扩展名不匹配分支无 id）。
 */
export type LspClientFailure = {
  reason: "no-server" | "no-root" | "spawn-failed";
  serverId?: string;
};

/**
 * 可实例化的 LSP 连接池。生产引擎共享进程级缺省池（`getClient` 的 ctx 不注
 * 入 pool → `poolOf` 落 defaultPool；warmup spawn 缓存同源，进程内一份 ——
 * per-engine 池会让多引擎/测试场景每次装配重新 spawn language server）；
 * `ctx.pool` 注入位供测试隔离（createLspClientPool）。
 * 终止语义：回收缝（idle sweep / rebind stale sweep / `disposeAll`）终结被
 * 回收 entry 的子进程，可在进程中途调用；`shutdownAll()` 在此基础上单向
 * latch（此后 getClient 一律 spawn-failed），**只允许宿主进程退出缝调用**
 * （shutdownDefaultLspPool 消费方，见文件头取消语义注）——引擎 shutdown /
 * 池重建路径不得调用。
 */
export class LspClientPool {
  /** key = `${root}:${server.id}` → 已建立并复用的客户端。 */
  readonly clients = new Map<string, LspClient>();
  readonly broken = new Map<string, "spawn-failed">();
  readonly inflight = new Map<string, Promise<LspClient | undefined>>();
  readonly lastUsedAt = new Map<string, number>();

  /**
   * T8（D5）: 上次见到的 `directoryCell` 读值。`getClient` 入口若 cell
   * 当前值 ≠ 该值，视为发生过 rebind —— 把所有 root 等于旧 taskRoot 的
   * entry 视为 stale，终结子进程并逐出（`sweepStaleForRebind`）。
   *
   * `undefined` ≡ 首调（未跟踪），不做 sweep —— 与「未发生过 flip」等价。
   */
  lastSeenTaskRoot: string | undefined = undefined;

  /**
   * 终结一个 entry：关连接 + SIGTERM 子进程 + 逐出缓存。三条回收缝与
   * `shutdownAll` 共用，避免逐处复制。
   *
   * 关连接不释放子进程的 stdio 管道句柄，事件循环因此排不空 —— 被回收的
   * 子进程必须显式 SIGTERM，否则活到宿主退出（长 session / rebind 下即
   * 进程泄漏）。
   */
  private terminate(key: string, client: LspClient): void {
    client.dispose();
    // 进程已死时 kill 返回 false，无害。
    client.process.kill("SIGTERM");
    this.evictCachedClient(key, client);
  }

  /**
   * T8（D5）: rebind 检测 —— 当 `directoryCell` 在场且本次读到的值与上次
   * 记录的 `lastSeenTaskRoot` 不一致时，视为 taskRoot 翻动。把所有 root
   * 等于**旧** taskRoot 的 entry 终结（关连接 + SIGTERM 子进程）并逐出；
   * 同步更新 `lastSeenTaskRoot` 为当前值。
   *
   * 选择 lazy sweep（vs flip event handler）原因（plan §6 T8 收口时机决议）：
   *  - 不需要订阅基础设施，单点 `getClient` 内处理；
   *  - 无活动调用 → 无 sweep 开销（un-rebind 路径零副作用，与 byte-identical
   *    守门对齐 —— `lastSeenTaskRoot === currentValue` 早返）；
   *  - rebind 后第一次跨根调用就触发收口，旧根 client 在调用栈内被终结，
   *    与「不写旧根」合约自然耦合（写路径必先过 `getClient`）。
   *
   * 扫描按 **root === 旧 taskRoot** 全量进行，不带 serverId 过滤：cell 一翻
   * `lastSeenTaskRoot` 即更新，被过滤掉的 server 在旧根下的 client 从此再也
   * 不会被扫到 —— 多语言会话里就是子进程泄漏。本次 dispatch 命中的 server 是
   * 请求路由目标，不是回收范围。
   *
   * 注意：sweep 比对的是**旧 taskRoot**，不是 `ctx.directory` 上界 —— `server.root()`
   * 返回的最近项目根 marker（`/root`）天然可以与 taskRoot（`/work`）不同，错误地
   * 以 snapshot 上界 sweep 会清掉同 tree 下不同 LSP server root 的合法 client。
   */
  sweepStaleForRebind(currentTaskRoot: string): void {
    const previous = this.lastSeenTaskRoot;
    if (previous === undefined) {
      this.lastSeenTaskRoot = currentTaskRoot;
      return;
    }
    if (previous === currentTaskRoot) return;
    // key = `${root}:${server.id}`；server.id 不含 ":"，故按最后一个分隔符
    // 切出的 root 段与拼接侧同源，`/work` 不会误伤 `/work-2` 或
    // 名字里带 ":" 的兄弟根。
    for (const [key, client] of [...this.clients]) {
      const sep = key.lastIndexOf(":");
      if (sep === -1 || key.slice(0, sep) !== previous) continue;
      this.terminate(key, client);
      this.broken.delete(key);
    }
    this.lastSeenTaskRoot = currentTaskRoot;
  }

  evictCachedClient(key: string, expected?: LspClient): void {
    if (expected !== undefined && this.clients.get(key) !== expected) return;
    this.clients.delete(key);
    this.lastUsedAt.delete(key);
  }

  sweepIdleClients(idleTimeoutMs: number | undefined): void {
    if (
      idleTimeoutMs === undefined ||
      !Number.isFinite(idleTimeoutMs) ||
      idleTimeoutMs <= 0 ||
      this.clients.size === 0
    )
      return;
    const now = Date.now();
    for (const [key, client] of [...this.clients]) {
      if (now - (this.lastUsedAt.get(key) ?? 0) > idleTimeoutMs) {
        this.terminate(key, client);
      }
    }
  }

  /**
   * 回收全部 entry 并清空失败记忆 / in-flight 表。**不 latch**：之后
   * getClient 仍会重新 spawn（池仍可用，只是没有常驻子进程）。
   */
  async disposeAll(): Promise<void> {
    for (const [key, client] of [...this.clients]) {
      this.terminate(key, client);
    }
    this.broken.clear();
    this.inflight.clear();
  }

  /**
   * 生命周期终态（引擎 shutdown / 退出路径专用）：终结全部已 spawn 子进程
   * + 清空池。此后本池 getClientDetailed 一律 spawn-failed，不再重建子进程
   * （防退出路径 re-spawn 泄漏）。
   *
   * 与 disposeAll 的差别只在这个 latch：disposeAll 回收后可再 spawn，
   * 本方法之后不可。
   */
  shutDown = false;

  async shutdownAll(): Promise<void> {
    this.shutDown = true;
    for (const [key, client] of [...this.clients]) {
      this.terminate(key, client);
    }
    this.clients.clear();
    this.lastUsedAt.clear();
    this.broken.clear();
    this.inflight.clear();
  }
}

const defaultPool = new LspClientPool();

export function createLspClientPool(): LspClientPool {
  return new LspClientPool();
}

/**
 * 终结进程级缺省池的全部 LSP 子进程（引擎 shutdown / 退出路径消费）。
 * 缺省池跨引擎共享（warmup spawn 缓存同源），进程内只此一份 —— 收口即
 * 全部终结，故只在宿主进程退出路径调用，不得在单引擎重建中途调用。
 */
export function shutdownDefaultLspPool(): Promise<void> {
  return defaultPool.shutdownAll();
}

function poolOf(ctx: LspCtx): LspClientPool {
  return ctx.pool ?? defaultPool;
}

/**
 * T8（D5, plans/worktree-live-task-root.md §6 T8）: 取本次调用的 effective
 * directory —— `ctx.directoryCell` 在场时以 cell 当前值为真值；缺席时退
 * 回 `ctx.directory` 冻结值（un-rebind 路径行为逐字节不变）。
 *
 * 入口一次性读取（D2 batch snapshot）：一次 `getClient` 调用贯穿整条路径
 * 都用同一个值，避免同调用内 cell 被外部翻动造成读漂移。
 */
export function resolveDirectorySnapshot(ctx: LspCtx): string {
  return ctx.directoryCell ? ctx.directoryCell.read() : ctx.directory;
}

/**
 * 按 (file, ctx) 取得（或建立）对应 LSP 客户端，并给出失败原因
 * （lsp-optimization 二期 B3 哨兵分层）。
 *
 * 流程（spec § client.ts + 二期扩展）：
 *   0. 入口 lazy sweep（二期 B5）：按 ctx.idleTimeoutMs 回收空闲客户端。
 *   1. `server = opts?.server ?? resolveServer(file)`；无匹配 → no-server。
 *      命中的 server.id 在 ctx.disabledServers → no-server（视为未配置）。
 *   2. `root = await server.root(file, ctx)`；undefined → no-root。
 *   3. `key = root + ":" + server.id`；`broken` 命中 → spawn-failed。
 *   4. `clients.has(key)` → 复用缓存（刷新 lastUsedAt）。
 *   5. `inflight.has(key)` → 共享 in-flight spawn Promise（并发去重）。
 *   6. 否则发起 `spawnClient` 任务：失败标 `broken`；成功存 `clients`；
 *      `.finally` 释放 `inflight`。
 *
 * `opts.server` 可注入测试替身，**覆盖** `resolveServer(file)` 的 dispatch
 * 结果（默认按扩展名路由到对应 server）。
 *
 * @returns `{ client }` 或 `{ failure }`——恰有一个字段（client 缺失时
 *          failure 必在场；failure 的 serverId 供哨兵渲染）。
 */
export async function getClientDetailed(
  ctx: LspCtx,
  file: string,
  opts?: { readonly server?: LspServerInfo }
): Promise<{ client?: LspClient; failure?: LspClientFailure }> {
  const pool = poolOf(ctx);
  // 生命周期终态后不再 spawn（防退出路径 re-spawn 泄漏）—— 见 shutdownAll。
  if (pool.shutDown) return { failure: { reason: "spawn-failed" } };
  pool.sweepIdleClients(ctx.idleTimeoutMs);
  const server = opts?.server ?? resolveServer(file);
  if (!server) return { failure: { reason: "no-server" } };
  if (ctx.disabledServers?.includes(server.id)) {
    return { failure: { reason: "no-server", serverId: server.id } };
  }
  // T8（D5）: per-call directory snapshot — 入口读一次活根 cell,
  // 之后整条路径（NearestRoot stop / pool key）都用同一值。Wave 内一致
  // 与 D2 batch snapshot 同源 —— cell 在本次调用内被外部翻动不会污染。
  // 注意 sweep 用 cell 值的**翻转**触发，不是与 server.root 上界比较:
  // 同一 server 不同 file 的 server.root 可能天然不同(同 tree 下不同 marker),
  // 但都属于同一 taskRoot,不应被 sweep。
  const directorySnapshot = resolveDirectorySnapshot(ctx);
  const ctxForRoot: LspCtx =
    ctx.directoryCell !== undefined
      ? { ...ctx, directory: directorySnapshot }
      : ctx;
  if (ctx.directoryCell !== undefined) {
    pool.sweepStaleForRebind(directorySnapshot);
  }
  const root = await server.root(file, ctxForRoot);
  if (!root) return { failure: { reason: "no-root", serverId: server.id } };

  const key = `${root}:${server.id}`;
  const spawnFailed = (): { failure: LspClientFailure } => ({
    failure: { reason: "spawn-failed", serverId: server.id },
  });
  const cached = pool.clients.get(key);
  if (cached) {
    pool.lastUsedAt.set(key, Date.now());
    return { client: cached };
  }
  if (pool.broken.has(key)) return spawnFailed();
  const pending = pool.inflight.get(key);
  if (pending) {
    const client = await pending;
    return client ? { client } : spawnFailed();
  }

  const task = spawnClient(pool, server, root, ctxForRoot)
    .then((client) => {
      if (client) {
        pool.clients.set(key, client);
        pool.lastUsedAt.set(key, Date.now());
        return client;
      }
      pool.broken.set(key, "spawn-failed");
      return undefined;
    })
    .catch(() => {
      pool.broken.set(key, "spawn-failed");
      return undefined;
    })
    .finally(() => {
      pool.inflight.delete(key);
    });
  pool.inflight.set(key, task);
  const client = await task;
  return client ? { client } : spawnFailed();
}

/**
 * 按 (file, ctx) 取得（或建立）对应 LSP 客户端 —— `getClientDetailed` 的
 * 薄包装（二期 B3）：只取 client，失败归一为 undefined。签名与行为对既有
 * 调用方（notifier / warmup / 探针）完全兼容。
 */
export async function getClient(
  ctx: LspCtx,
  file: string,
  opts?: { readonly server?: LspServerInfo }
): Promise<LspClient | undefined> {
  return (await getClientDetailed(ctx, file, opts)).client;
}

/**
 * 建立单个 server 连接：spawn 子进程 → pipe stdio 建 MessageConnection →
 * 发 `initialize` 握手 → `listen()` → 包成 `LspClient`。
 *
 * `server.spawn` 返回 `undefined`（bin 缺失等）→ 返回 `undefined`，
 * 由调用方标记 broken；不抛错、不静默吞。
 * stdio 未 pipe（stdout/stdin 缺失）同样视为不可用 → `undefined`。
 */
async function spawnClient(
  pool: LspClientPool,
  server: LspServerInfo,
  root: string,
  ctx: LspCtx
): Promise<LspClient | undefined> {
  // 与 getClient 同源的缓存 key：exit 自愈钩子逐出 `clients` 时需要。
  const key = `${root}:${server.id}`;
  const handle = await server.spawn(root, ctx);
  if (!handle) return undefined;

  const { process: child, initialization } = handle;
  if (!child.stdout || !child.stdin) return undefined;

  const connection = createMessageConnection(child.stdout, child.stdin);
  child.stderr?.resume();

  // LSP initialize 握手：tsserver 透传 path 放 initializationOptions。
  // 必须先 connection.listen() 启动 reader 环，否则 sendRequest 抛
  // "Call listen() first."（vscode-jsonrpc 要求）。
  connection.listen();
  const initializeResult = (await connection.sendRequest("initialize", {
    processId: child.pid ?? null,
    rootUri: pathToFileURL(root).href,
    // 只广告 harness 实际会发的 method（spec 251「initialize 能力广告」）：
    // 声明 textDocument 文本同步 + 诊断推送订阅；符号能力是 **server** 的
    // 能力（走其 capabilities 响应），不在 client 侧声明。
    capabilities: {
      textDocument: {
        synchronization: { dynamicRegistration: false },
        publishDiagnostics: { relatedInformation: true },
      },
      workspace: { symbol: { dynamicRegistration: false } },
    },
    initializationOptions: initialization,
  })) as { capabilities?: Record<string, unknown> } | undefined;
  // server 声明的能力快照：仅用于「显式 false → 不发」判定（缺席 ≠ 不支持，
  // 见 getServerCapabilities 注释）。
  const serverCapabilities = initializeResult?.capabilities ?? {};

  // LSP initialized 通知（生产正确性，spec 302-lsp-multilang § T6）：initialize
  // 响应后必须补发 `initialized` 通知，server 才算进入 ready 态。pyright 实测
  // 不 gate——收不到 initialized 则忽略后续所有请求；tsserver 不 gate 所以 TS
  // 原本正常，补发对 tsserver 兼容（幂等，重复发送无害）。此修复后，探针侧
  // （scripts/lsp-probe.ts）不再另行补发，避免 double-init。
  await connection.sendNotification("initialized", {});

  // 订阅 push diagnostics：tsserver / typescript-language-server 不实现
  // pull 的 textDocument/diagnostic（LSP 3.16+），用 publishDiagnostics 通知
  // 累积最近一次 per-uri 的诊断列表。latest-wins:同一 uri 多次推送覆盖。
  // 二期 B1：entry 记录 server 推送时的 textDocument 版本（params.version 为
  // number 时透传，缺省 undefined），供工具层判断「编辑后的新诊断是否已到」。
  const diagStore = new Map<
    string,
    { items: ReadonlyArray<unknown>; pushVersion?: number }
  >();
  connection.onNotification(
    "textDocument/publishDiagnostics",
    (params: unknown) => {
      if (!params || typeof params !== "object") return;
      const p = params as {
        uri?: unknown;
        diagnostics?: unknown;
        version?: unknown;
      };
      if (typeof p.uri !== "string") return;
      const items = Array.isArray(p.diagnostics) ? p.diagnostics : [];
      const pushVersion = typeof p.version === "number" ? p.version : undefined;
      diagStore.set(p.uri, { items, pushVersion });
    }
  );

  // 打开文档状态：同一 connection 内以 uri 为键的**单一**记录（version /
  // refcount / pinned 同源，避免多 Map 漂移 —— 与二期 B1 合并 versionCounters
  // 的纪律同源）。tsserver per-project 维护打开文件表，重复 didOpen 同 uri 会
  // 触发版本断言，因此本地去重。
  //
  //   - `version`：didOpen 置 1，`didChange` 每次 +1（getOpenVersion 消费方：
  //     符号缓存的版本键、诊断等待的新旧判定）；
  //   - `refs`：请求级作用域持有数（withDocumentOpen 进出）；
  //   - `pinned`：裸 `ensureOpen` 的永久持有（warmup 预热用）——被 pin 的 uri
  //     不随作用域归零关闭（见 LspClient.ensureOpen doc）。
  interface OpenDoc {
    version: number;
    refs: number;
    pinned: boolean;
    /** 最近一次同步给 server 的文本指纹（内容身份，见 getDocumentFingerprint）。 */
    fingerprint: string;
    /** 最近一次同步时磁盘 mtime（ms）。请求前据此判断盘外变更。 */
    mtimeMs: number;
  }
  const openDocs = new Map<string, OpenDoc>();

  /**
   * 文本指纹 = 内容身份（sha1）。用内容而非版本号作跨请求缓存键：
   * didClose 后重新 didOpen 会把 LSP version 归 1，版本号无法区分「同一文件
   * 的两次打开」；内容变了指纹才变 —— 消费方（符号树缓存）据此判定陈旧。
   */
  const fingerprintOf = (text: string): string =>
    createHash("sha1").update(text, "utf8").digest("hex");

  /** 文件 mtime（ms）；stat 失败（文件已删）→ NaN 表示「无法比对」。 */
  const mtimeOf = async (file: string): Promise<number> => {
    try {
      return (await stat(file)).mtimeMs;
    } catch {
      // EXIT: stat 失败（文件已删 / 不可读）→ NaN 表示「无法比对」。调用方
      // 据此跳过对齐：宁可少发一次 didChange，不可按空内容误发。
      return Number.NaN;
    }
  };

  /**
   * 盘外变更对齐（spec 251「盘外变更对齐」）：无 watcher，在**发请求前**对
   * 仍打开的 uri 比对 mtime —— 变了就重读全文发 full-sync didChange。
   *
   * 预热（裸 ensureOpen）pin 住的文档需要这条：它会跨多次请求保持打开，盘上
   * 被外部改过（未经 edit_file / notifier）后 server 侧文本就陈旧了。请求级
   * 作用域打开的文档刚读过盘，mtime 相同 → 跳过（不产生冗余 didChange）。
   */
  const alignToDisk = async (file: string): Promise<void> => {
    const uri = pathToFileURL(file).href;
    const entry = openDocs.get(uri);
    if (!entry) return;
    const current = await mtimeOf(file);
    // NaN（读不到 mtime）不比对：宁可少发一次 didChange，不可误发空内容。
    if (Number.isNaN(current) || current === entry.mtimeMs) return;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      // EXIT: 文件已被删 / 不可读 → 不发 didChange，保持 server 侧现状（旧文本
      // 仍可服务），等下次打开或下次对齐再同步。
      return;
    }
    const latest = openDocs.get(uri);
    if (!latest) return; // 读盘期间被并发归零关闭
    const nextVersion = latest.version + 1;
    latest.version = nextVersion;
    latest.fingerprint = fingerprintOf(text);
    latest.mtimeMs = current;
    await connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text }],
    });
  };

  /** 归零：didClose + 丢弃打开记录与该 uri 的诊断缓存（spec 251 生命周期合同）。 */
  const closeDocument = async (uri: string): Promise<void> => {
    openDocs.delete(uri);
    // 诊断缓存同步丢弃：留着会让下一次请求读到上一轮（可能已过期）的推送。
    diagStore.delete(uri);
    await connection.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  };

  // in-flight 打开去重（与池的 inflight 三件套同形）：并发调用同文件共享
  // 一次「读盘 + didOpen」。只在 openDocs 落**已建立**的记录，半成品不进
  // ——readFile 失败即整条作废，下次调用重新来过（失败可重试）。
  const opening = new Map<string, Promise<void>>();

  const openDocument = async (file: string): Promise<void> => {
    const uri = pathToFileURL(file).href;
    if (openDocs.has(uri)) return;
    const pending = opening.get(uri);
    if (pending) return pending;
    const task = (async () => {
      const text = await readFile(file, "utf8");
      const mtimeMs = await mtimeOf(file);
      openDocs.set(uri, {
        version: 1,
        refs: 0,
        pinned: false,
        fingerprint: fingerprintOf(text),
        mtimeMs,
      });
      await connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: languageIdFor(file),
          version: 1,
          text,
        },
      });
    })().finally(() => {
      opening.delete(uri);
    });
    opening.set(uri, task);
    return task;
  };

  const ensureOpen = async (file: string): Promise<void> => {
    const uri = pathToFileURL(file).href;
    const existing = openDocs.get(uri);
    if (existing) {
      // 已打开 → 只标 pin（warmup 语义：打开即目的，不随作用域关闭）。
      existing.pinned = true;
      return;
    }
    await openDocument(file);
    const opened = openDocs.get(uri);
    if (opened) opened.pinned = true;
  };

  const withDocumentOpen = async <T>(
    file: string,
    fn: () => Promise<T>
  ): Promise<T> => {
    const uri = pathToFileURL(file).href;
    // 占位（refs++）与在册判定必须落在同一 tick：`await openDocument` 让出
    // 期间条目可能被 last-exit 关闭（closeDocument 在同步段 delete），此后再
    // `get` 会拿到 undefined。循环重开直到真正持有一个 ref 才进 fn —— S16
    // 「重叠作用域内文档始终处于打开态」是结构性保证，不靠单点 if 兜底。
    let entry = openDocs.get(uri);
    while (!entry) {
      await openDocument(file);
      entry = openDocs.get(uri);
    }
    entry.refs += 1;
    try {
      // 请求前对齐（spec 251）：openDocument 现读盘时 mtime 已同步，对齐
      // 只在「复用一个更早打开、期间被盘外改过」的文档时才真发 didChange。
      // 放在占位之后：对齐自身的 await 不再给 last-exit 关闭我们持有的文档
      // 的机会，对齐抛错也走 finally 归零（不泄漏打开状态）。
      await alignToDisk(file);
      return await fn();
    } finally {
      // fn 抛错也归零（try/finally）：timeout / RPC error / ToolExecutionError
      // 都不得泄漏打开状态。释放按**捕获的 entry 身份**（而非重新 get）：
      // 条目若已被别的 scope 重开成新对象，身份不符则不误关。
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs === 0 && !entry.pinned && openDocs.get(uri) === entry) {
        await closeDocument(uri);
      }
    }
  };

  const notifyChange = async (file: string): Promise<void> => {
    const uri = pathToFileURL(file).href;
    if (!openDocs.has(uri)) {
      // 未打开 → didOpen 等价路径：现读文件即最新文本，随后立即关闭
      // （请求级语义：两次调用之间不对 server 保持打开）。server 已从
      // didOpen 拿到新内容，无需再补 didChange。
      await withDocumentOpen(file, async () => undefined);
      return;
    }
    // 已打开 → 读文件全文走 full sync didChange。readFile 失败直接 reject：
    // notifier 层已 catch（best-effort），此处保留错误原文便于 stderr 归因。
    const text = await readFile(file, "utf8");
    const mtimeMs = await mtimeOf(file);
    const current = openDocs.get(uri);
    if (!current) return; // 读盘期间被并发归零关闭 → 不再对已关闭文档发变更
    const nextVersion = current.version + 1;
    current.version = nextVersion;
    // 同步记账：server 侧文本已等于刚读到的盘上文本，指纹/mtime 一起更新，
    // 否则下一次请求的对齐会重复发同一次 didChange。
    current.fingerprint = fingerprintOf(text);
    current.mtimeMs = mtimeMs;
    await connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text }],
    });
  };

  const client: LspClient = {
    connection,
    process: child,
    // vscode-jsonrpc `sendRequest(method, ...args)` 靠实参数目推断参数结构：
    // 若传 3 个实参（params + token），即便 token 为 undefined，`numberOfParams=2`
    // 也会把 named params 包成位置数组 `[params, null]` 发出 → tsserver 返回
    // -32602 "defines parameters by name but received parameters by position"。
    // token 仅在确实存在时作为第 3 个实参传入。
    sendRequest: (method, params, token) =>
      connection.sendRequest(
        method,
        params,
        ...(token !== undefined ? [token] : [])
      ),
    sendNotification: (method, params) =>
      connection.sendNotification(method, params),
    getDiagnostics: (uri: string) => diagStore.get(uri)?.items,
    getDiagnosticsEntry: (uri: string) => diagStore.get(uri),
    getOpenVersion: (uri: string) => openDocs.get(uri)?.version,
    getDocumentFingerprint: (uri: string) => openDocs.get(uri)?.fingerprint,
    getServerCapabilities: () => serverCapabilities,
    ensureOpen,
    withDocumentOpen,
    notifyChange,
    dispose: () => connection.dispose(),
  };

  // 进程意外退出自愈（lsp-optimization plan T1）：server 进程 crash 后死连接
  // 留在 `clients` 缓存会让会话内所有后续请求持续失败。exit 时把**本实例**
  // 占据的缓存 key 逐出，下次 getClient 自动重新 spawn。
  //   - 不进 `broken`：spawn 成功过，属可重启失败，与 spawn 失败（bin 缺失）
  //     语义不同；
  //   - guard `clients.get(key) === client`：逐出后若已 respawn 出新 client，
  //     旧进程迟到的 exit 不得把新 client 一并逐出；
  //   - dispose()（主动关闭）后进程若退出，逐出是幂等无害的（缓存本就该
  //     释放），无需区分主动/意外退出。
  child.once("exit", () => {
    pool.evictCachedClient(key, client);
  });

  return client;
}

/**
 * 把 Node.js `AbortSignal` 桥接到 vscode-jsonrpc `CancellationToken` —
 * 用 `CancellationTokenSource` 包一层:signal abort 时 cancel source,
 * source token 在 vscode-jsonrpc 内部被 cancel 时自动发 `$/cancelRequest`。
 *
 * 用法：handler 拿到 executor 透传的 `ctx.signal`,通过本 helper 转 token
 * 传给 `client.sendRequest`;这样 `interruptBehavior: "cancel"` 的 LSP 工
 * 具中断真正走 JSON-RPC 取消通道(Q2/A9),不杀 tsserver。
 */
export function signalToCancellationToken(signal: AbortSignal): {
  token: CancellationToken;
  dispose: () => void;
} {
  const source = new CancellationTokenSource();
  const onAbort = (): void => {
    source.cancel();
  };
  if (signal.aborted) {
    source.cancel();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    token: source.token,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

/**
 * JSON-RPC 的 `-32601 MethodNotFound` 码。各语言 server 对未实现的 provider
 * 返回该码（vscode-languageserver 框架兜底文案 `Unhandled method <m>`）。
 */
export const METHOD_NOT_FOUND = -32601;

/**
 * method → `initialize` capabilities 里的 provider 字段名（spec 251
 * 「initialize 能力广告」）。挂载点不限 textDocument 前缀：`workspace/symbol`
 * 打在 `workspaceSymbolProvider`，按 method 全名查表即可。表外的 method
 * （如 `callHierarchy/incomingCalls` —— provider 只在 prepareCallHierarchy
 * 一步声明）一律照发。
 */
const METHOD_CAPABILITY_KEYS: Record<string, string> = {
  "textDocument/definition": "definitionProvider",
  "textDocument/references": "referencesProvider",
  "textDocument/hover": "hoverProvider",
  "textDocument/documentSymbol": "documentSymbolProvider",
  "textDocument/implementation": "implementationProvider",
  "textDocument/rename": "renameProvider",
  "textDocument/prepareCallHierarchy": "callHierarchyProvider",
  "textDocument/typeDefinition": "typeDefinitionProvider",
  "textDocument/declaration": "declarationProvider",
  "textDocument/signatureHelp": "signatureHelpProvider",
  "textDocument/codeAction": "codeActionProvider",
  "textDocument/foldingRange": "foldingRangeProvider",
  "textDocument/selectionRange": "selectionRangeProvider",
  "textDocument/documentHighlight": "documentHighlightProvider",
  "textDocument/semanticTokens/full": "semanticTokensProvider",
  "textDocument/inlayHint": "inlayHintProvider",
  "textDocument/inlineValue": "inlineValueProvider",
  "textDocument/diagnostic": "diagnosticProvider",
  "workspace/symbol": "workspaceSymbolProvider",
};

/**
 * server 是否**显式声明**不支持该 method（capabilities 里对应 provider 为
 * `false`）。**缺席 ≠ 不支持** —— typescript-language-server 实测不声明
 * `callHierarchyProvider` 却实现了 call hierarchy；据此裁剪会误伤 TS 的
 * 10/10 保真面（probe 亦以 MethodNotFound-skip 而非声明裁剪为纪律）。
 * 只有显式 `false` 才是「确定没有，不必发」。
 */
export function serverDeclaresUnsupported(
  capabilities: Record<string, unknown>,
  method: string
): boolean {
  const key = METHOD_CAPABILITY_KEYS[method];
  if (key === undefined) return false;
  return capabilities[key] === false;
}

/**
 * 判定 RPC 错误是否为「server 未实现该方法」—— 即能力缺口，而非请求失败、
 * 更不是 spawn 失败。命中后调用方转 Y1 哨兵（模型可读纯字符串），
 * **不得**写 broken / 逐出 client（连接与进程都好好的，别的 method 照样用）。
 *
 * 主判据是数字码（稳定）；文案前缀是给不经 vscode-jsonrpc 包装的错误兜底。
 */
export function isMethodNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === METHOD_NOT_FOUND) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && message.startsWith("Unhandled method ");
}

/**
 * 取消一个 in-flight 请求 —— 走 JSON-RPC `$/cancelRequest` 通知。
 *
 * **绝不终止 tsserver 子进程**（Q2/A9 决议）：终止会破坏常驻复用、
 * 并让后续请求失去共享连接。取消信号由 tsserver 自行处理。
 *
 * @param client 目标客户端（其 `connection` 发送取消通知）。
 * @param reqId 要取消的请求 id（vscode-jsonrpc 分配的 id）。
 */
export function cancelRequest(client: LspClient, reqId: number): Promise<void> {
  return client.connection.sendNotification("$/cancelRequest", {
    id: reqId,
  });
}
