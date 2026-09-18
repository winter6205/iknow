/**
 * src/harness/sandbox/egress/upstream.ts
 *
 * T4 上游适配层（specs/network-egress-allowlist.md §Dependency fork「文件承载
 * 纪律」：版本升级只改这一文件，不外溢）。
 *
 * 单一职责：把 `@anthropic-ai/sandbox-runtime` 的网络半场件集中在该层 re-export
 * —— 本仓其它模块（包括 domain-matcher / session / bwrap）均不得直接
 * import 包内路径。
 *
 * 复用面（spike 结论，0.0.76）：
 *   - http-proxy / socks-proxy：代理 server，filter 回调语义对称；
 *   - domain-pattern（已被 domain-matcher.ts 消费）、address、parent-proxy
 *     已在对应适配层 re-export；本文件只补「session 装配期需要」的件。
 *
 * 包无 `exports` 字段（实测），深路径导入可用但无契约稳定性 —— 升级时
 * 全部 import 收口到此文件。
 */

export {
  createHttpProxyServer,
  type HttpProxyServerOptions,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js";

// SOCKS5 / git-over-SOCKS 不在 T4 范围（T7/T8 形态扩展时按 mux 形态补）。
// 仍在此文件 re-export 一份以备未来用，避免新增 import 直接打到包内路径。
export {
  createSocksProxyServer,
  type SocksProxyServerOptions,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/socks-proxy.js";

export {
  createResolvedAddressGuard,
  isResolvedAddressDenied,
  ResolvedAddressDeniedError,
  type ResolvedAddressGuard,
  type ResolvedAddressGuardOptions,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js";

/**
 * egress-credential-sentinel T4（Assumption 3 收口纪律）：MITM CA 件 ——
 * `createMitmCA({caCertPath, caKeyPath})` 装载持久 CA 并**顺带现写 trust
 * bundle**（`trustBundlePath` = 包内 writeTrustBundle 的产物，每次调用新
 * temp 文件；只含 CERTIFICATE 块的 PEM 过滤在包内，mitm-ca.js:166-175，
 * 本仓不复刻）。`generateCa` 是纯生成原语（无 FS 副作用），持久层落盘
 * 归本仓 `ca-store.ts`。`disposeMitmCA` 归 T3 dispose 接线时再收口。
 */
export {
  createMitmCA,
  generateCa,
  validateCaPair,
  type CaPairValidation,
  type GeneratedCa,
  type MitmCA,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js";

/**
 * 信任注入名册全集（Assumption 11：env 注入面 = 该 roster 全量，值指向
 * trust bundle）。逐客户端三臂常量在 `ca-store.ts` 另行钉死。
 */
export { CA_TRUST_VARS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
