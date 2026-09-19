/**
 * src/harness/sandbox/egress/credential-mint.ts
 *
 * specs/egress-credential-sentinel.md T2 —— 启动期铸造（假值进围栏）。
 *
 * 单一职责：名册条目（`credential-assembly.ts` SSOT 产出的
 * `EgressCredentialRoster` 纯数据形状）→ registry 假值 + masked store +
 * bind 表 + fence env 增量；装配期防线（invariant 1/6 + F4）双 assert。
 * 名册装配 / 收窄合并归 `credential-assembly.ts`（T1），代换接线 /
 * dispose 归 T3（`session.ts`），CA 持久层归 T4（`ca-store.ts`）。
 *
 * invariant 3（洗出防护）在签名面的体现：铸造只吃「名册 + CA + env 源」
 * ，**没有** allowedDomains / 批准集入参 —— 批准门新批域在类型上就
 * 进不了任何条目的 injectHosts。
 *
 * Assumption 6（injectHosts 静态钉）：条目未声明 / 空 injectHosts →
 * settings 层已丢此类条目，本层防御直连调用方（`isMintable` 判据在
 * 名册装配侧），禁静默。
 */

import { readFileSync, statSync } from "node:fs";
import { ToolExecutionError } from "../../errors.js";
import { egressCaBindSources } from "./ca-store.js";
import type {
  EgressCredentialEnvVarEntry,
  EgressCredentialFileEntry,
  EgressCredentialRoster,
} from "./credential-assembly.js";
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
