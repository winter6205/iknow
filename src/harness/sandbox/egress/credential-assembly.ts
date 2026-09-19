/**
 * src/harness/sandbox/egress/credential-assembly.ts
 *
 * specs/egress-credential-sentinel.md T1 + T2 —— 凭据名册 SSOT + 装配 +
 * 启动期铸造（假值进围栏）。
 *
 * 单一职责：内置 github 名册（代码常量，spec 凭据名册表逐字）+ 用户层
 * `isolation.credentials` 段的收窄/追加合并，产出 `EgressCredentialRoster`
 * 纯数据形状；T2 起本层再承担铸造装配（registry 假值 / masked store /
 * bind 表 / fence env 增量 + invariant 1/6 装配期 assert）。
 * 代换接线 / dispose 归 T3，CA 持久层归 T4（`ca-store.ts`）。
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

import { readFileSync, statSync } from "node:fs";
import { ToolExecutionError } from "../../errors.js";
import { egressCaBindSources } from "./ca-store.js";
import {
  buildMaskedEnvVars,
  buildMaskedFileBinds,
  CA_TRUST_VARS,
  MaskedFileStore,
  normalizePathForSandbox,
  SentinelRegistry,
  type CredentialEnvVarConfig,
  type CredentialFileConfig,
  type MaskedEnvBuildResult,
  type MaskedFileBind,
  type MitmCA,
} from "./upstream.js";

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

// ── T2：启动期铸造（假值进围栏） ────────────────────────────────────────

/**
 * bwrap fence bind 表条目（`EgressFenceSpec.binds` 扩段形状，invariant 9）：
 * masked-file 盖 bind（src=fake 文件, dest=真路径）、store 目录 / trust
 * bundle 自 bind（src=dest）、F3 deny 的 `/dev/null` 盖 bind。发射落
 * egressBind 段（workspaceMounts 之后、cwdReadonly 之前），last-mount-wins
 * 盖过根 bind 下的真路径。
 */
export interface EgressFenceBind {
  readonly src: string;
  readonly dest: string;
  readonly readonly: true;
}

/**
 * F3 deny 降级的 typed 违例痕（kind 判别联合，code-quality typed-error
 * 契约）。只含路径与人读文案，绝无凭据材料。
 */
export interface CredentialDenyTrace {
  readonly kind: "credential_mask_denied";
  readonly path: string;
  readonly reason: string;
}

/** 铸造装配的 typed 失败档（F4 / invariant 1）：两类信号修复动作不同。 */
export type EgressCredentialMintErrorKind =
  /** invariant 6 + F4：注册 sentinel 互为子串 → 部分代换 session 不起。 */
  | "sentinel_substring_contract"
  /** invariant 1：注入的凭据 env 值 ∉ registry 假值空间 → session 不起。 */
  | "env_fake_space_contract";

/**
 * 装配期防线违例 —— throw 于 session 启动之前（Step 1.5，起代理前），
 * 走 createEgressSession 同一失败通道（不跑「带部分代换 / 半真值」的
 * session）。message 只含条目名 / 档位，绝不回显真值。
 */
