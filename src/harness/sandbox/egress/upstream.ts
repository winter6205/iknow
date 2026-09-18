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
 * egress-credential-sentinel T2 / SC10：domain-pattern 匹配器收口。
 * `domain-matcher.ts` 是既有深路径 import 点，按 0097「文件承载纪律」并入
 * 本适配层，使 `src/` 的包深路径 import 只剩 upstream.ts 一处。
 */
export { matchesDomainPatternWithPort } from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";

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
 * `normalizePathForSandbox` = 凭据条目 path 的 tilde 展开 + realpath 归一，
 * T2 文件预检（F2/F3）与包内 masking 用同一归一形态，deny/binding 落点对齐。
 */
export {
  CA_TRUST_VARS,
  normalizePathForSandbox,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";

/**
 * egress-credential-sentinel T2（Assumption 3 收口纪律）：sentinel 铸造与
 * 掩码流程件 —— `SentinelRegistry`（假值空间，per-session）、
 * `buildMaskedEnvVars` / `buildMaskedFileBinds`（env / 文件掩码流程）。
 * 本仓偏离点集中在装配层入参：`onExtractNoMatch` 显式传 `"deny"`
 * （Assumption 8，不吃包默认 `"warn"` fail-open）；`allowedDomains` 入参
 * 恒传 `[]`（Assumption 6，条目 injectHosts 必为显式值，不吃缺省扩张）。
 * 非 UTF-8 / 二进制的包内行为是静默 skip（fail-open），本仓在调用前
 * 预检并降级 deny —— 见 `credential-assembly.ts`。
 */
export {
  SentinelRegistry,
  SENTINEL_PREFIX,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/credential-sentinel.js";

export {
  buildMaskedEnvVars,
  type MaskedEnvBuildResult,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/credential-mask-env.js";

export {
  buildMaskedFileBinds,
  MaskedFileStore,
  type MaskedFileBind,
  type MaskedFileBuildResult,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/credential-mask-files.js";

export type {
  CredentialEnvVarConfig,
  CredentialFileConfig,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.js";
