/**
 * src/harness/sandbox/egress/assembly.ts
 *
 * ADR-0097 / T7 生产装配 helper —— 从 `loadIknowSettings()` 读
 * `isolation.network.{allowedDomains,deniedDomains}` 装配 `EgressPolicyInput`。
 *
 * 单一职责：装配层一处把「settings → EgressPolicyInput」收口,所有调用
 * 面（bash 工厂 / background / verify）共用同一形状。egress 域自身不
 * 反向 import config（依赖注入形态,egress/session.ts 同款纪律）。
 *
 * 设计要点:
 *   - 工厂返回 `() => EgressPolicyInput | undefined`:bash handler 内部
 *     每次调用取一次最新 settings（settings 不变即可;hot-reload 由
 *     loadIknowSettings 的读根决定）;undefined = 本次调用不起 session
 *     （spec §fail-closed,纯断网）;
 *   - `commandLabel` 由调用方传（bash / background / verify 各自有
 *     自己的语义上下文,如 `bash:foreground` / `background:<taskId>`
 *     / `verify:<round>`）;
 *   - `allowlistSource` 仅当 settings 段在场 = `"preset"`(用户层预置
 *     配置);无 network 段 = undefined(不伪造来源);
 *   - `askApproval` **不**在这里注入 gate（`approvalGate` 由 bash 工
 *     厂闭包期构造,跨调用共享同一会话级集,见 bash.ts:523-556）;
 *     helper 只透传数据,装配链 `build-engine → registry → createBashTool`
 *     在 bash.ts 内部完成 gate 接续。
 */
import type {
  IknowSettings,
  IknowSettingsIsolationNetwork,
} from "../../../config/settings.js";
import {
  assembleEgressCredentials,
  noFenceCredentialTrace,
  type EgressCredentialRoster,
} from "./credential-assembly.js";
import type { EgressPolicyInput } from "./session.js";

/**
 * 工厂入参 —— 由调用面(build-engine / 装配层)按需注入。
 *
 * - `settings`:可由调用方预读 settings(避免在工厂内同步 I/O;
 *   build-engine 主链已有 settings 注入缝 `opts.settings`);
 * - `commandLabel`:每次调用固定(prefix by 形态 + identifier)。
 *
 * 注:helper 不接收 `askApproval` —— bash 工厂侧
 * (`effectiveEgressPolicyFactory` in bash.ts:548-556) 才是构造
 * `EgressApprovalGate` 的归属,本 helper 只承担 settings → 数据
 * 形状的映射,避免与 bash.ts 装配重复导致双层 gate。
 */
export interface CreateEgressPolicyFactoryOptions {
  readonly settings: IknowSettings;
  readonly commandLabel: string;
  /**
   * egress-credential-sentinel T1：拒铸留痕通道（无 injectHosts 条目的
   * warn 痕，invariant 7 禁静默）。缺省 = 静默跳过（调用面不关心时）。
   */
  readonly onWarn?: (message: string) => void;
}

/**
 * 构造 `egressPolicyFactory` —— 装给 `createBashTool({ egressPolicyFactory })`
 * 或 `BackgroundSpawnRequest.egressPolicy` 之类调用面。
 *
 * 返回形态:`() => EgressPolicyInput | undefined`,每次调用读一次
 * `settings.isolation.network`(若 settings 不可变则等价于闭包常量)。
 *
 * fail-closed 语义:
 *   - settings.isolation.network 缺席 → 返回 undefined = 本次调用不起
 *     session,沙箱内 `--unshare-net` 照旧在,等同纯断网;
 *   - settings.isolation.network 在场但 allow/deny 均为空数组(合法
 *     fail-closed 态,经 settings 层判定层全拒)→ 返回 policy 形态,
 *     由 domain-matcher 决定全拒(不让工厂吞掉);
 *   - settings.isolation.network 段 shape 非法(非普通对象 / 数组形态
 *     错误)→ 由 settings 层丢弃,settings.isolation.network = undefined,
 *     回到「无配置 = 无 session」路径。
 *
 * allowlistSource 语义(对齐 T6 EgressPolicyInput.allowlistSource 透传):
 *   - 有 network 配置 = "preset"(用户层预置,持久化于 user settings);
 *     「会话级放行」(批准流产物)与「持久化」(写回 user settings)是不同
 *     来源;前者由 bash 工厂的 approvalGate 决定(`allowlistSource: "session"`),
 *     不在本 helper 出现。本 helper 只反映「settings 段在场」这一事实。
 *
 * 独立成文件(s5 complexity 门):装配 helper 后续可能扩(读 host /
 * 校验 allowlist 与 deny 集互斥等),独立承载便于改动只影响一处。
 */