export class EgressCredentialMintError extends ToolExecutionError {
  override readonly name: string = "EgressCredentialMintError";
  readonly kind: EgressCredentialMintErrorKind;
  constructor(kind: EgressCredentialMintErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** 铸造产物：fence env 增量 + bind 表 + registry/store（消费与释放归 T3）。 */
export interface EgressCredentialMint {
  readonly registry: SentinelRegistry;
  readonly store: MaskedFileStore;
  /** fence env 增量：凭据假值 + `CA_TRUST_VARS` 全量指向 trust bundle。 */
  readonly envVars: Readonly<Record<string, string>>;
  readonly binds: readonly EgressFenceBind[];
  readonly denyTraces: readonly CredentialDenyTrace[];
}

export interface MintEgressCredentialsArgs {
  readonly roster: EgressCredentialRoster;
  /** T4 持久层装载产物（trust bundle 已随 createMitmCA 现写）。 */
  readonly ca: MitmCA;
  /** 宿主 env 源（默认 process.env）—— 真值只在本进程内存读，不进围栏。 */
  readonly env?: Record<string, string | undefined>;
  /** F1/F2 跳过痕（debug 档：无可保护条目不是故障）。 */
  readonly onDebug?: (message: string) => void;
  /** F3 违例痕旁路（invariant 7 禁静默）；缺省 console.warn。 */
  readonly onWarn?: (message: string) => void;
}

/** invariant 6 + F4：任一 sentinel 不得是另一 sentinel 的子串。 */
export function assertSentinelSubstringContract(
  registry: SentinelRegistry
): void {
  const sentinels = [...registry.entries()].map(([s]) => s);
  for (let i = 0; i < sentinels.length; i++) {
    for (let j = 0; j < sentinels.length; j++) {
      if (i === j) continue;
      if (sentinels[j].includes(sentinels[i])) {
        throw new EgressCredentialMintError(
          "sentinel_substring_contract",
          `egress credential assembly: sentinel #${i} is a substring of sentinel #${j} (nested fakes make body substitution chunk-boundary-dependent). Refusing to start a partially-substituting session (spec F4).`
        );
      }
    }
  }
}

/**
 * invariant 1：凡注入围栏的凭据条目 env 值必须落在 registry 假值空间 ——
 * 整值 = 某 sentinel，structured 档 = 含某 sentinel 的合成交替值。违例
 * = 装配缺陷（真值可能直达围栏）→ typed 失败，不起 session。
 */
export function assertInjectedEnvInFakeSpace(
  setEnvVars: Readonly<Record<string, string>>,
  registry: SentinelRegistry
): void {
  const sentinels = [...registry.entries()].map(([s]) => s);
  for (const [name, value] of Object.entries(setEnvVars)) {
    if (!sentinels.some((s) => value === s || value.includes(s))) {
      throw new EgressCredentialMintError(
        "env_fake_space_contract",
        `egress credential assembly: injected env "${name}" value is not in the registry fake-value space (invariant 1). Refusing to start the session.`
      );
    }
  }
}

/** F2 跳过痕文案（宿主读不到 = 围栏同样读不到，不可达不是泄露，不硬错）。 */
function f2SkipReason(path: string, cause: string): string {
  return `[egress-credential] file entry "${path}" skipped (${cause}) — nothing protectable on this host; entry passes through as absent`;
}

/**
 * env 条目铸造（whole-value 形态）：F1 presence 预检后交包件铸造。
 * 独立成函数（S5 门）。
 */
function mintEnvEntries(
  entries: readonly EgressCredentialEnvVarEntry[],
  registry: SentinelRegistry,
  env: Record<string, string | undefined>,
  onDebug: (message: string) => void
): MaskedEnvBuildResult {
  const envConfigs: CredentialEnvVarConfig[] = [];
  for (const entry of entries) {
    const raw = env[entry.name];
    if (raw === undefined || raw.length === 0) {
      onDebug(
        `[egress-credential] env entry "${entry.name}" skipped: no real value on host (F1 — nothing to protect; no empty fake injected)`
      );
      continue;
    }
    envConfigs.push({
      name: entry.name,
      mode: "mask",
      injectHosts: [...entry.injectHosts],
    });
  }
  const result = buildMaskedEnvVars(envConfigs, [], registry, env);
  // 本仓 env 条目形状（T1）无 extract/decode → 该档结构上不可达；
  // 保留防御分支：出现即留痕且不注入（fail-closed 方向）。
  for (const name of result.degradeToUnsetNames) {
    onDebug(
      `[egress-credential] env entry "${name}" degraded to unset (extract no match under deny policy) — withheld from fence env`
    );
  }
  return result;
}

/**
 * 文件条目 F2/F3 预检（Assumption 8 判责在本仓：包对非 UTF-8 只静默
 * skip = fail-open，deny 降级必须在调用包件之前拦截）。
 * 返回可掩码 config 集 + deny 路径集 + F3 typed 痕。独立成函数（S5 门）。
 */
function preflightFileEntries(
  entries: readonly EgressCredentialFileEntry[],
  onDebug: (message: string) => void
): {
  configs: CredentialFileConfig[];
  denyPaths: Set<string>;
  denyTraces: CredentialDenyTrace[];
} {
  const configs: CredentialFileConfig[] = [];
  const denyPaths = new Set<string>();
  const denyTraces: CredentialDenyTrace[] = [];
  for (const entry of entries) {
    const resolved = normalizePathForSandbox(entry.path);
    let raw: Buffer | null = null;
    let directory = false;
    try {
      directory = statSync(resolved).isDirectory();
      if (!directory) raw = readFileSync(resolved);
    } catch {
      // F2：absent / unreadable —— 下方统一跳过留痕。
    }
    if (directory || raw === null) {
      onDebug(
        f2SkipReason(
          entry.path,
          directory ? "resolves to a directory" : "absent or unreadable on host"
        )
      );
      continue;
    }
    // 非 UTF-8 判据与包内 masking 同一算法（utf8 往返字节数不等 = 二进制）。
    const text = raw.toString("utf8");
    if (Buffer.byteLength(text, "utf8") !== raw.length) {
      denyPaths.add(resolved);
      denyTraces.push({
        kind: "credential_mask_denied",
        path: resolved,
        reason:
          `non-UTF-8 (binary) credential file cannot be sentinel-masked — path denied inside the fence (Assumption 8 fail-closed, package default fail-open is not accepted). ` +
          `Fix: store the credential in a UTF-8 text file (mask applies) or move it to an env var entry.`,
      });
      continue;
    }
    configs.push({
      path: entry.path,
      mode: "mask",
      extract: entry.extract,
      decode: entry.decode,
      injectHosts: [...entry.injectHosts],
      onExtractNoMatch: "deny",
    });
  }
  return { configs, denyPaths, denyTraces };
}

/**
 * bind 表装配（invariant 9 落位归 bwrap 消费方）：masked 盖 bind → store
 * 目录 → trust bundle（经 T4 SSOT `egressCaBindSources`，CA key 路径永不
 * 出表）→ deny 盖 /dev/null。独立成函数（S5 门）。
 */
function assembleFenceBinds(
  maskedBinds: readonly MaskedFileBind[],
  store: MaskedFileStore,
  ca: MitmCA,
  denyPaths: ReadonlySet<string>
): EgressFenceBind[] {
  const binds: EgressFenceBind[] = [];
  for (const b of maskedBinds) {
    binds.push({ src: b.fakePath, dest: b.realPath, readonly: true });
  }
  const storeDir = store.dirPath;
  if (storeDir !== undefined) {
    binds.push({ src: storeDir, dest: storeDir, readonly: true });
  }
  for (const s of egressCaBindSources(ca)) {
    binds.push({ src: s.src, dest: s.src, readonly: true });
  }
  for (const p of denyPaths) {
    binds.push({ src: "/dev/null", dest: p, readonly: true });
  }
  return binds;
}

/**
 * 启动期铸造：名册条目 → registry 假值 + masked store + bind 表 + fence
 * env 增量。失败路径按 spec 表逐条 typed 化：
 *   - F1：真值 env 缺席 / 空串 → 跳过条目 + debug 痕，不注入空假值
 *     （presence 检查不翻转）；
 *   - F2：文件不存在 / 不可读 / 是目录 → 跳过 + debug 痕，不硬错；
 *   - F3（Assumption 8）：非 UTF-8 / 二进制、extract 未命中 → **降级
 *     deny**：`/dev/null` 盖 bind 使路径进围栏不可读 + typed 违例痕含
 *     修复指引。本仓不吃包默认 warn-and-include fail-open；
 *   - F4 / invariant 1：注册后双 assert，违例 = throw（session 不起）。
 *
 * `allowedDomains` 入参恒 `[]`（Assumption 6：条目 injectHosts 显式值，
 * 不吃包缺省扩张）；`onExtractNoMatch` 逐文件条目钉 `"deny"`。
 */
export function mintEgressCredentials(
  args: MintEgressCredentialsArgs
): EgressCredentialMint {
  const env = args.env ?? process.env;
  const onDebug = args.onDebug ?? ((m: string) => console.debug(m));
  const onWarn = args.onWarn ?? ((m: string) => console.warn(m));
  const registry = new SentinelRegistry();
  const store = new MaskedFileStore();

  const envResult = mintEnvEntries(args.roster.envVars, registry, env, onDebug);
  const preflight = preflightFileEntries(args.roster.files, onDebug);
  const fileResult = buildMaskedFileBinds(
    preflight.configs,
    [],
    registry,
    store
  );
  const denyTraces = [...preflight.denyTraces];
  const denyPaths = new Set(preflight.denyPaths);
  for (const path of fileResult.degradeToDenyPaths) {
    denyPaths.add(path);
    denyTraces.push({
      kind: "credential_mask_denied",
      path,
      reason:
        `mask-mode credential file matched no extract/decode candidate — degraded to deny (path unreadable inside the fence; Assumption 8, package "warn"-and-include not accepted). ` +
        `Fix: correct the entry's extract (capture group 1 = the credential value) or remove the entry.`,
    });
  }
  for (const t of denyTraces) onWarn(`[egress-credential] ${t.reason}`);

  // bind 表 + fence env 增量（假值 + CA_TRUST_VARS 全量指向 trust bundle，
  // Assumption 11）。
  const binds = assembleFenceBinds(fileResult.binds, store, args.ca, denyPaths);
  const credEnv: Record<string, string> = { ...envResult.setEnvVars };
  for (const name of CA_TRUST_VARS) {
    credEnv[name] = args.ca.trustBundlePath;
  }

  // 装配期防线（throw 后调用方拿不到 registry/store，无半注入态外泄）。
  // assert 只钉凭据条目 env 值（invariant 1 的语义域）；CA_TRUST_VARS 是
  // 信任链路径注入，不属假值空间。
  assertSentinelSubstringContract(registry);
  assertInjectedEnvInFakeSpace(envResult.setEnvVars, registry);

  return Object.freeze({
    registry,
    store,
    envVars: Object.freeze(credEnv),
    binds: Object.freeze(binds),
    denyTraces: Object.freeze(denyTraces),
  });
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
