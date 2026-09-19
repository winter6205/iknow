/**
 * src/harness/sandbox/egress/credential-assembly.ts
 *
 * specs/egress-credential-sentinel.md T1 + T6 —— 凭据名册 SSOT + 装配 +
 * 入口姿态分支。
 *
 * 单一职责：内置 github 名册（代码常量，spec 凭据名册表逐字）+ 用户层
 * `isolation.credentials` 段的收窄/追加合并，产出 `EgressCredentialRoster`
 * 纯数据形状；T6 入口以姿态分支委托铸造（`credential-mint.ts`，T2）或
 * 登记 skipped 痕。铸造实现（registry 假值 / masked store / bind 表 /
 * fence env 增量 + invariant 1/6 装配期 assert）在 `credential-mint.ts`；
 * 代换接线 / dispose 归 T3（`session.ts`），CA 持久层归 T4（`ca-store.ts`）。
 *
 * 依赖纪律：本域不反向 import config —— 用户段以结构化入参
 * （`UserCredentialSection`）注入，settings 侧条目类型与之结构兼容。
 *
 * invariant 3（洗出防护）在签名面的体现：装配函数只吃「内置常量 + 用户段」
 * 两源，**没有** allowedDomains / 批准集入参 —— 批准门新批域在类型上就
 * 进不了任何条目的 injectHosts。
 *
 * Assumption 6（injectHosts 静态钉）：条目未声明 / 空 injectHosts →
 * 不铸造该条目 + warn 痕（不吃包「缺省 = 全部 allowedDomains」的
 * trade-off；settings 层已把此类条目丢弃，本层防御直连调用方，禁静默）。
 */

import {
  mintEgressCredentials,
  type EgressCredentialMint,
  type MintEgressCredentialsArgs,
} from "./credential-mint.js";

/** 单条凭据文件条目（egress 侧数据形状）。 */
export interface EgressCredentialFileEntry {
  readonly path: string;
  /** 提取正则源串，含捕获组 1（组 1 = 被掩码的凭据值）。 */
  readonly extract?: string;
  readonly decode?: "jwt";
  readonly injectHosts: readonly string[];
}

/** 单条凭据 env 变量条目（whole-value 掩码形态）。 */
export interface EgressCredentialEnvVarEntry {
  readonly name: string;
  readonly injectHosts: readonly string[];
}

/** 装配产物：铸造消费的条目全集（内置 + 用户收窄/追加后）。 */
export interface EgressCredentialRoster {
  readonly files: readonly EgressCredentialFileEntry[];
  readonly envVars: readonly EgressCredentialEnvVarEntry[];
}

/**
 * 用户段入参形态 —— 与 `IknowSettingsIsolationCredentials` 结构兼容
 * （mutable string[] 可赋 readonly string[]），避免 egress 域 import config。
 */
export interface UserCredentialSection {
  readonly files?: readonly EgressCredentialFileEntry[];
  readonly envVars?: readonly EgressCredentialEnvVarEntry[];
}

/** github 条目静态注入域（spec 凭据名册表逐字；Assumption 6 钉死不扩张）。 */
const GITHUB_INJECT_HOSTS: readonly string[] = Object.freeze([
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
]);

