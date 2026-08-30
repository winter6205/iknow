/**
 * LSP 客户端层类型契约 — spec 251-lsp-tool。
 *
 * 本文件定义 LSP 客户端层（`src/harness/lsp/`）的对外类型边界：
 * `server.ts`（Info 声明 + NearestRoot）与 `client.ts`（getClient 三件套）
 * 都从本文件读类型；handler 层（`aci/tools/lsp.ts`）只通过 `client.ts` 的
 * `getClient(ctx, file)` 入口间接消费 `LspCtx`。
 *
 * **不包含**:
 *   - vscode-jsonrpc 的具体 client 类型（client.ts 内部封装）；
 *   - 9 件 ACI 工具的 schema（aci/tools/lsp.ts 定义）；
 *   - tsserver 的请求/响应 payload（透传字符串/对象给 typescript-language-server）。
 *
 * 设计目的:让 `src/harness/lsp/` 是自完备的「自建 LSP 客户端」模块,
 * 装配层（build-engine.ts）只感知 `LspCtx` 一个数据结构。
 */

/**
 * LSP 客户端上下文（不可变）。build-engine.ts 装配时一次性传入,
 * 持有 directory 作为 NearestRoot 的上界 stop（spec #247 Q6）。
 *
 * 当前 iknow 是单用户单项目本机产品,directory ≡ process.cwd()。
 */
export interface LspCtx {
  /** LSP 服务根目录搜索的上界(NearestRoot 不允许跨出)。 */
  readonly directory: string;
  /**
   * per-request LSP 超时上限（毫秒，lsp-optimization 二期 B7）。缺省由工具层
   * DEFAULT_LSP_REQUEST_TIMEOUT_MS（20_000）兜底。来源：settings.lsp.requestTimeoutMs。
   */
  readonly requestTimeoutMs?: number;
  /**
   * lsp_diagnostics 读前等待 deadline（毫秒，二期 B7）。缺省由工具层
   * DIAGNOSTICS_WAIT_MS（2_000）兜底。来源：settings.lsp.diagnosticsWaitMs。
   */
  readonly diagnosticsWaitMs?: number;
  /**
   * 空闲客户端回收阈值（毫秒，二期 B7/B5）。≤0 或 undefined → 不 sweep。
   * 来源：settings.lsp.idleTimeoutMs；缺省语义（10min）由 client.ts sweep
   * 消费方在装配层决定（build-engine 注入缺省 600_000）。
   */
  readonly idleTimeoutMs?: number;
  /**
   * 禁用的 server id 列表（二期 B7）。命中的 server 在 getClientDetailed
   * 里按 no-server 处理（视为未配置）。来源：settings.lsp.disabledServers。
   */
  readonly disabledServers?: ReadonlyArray<string>;
}

/**
 * LSP server 启动配置 — server.ts 内的单语言(`Typescript`)实例
 * 的「如何 spawn + 如何解析 root」声明。
 *
 * 与 lsp.ts:80-89 Info 同构;保留扁平声明(spec #247 Q2 决议
 * 不拆 registry/spawn/client 三文件)。
 *
 * `spawn` 返回 `undefined` 时表示该 server 在当前环境下不可用
 * (tsserver bin 缺失 / typescript-language-server 二进制缺失);
 * client.ts 据此走 broken 记忆,不抛错(handler 转纯字符串
 * `"(no LSP server available)"`)。
 */
export interface LspServerInfo {
  readonly id: string;
  /** 从 file 路径向上找最近含 lockfile 的目录当 root;上界 stop=ctx.directory。 */
  readonly root: (file: string, ctx: LspCtx) => Promise<string | undefined>;
  /** 此 server 支持的文件扩展名列表(client.ts 早返优化:不在列表内的 file 拒)。 */
  readonly extensions: ReadonlyArray<string>;
  /**
   * Spawn server 子进程。返回 `{ process, initialization }` 由 client.ts
   * 包成 vscode-jsonrpc connection 并发送 initialize 请求。
   */
  readonly spawn: (
    root: string,
    ctx: LspCtx
  ) => Promise<LspServerHandle | undefined>;
  /**
   * 可读的安装提示（lsp-optimization 二期 B3）：spawn-failed 哨兵渲染时
   * 附带给模型的一句 `npm i -g <pkg>`。缺席 → 哨兵省略 hint 句。
   */
  readonly installHint?: string;
}

/** spawn 返回的 server 句柄:子进程 + initializationOptions(typescript-language-server 透传 tsserver.path)。 */
export interface LspServerHandle {
  readonly process: import("node:child_process").ChildProcess;
  /**
   * LSP initialize 握手透传的 initializationOptions（spec 302-lsp-multilang §
   * types.ts 决策1）。
   *
   * 原（spec 251）必填 `{ tsserver: { path } }` 仅适用 TS 单语言；多语言后按
   * server 各自声明——pyright 透传 `{ pythonPath }`，yaml/json/dockerfile 无
   * 必需初始化（省略合法）。泛化可选项后现有 TS fixture 零迁移。
   */
  readonly initialization?: Record<string, unknown>;
}
