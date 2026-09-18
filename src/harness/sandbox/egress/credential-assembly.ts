/**
 * src/harness/sandbox/egress/credential-assembly.ts
 *
 * specs/egress-credential-sentinel.md T1 —— 凭据名册 SSOT + 装配。
 *
 * 单一职责：内置 github 名册（代码常量，spec 凭据名册表逐字）+ 用户层
 * `isolation.credentials` 段的收窄/追加合并，产出 `EgressCredentialRoster`
 * 纯数据形状。铸造 / 代换 / CA 归 T2–T4，本层只钉数据形状。
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

function identity(entry: { readonly path?: string; readonly name?: string }): string {
  return entry.path ?? entry.name ?? "(unidentified)";
}

/** 收窄/追加合并：同身份（path / name）条目就地替换，其余追加。 */
function mergeEntries<T extends { readonly path?: string; readonly name?: string }>(
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