function deepFreezeRoster<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreezeRoster((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * 内置 github 名册（SSOT 单文件；宿主 env `GH_TOKEN` + `gh` hosts.yml）。
 * hosts.yml 条目 = structured extract 掩码：YAML `oauth_token:` 捕获组 1，
 * 文件其余字节逐字保留（gh 解析不炸）。
 */
export const BUILTIN_GITHUB_CREDENTIAL_ROSTER: EgressCredentialRoster =
  deepFreezeRoster({
    files: [
      {
        path: "~/.config/gh/hosts.yml",
        extract: "oauth_token:\\s*(\\S+)",
        injectHosts: GITHUB_INJECT_HOSTS,
      },
    ],
    envVars: [
      {
        name: "GH_TOKEN",
        injectHosts: GITHUB_INJECT_HOSTS,
      },
    ],
  });

/** injectHosts 可铸造判据：非空数组且每项非空串（Assumption 6 显式值）。 */
function isMintable(entry: unknown): boolean {
  const hosts = (entry as { readonly injectHosts?: unknown }).injectHosts;
  return (
    Array.isArray(hosts) &&
    hosts.length > 0 &&
    hosts.every((h) => typeof h === "string" && h.trim().length > 0)
  );
}

function identity(entry: {
  readonly path?: string;
  readonly name?: string;
}): string {
  return entry.path ?? entry.name ?? "(unidentified)";
}

/** 收窄/追加合并：同身份（path / name）条目就地替换，其余追加。 */
function mergeEntries<
  T extends { readonly path?: string; readonly name?: string },
>(
  builtin: readonly T[],
  incoming: readonly T[],
  onWarn: ((message: string) => void) | undefined,
  list: "files" | "envVars"
): T[] {
  const out = [...builtin];
  for (const entry of incoming) {
    if (!isMintable(entry)) {
      onWarn?.(
        `[egress] credential ${list} entry "${identity(entry)}" not minted: missing or empty injectHosts (no allowedDomains default)`
      );
      continue;
    }
    const key = identity(entry);
    const idx = out.findIndex((e) => identity(e) === key);
    if (idx === -1) out.push(entry);
    else out[idx] = entry;
  }
  return out;
}

/**
 * 装配铸造消费的凭据名册：内置 github 两条目为基线，用户段只做
 * 收窄（同身份条目替换）/ 追加（新条目）。用户段缺席 → 直接返回内置
 * 常量（引用稳定，跨 session 只读共享）。产物深 frozen。
 */
export function assembleEgressCredentials(
  userSection: UserCredentialSection | undefined,
  onWarn?: (message: string) => void
): EgressCredentialRoster {
  if (userSection === undefined) return BUILTIN_GITHUB_CREDENTIAL_ROSTER;
  const files = mergeEntries(
    BUILTIN_GITHUB_CREDENTIAL_ROSTER.files,
    userSection.files ?? [],
    onWarn,
    "files"
  );
  const envVars = mergeEntries(
    BUILTIN_GITHUB_CREDENTIAL_ROSTER.envVars,
    userSection.envVars ?? [],
    onWarn,
    "envVars"
  );
  if (
    files.length === BUILTIN_GITHUB_CREDENTIAL_ROSTER.files.length &&
    envVars.length === BUILTIN_GITHUB_CREDENTIAL_ROSTER.envVars.length &&
    files.every((f, i) => f === BUILTIN_GITHUB_CREDENTIAL_ROSTER.files[i]) &&
    envVars.every((e, i) => e === BUILTIN_GITHUB_CREDENTIAL_ROSTER.envVars[i])
  ) {
    // 用户段未产生任何有效变化（全被拒铸）→ 回到内置常量。
    return BUILTIN_GITHUB_CREDENTIAL_ROSTER;
  }
  return deepFreezeRoster({ files, envVars });
}

// ── T6：装配入口姿态分支（yolo / isolation OFF → 不铸造、不注入）──────────

/**
 * 围栏姿态（spec F9 / Assumption 9）：`fenced` = 正常铸造档；
 * `no-fence` = yolo / isolation OFF（围栏整体退场）—— 入口显式分支
 * 「不铸造、不注入」，返回 `skipped` 痕进诊断/日志，离线可查证
 * 「此时宿主真值直达、无存在面保护」。姿态差异显式登记，不静默。
 */
export type EgressFencePosture = "fenced" | "no-fence";

/** `no-fence` 档产物：skipped 标记即离线判据（无 registry/store/envVars）。 */
export interface EgressCredentialSkipped {
  readonly skipped: "no-fence";
}

/** 入口返回联合：消费方必须显式处理 skipped 档（禁静默降级）。 */
export type EgressCredentialLayer = EgressCredentialMint | EgressCredentialSkipped;

/** `fenced` 档入参 = T2 铸造入参 + 姿态声明。 */
export interface MintEgressCredentialLayerFencedArgs
  extends MintEgressCredentialsArgs {
  readonly posture: "fenced";
  readonly onDiagnostic?: (message: string) => void;
}

/** `no-fence` 档入参：结构上不吃 roster / CA —— 不铸造无从消费真值。 */
export interface MintEgressCredentialLayerNoFenceArgs {
  readonly posture: "no-fence";
  readonly onDiagnostic?: (message: string) => void;
}

export type MintEgressCredentialLayerArgs =
  | MintEgressCredentialLayerFencedArgs
  | MintEgressCredentialLayerNoFenceArgs;

/**
 * no-fence 痕文案 SSOT —— 入口（yolo 接线方）与装配层
 * （`createEgressPolicyFactory` isolation OFF 分支）共用一条 canonical
 * 串，离线 grep `skipped: no-fence` 即可查证姿态。文案不含任何凭据材料。
 */
export function noFenceCredentialTrace(): string {
  return (
    `[egress-credential] skipped: no-fence — credential layer not minted and ` +
    `not injected; with the fence absent host real values reach children ` +
    `directly with no existence-plane protection (declared posture per spec ` +
    `F9 / Assumption 9 — registered, not silent)`
  );
}

/**
 * 凭据装配入口（T6）：三装配点经 `createEgressSession` 走到铸造时以
 * `fenced` 档委托 `mintEgressCredentials`（T2 形状逐字）；yolo /
 * isolation OFF 的接线方以 `no-fence` 档调用 —— 不构造 registry /
 * store、不装载 CA、不产出 env 增量，返回 `skipped` 痕并落诊断通道
 * （invariant 7 禁静默）。加性形状：ssh-bridge plan 可沿同一入口接线。
 */
export function mintEgressCredentialLayer(
  args: MintEgressCredentialLayerFencedArgs
): EgressCredentialMint;
export function mintEgressCredentialLayer(
  args: MintEgressCredentialLayerNoFenceArgs
): EgressCredentialSkipped;
export function mintEgressCredentialLayer(
  args: MintEgressCredentialLayerArgs
): EgressCredentialLayer {
  if (args.posture === "no-fence") {
    const onDiagnostic =
      args.onDiagnostic ?? ((m: string): void => console.warn(m));
    onDiagnostic(noFenceCredentialTrace());
    return Object.freeze({ skipped: "no-fence" });
  }
  return mintEgressCredentials(args);
}
