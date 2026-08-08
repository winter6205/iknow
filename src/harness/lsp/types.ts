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
}

/**
 * LSP server 启动配置 — server.ts 内的单语言(`Typescript`)实例
 * 的「如何 spawn + 如何解析 root」声明。
 *
 * 与 opencode lsp.ts:80-89 Info 同构;保留扁平声明(spec #247 Q2 决议
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
}

/** spawn 返回的 server 句柄:子进程 + initializationOptions(typescript-language-server 透传 tsserver.path)。 */
export interface LspServerHandle {
  readonly process: import("node:child_process").ChildProcess;
  /** typescript-language-server 透传给 tsserver 的初始化参数(spec §S server.ts 范例)。 */
  readonly initialization: { readonly tsserver: { readonly path: string } };
}