export function createEgressPolicyFactory(
  opts: CreateEgressPolicyFactoryOptions
): () => EgressPolicyInput | undefined {
  const { settings, commandLabel, onWarn } = opts;
  // 读 settings 一次（settings 在 build-engine 主链是 module-load 期
  // resolve 的 freeze 对象,跨调用安全;hot-reload 由调用方重造工厂）
  // —— 此处取一次网络段缓存到闭包,fail-closed 缺省 = 直接返 undefined。
  const network = settings.isolation?.network;
  // egress-credential-sentinel T1：凭据名册装配（内置 github 两条目 + 用户段
  // 收窄/追加）。凭据段**不**开启 session —— network 缺席仍是 fail-closed
  // 纯断网（下方 undefined 分支优先），credentials 只随 policy 数据形状走。
  const credentials = assembleEgressCredentials(
    settings.isolation?.credentials,
    onWarn
  );

  if (network === undefined) {
    // 无 network 配置 → 本次调用不起 session,fence 走纯断网。
    // 这是 spec 要求的 fail-closed 合法态,不是缺陷:settings 段缺席
    // = 用户未声明出网边界 = 默认拒绝。
    // T6 / F9（Assumption 9）：出网缝与凭据层整体缺席的姿态显式登记 ——
    // canonical `skipped: no-fence` 痕进诊断/日志（invariant 7 禁静默，
    // 离线可查证「无存在面保护」），SC9 反命门闭合。
    const onDiagnostic =
      onWarn ?? ((m: string): void => { console.warn(m); });
    onDiagnostic(noFenceCredentialTrace());
    return () => undefined;
  }

  // 构造 policy —— 用 freeze 后的 settings 段直接派发（settings.ts
  // 段已深 frozen,reference safe）。`deniedResolvedAddresses` 留
  // undefined,让 session.ts 内部走 `DEFAULT_PRIVATE_DENIED_RANGES`
  // 默认私网拒档(spec §SC4 验收前提)。
  return (): EgressPolicyInput =>
    buildEgressPolicy(network, commandLabel, credentials);
}

/**
 * 把 `IknowSettingsIsolationNetwork` 段映射成 `EgressPolicyInput`。
 *
 * 独立成函数(s5 complexity 门):settings 段在场 → policy 形状构造逻辑
 * 收敛,工厂主体只剩「无配置 = undefined」一支,复杂度低。
 *
 * `allowlistSource = "preset"`(用户层 settings 段在场即视为 preset,
 * 与 T6 spec 语义对齐)。bash 工厂侧在批准后会改写为 `"session"`
 * (bash.ts:540-543)。
 */
function buildEgressPolicy(
  network: IknowSettingsIsolationNetwork,
  commandLabel: string,
  credentials: EgressCredentialRoster
): EgressPolicyInput {
  return {
    allowedDomains: network.allowedDomains ?? [],
    deniedDomains: network.deniedDomains ?? [],
    commandLabel,
    // settings 段在场 → 允许集来源 = 预置配置(spec §批准持久化粒度:
    // 用户层 settings 是"预置配置"路径;会话级批准由 bash 工厂的
    // approvalGate 决定,不在本 helper 范围内)。
    allowlistSource: "preset",
    // T1 数据形状注入：铸造消费归 T2，本层不参与判定。
    credentials,
  };
}
