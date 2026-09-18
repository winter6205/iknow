/**
 * src/harness/sandbox/egress/assembly.ts
 *
 * ADR-0097 / T7 生产装配 helper + ADR-0104 预放行档合并语义 ——
 * 从 `loadIknowSettings()` 读 `isolation.network.{allowedDomains,deniedDomains}`
 * 并与代码承载 preset（preset-domains.ts，清单 SSOT）装配 `EgressPolicyInput`。
 *
 * 单一职责：判定输入构造只发生在 assembly 一处（spec invariant 2），所有调用
 * 面（bash 工厂 / background / verify）共用同一形状。egress 域自身不
 * 反向 import config（依赖注入形态，egress/session.ts 同款纪律）。
 *
 * 设计要点:
 *   - 工厂返回 `() => EgressPolicyInput | undefined`:bash handler 内部
 *     每次调用取一次最新 settings（settings 不变即可;hot-reload 由
 *     loadIknowSettings 的读根决定）;生产装配路径**恒返 policy**
 *     （preset 非空 ⇒「允许集非空」恒真，闭合 ADR-0097 §生命周期表与
 *     实现的既有落差，ADR-0104 §Consequences）;`undefined` 分支仅保留给
 *     调用方显式不装配 egress 的测试 / yolo 类豁免路径，不再由
 *     「settings 段缺席」触发（spec invariant 3）;
 *   - `commandLabel` 由调用方传（bash / background / verify 各自有
 *     自己的语义上下文,如 `bash:foreground` / `background:<taskId>`
 *     / `verify:<round>`）;
 *   - `allowlistSource`:settings 段缺席 = `"builtin"`（仅出厂预放行档
 *     在场）;段在场 = `"persisted"`（用户持久化 settings 增量并入档）;
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
  type EgressCredentialRoster,
} from "./credential-assembly.js";
import type { EgressPolicyInput } from "./session.js";
import { BUILTIN_PRESET_ALLOWED_DOMAINS } from "./preset-domains.js";

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
 * 签名保持 `| undefined` 不缩 —— background / verify 消费面类型零改动。
 *
 * 合并语义(ADR-0104 §Decision 2, spec T1):
 *   - 段缺席 → preset-only policy(`allowlistSource: "builtin"`,
 *     deniedDomains 空)—— session 必起,首见批准门在岗;
 *   - 段在场 → `allowedDomains = 去重(preset ∪ 用户 allowedDomains)`
 *     (preset 前置、用户增量在后),`deniedDomains` 只取用户层,
 *     `allowlistSource: "persisted"`;deny 优先不变(用户可用 denied
 *     精确砍掉任一 preset 域);
 *   - 段在场但两列表皆空 → 同「在场」路径(preset 仍在场,不缩档;
 *     `allowlist-empty` 经工厂路径不可达,spec F2);
 *   - 段 shape 非法被 settings 层丢弃 → `network = undefined`,回到
 *     「段缺席」路径 = preset-only(spec F3,丢弃留痕纪律在 settings 层)。
 *
 * 独立成文件(s5 complexity 门):装配 helper 后续可能扩(读 host /
 * 校验 allowlist 与 deny 集互斥等),独立承载便于改动只影响一处。
 */
export function createEgressPolicyFactory(
  opts: CreateEgressPolicyFactoryOptions
): () => EgressPolicyInput | undefined {
  const { settings, commandLabel, onWarn } = opts;
  // 读 settings 一次（settings 在 build-engine 主链是 module-load 期
  // resolve 的 freeze 对象,跨调用安全;hot-reload 由调用方重造工厂）。
  // 段缺席 / 被 parse 层丢弃 → preset-only,不再返 undefined
  // （ADR-0104:preset 非空 ⇒ 生产装配路径恒起 egress session）。
  const network = settings.isolation?.network;
  // egress-credential-sentinel T1：凭据名册装配（内置 github 两条目 + 用户段
  // 收窄/追加）。凭据段自身不决定 session 起停 —— preset 非空使生产装配
  // 恒起 session（ADR-0104 / ADR-0107），credentials 只随 policy 数据形状走。
  const credentials = assembleEgressCredentials(
    settings.isolation?.credentials,
    onWarn
  );

  if (network === undefined) {
    // 段缺席 → preset-only policy（spec invariant 3：不再返 undefined）。
    // fence 在场（preset 窄集），凭据铸造随 session 走 fenced 档；
    // no-fence 痕只归 yolo / isolation OFF 接线方（credential-assembly T6
    // 姿态分支），本分支不再登记。
    return (): EgressPolicyInput => ({
      allowedDomains: [...BUILTIN_PRESET_ALLOWED_DOMAINS],
      deniedDomains: [],
      commandLabel,
      allowlistSource: "builtin",
      credentials,
    });
  }

  // 构造 policy —— 用 freeze 后的 settings 段直接派发（settings.ts
  // 段已深 frozen,reference safe）。`deniedResolvedAddresses` 留
  // undefined,让 session.ts 内部走 `DEFAULT_PRIVATE_DENIED_RANGES`
  // 默认私网拒档(spec §SC4 验收前提)。
  return (): EgressPolicyInput =>
    buildEgressPolicy(network, commandLabel, credentials);
}

/**
 * 把 `IknowSettingsIsolationNetwork` 段映射成 `EgressPolicyInput`
 * （段在场路径）。
 *
 * 独立成函数(s5 complexity 门):settings 段在场 → policy 形状构造逻辑
 * 收敛,工厂主体只剩「无配置 = preset-only」一支,复杂度低。
 *
 * `allowlistSource = "persisted"`(用户持久化 settings 增量并入档,
 * spec T2 钉死表)。bash 工厂侧在批准后会改写为 `"session"`
 * (bash.ts:540-543)。
 */
function buildEgressPolicy(
  network: IknowSettingsIsolationNetwork,
  commandLabel: string,
  credentials: EgressCredentialRoster
): EgressPolicyInput {
  return {
    allowedDomains: mergeWithPreset(network.allowedDomains ?? []),
    // deny 只取用户层 —— preset 不贡献 deny,deny 优先是用户砍 preset
    // 域的逃生通道(spec Boundaries「不可被用户配置关闭整个档」的对偶)。
    deniedDomains: network.deniedDomains ?? [],
    commandLabel,
    allowlistSource: "persisted",
    // T1 数据形状注入：铸造消费归 T2，本层不参与判定。
    credentials,
  };
}

/**
 * 去重合并:preset 前置、用户增量在后(便于人读;顺序即语义,ADR-0104
 * §Decision 2)。字面精确去重 —— settings 层已做 trim/形态清洗,此处不
 * 再做大小写归一(判定层 decideEgress 对 host 归一,entry 形态保持原样)。
 */
function mergeWithPreset(userAllowed: readonly string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...BUILTIN_PRESET_ALLOWED_DOMAINS, ...userAllowed]) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged;
}
