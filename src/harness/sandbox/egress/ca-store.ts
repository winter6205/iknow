/**
 * src/harness/sandbox/egress/ca-store.ts
 *
 * T4 CA 持久层与信任链装配面（specs/egress-credential-sentinel.md §T4）。
 *
 * 单一职责：把宿主级持久 MITM CA 的「装载 / 自检 / 拒用 / 重生成」收在此件，
 * 供 T2 铸造装配消费。trust bundle 本身由包 `createMitmCA` 每次调用现写
 * （Assumption 3 收口，经 `upstream.ts` re-export，不复刻）。
 *
 * 钉死的契约（spec 逐字）：
 *   - 持久位置 = `~/.config/iknow/egress-mitm-ca/`（`defaultEgressCaDir()`，
 *     Assumption 4 宿主级持久单例，不走 per-call ephemeral——RSA-2048 生成
 *     在冷路径上，mitm-ca.js:52-56 性能注记）；
 *   - 目录 0700 / key 0600；权限不符 = **拒用 + 重生成前告警**（F7），
 *     `validateCaPair` 失败 = 拒用 + 告警 + 重生成，重生成后 session 可装载；
 *   - 告警痕（`CaStoreNotice`）只带文件名 / 模式 / 校验 reason，**绝不带
 *     PEM 或 key 材料**（security-boundaries「不泄露 key 到可见面」）；
 *   - SC8：CA 私钥路径不进任何 bind 表 —— `egressCaBindSources()` 是信任链
 *     bind 候选的唯一 SSOT，只含 trust bundle 路径；
 *   - invariant 7：本件不静默降级 —— 每次偏离都以 `notice` 返回，由装配面
 *     （T2）接 violationSink 留 infra 痕。
 *
 * typed-error 纪律（code-quality.md）：notice 用 kind 判别联合，渲染方
 * 先判 kind；本件对「盘上状态异常」不抛错，只在真正无法写盘（FS 硬故障）
 * 时让底层异常透出 —— CA 不可用 = 不起 mitm session，由调用方处置。
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createMitmCA,
  generateCa,
  validateCaPair,
  type MitmCA,
} from "./upstream.js";

/** 持久 CA 目录内文件名（本模块私有布局，消费方一律走返回值路径）。 */
const CA_CERT_FILE = "cert.pem";
const CA_KEY_FILE = "key.pem";
const CA_DIR_MODE = 0o700;
const CA_KEY_MODE = 0o600;
/** spec 钉死 CN；leaf 缓存随 session 失效，重生成即换锚。 */
const CA_SUBJECT_CN = "iknow egress mitm CA";

/**
 * 逐客户端信任名册常量（T4 只落常量，接线归 T2/T7）：
 * gh 是 Go 二进制 → 吃 `SSL_CERT_FILE`；git-over-https → `GIT_SSL_CAINFO`；
 * curl → `CURL_CA_BUNDLE`。三臂屏上成功证据归 T7，此处不 claim。
 */
export const CLIENT_TRUST_VARS = Object.freeze({
  gh: "SSL_CERT_FILE",
  git: "GIT_SSL_CAINFO",
  curl: "CURL_CA_BUNDLE",
} as const);

/** 装载动作三分：直载 / 首次生成 / 拒用后重生成。 */
export type PersistentCaAction = "loaded" | "generated" | "regenerated";

/**
 * 告警痕（F7 各分支 + invariant 7 留痕面）。detail/reason 均为操作员
 * 可读短文案：只含文件名、八进制模式、包校验 reason——无 key 材料。
 */
export type CaStoreNotice =
  | {
      readonly kind: "ca_permissions";
      readonly detail: string;
    }
  | {
      readonly kind: "ca_pair_invalid";
      readonly reason: string;
    }
  | {
      readonly kind: "ca_pair_incomplete";
      readonly detail: string;
    };

export interface PersistentCaState {
  readonly certPath: string;
  readonly keyPath: string;
  readonly action: PersistentCaAction;
  /** 非 null = 本次发生过「拒用 + 重生成」或半边补齐；T2 据此留 infra 痕。 */
  readonly notice: CaStoreNotice | null;
}

export interface EgressCaLoad {
  readonly ca: MitmCA;
  readonly state: PersistentCaState;
}

/** 信任链 bind 候选（SC8 钉死面）：readonly bind 形状，仅 trust bundle。 */
export interface EgressCaBindSource {
  readonly src: string;
  readonly readonly: true;
}

/** spec 逐字默认位置：`~/.config/iknow/egress-mitm-ca/`。 */
export function defaultEgressCaDir(home: string = homedir()): string {
  return join(home, ".config", "iknow", "egress-mitm-ca");
}

/**
 * 装载或自愈持久 CA。次序纪律（F7「权限不符 = 拒用」先于内容校验）：
 *   目录存在性与模式 → 文件成对性 → key 模式 → validateCaPair。
 * 任一拒用分支都先攒 notice 再重生成；重生成统一恢复 0700/0600。
 */
export function ensurePersistentCa(opts: {
  readonly caDir: string;
  /** 告警痕旁路（F7「重生成前告警」）；缺省 console.warn，同 settings 纪律。 */
  readonly onWarn?: (message: string) => void;
}): PersistentCaState {
  const { caDir, onWarn = (message: string) => console.warn(message) } = opts;
  const certPath = join(caDir, CA_CERT_FILE);
  const keyPath = join(caDir, CA_KEY_FILE);

  const dirNotice = ensureCaDirMode(caDir);
  if (dirNotice) {
    return regenerate(caDir, certPath, keyPath, dirNotice, onWarn);
  }

  const cert = readOptional(certPath);
  const key = readOptional(keyPath);
  if (cert === null && key === null) {
    writeCaPair(certPath, keyPath);
    return { certPath, keyPath, action: "generated", notice: null };
  }
  if (cert === null || key === null) {
    return regenerate(
      caDir,
      certPath,
      keyPath,
      {
        kind: "ca_pair_incomplete",
        detail: `CA pair half-missing in ${caDir} (${cert === null ? CA_CERT_FILE : CA_KEY_FILE} absent) — regenerating`,
      },
      onWarn
    );
  }

  const keyMode = modeOfOrThrow(keyPath);
  if (keyMode !== CA_KEY_MODE) {
    return regenerate(
      caDir,
      certPath,
      keyPath,
      {
        kind: "ca_permissions",
        detail: `CA key file mode is ${octal(keyMode)} (required ${octal(CA_KEY_MODE)}) — refused, regenerating`,
      },
      onWarn
    );
  }

  const validation = validateCaPair(cert, key);
  if (!validation.ok) {
    return regenerate(
      caDir,
      certPath,
      keyPath,
      {
        kind: "ca_pair_invalid",
        reason: `validateCaPair failed for ${caDir}: ${validation.reason} — regenerating`,
      },
      onWarn
    );
  }
  return { certPath, keyPath, action: "loaded", notice: null };
}

/**
 * session 装载面（T2 消费入口）：ensure（含自愈）→ `createMitmCA` 从持久
 * 盘装载并现写本 session trust bundle。返回的 `notice` 即 F7 告警痕。
 */
export function loadEgressCa(opts?: {
  readonly caDir?: string;
  readonly onWarn?: (message: string) => void;
}): EgressCaLoad {
  const caDir = opts?.caDir ?? defaultEgressCaDir();
  const state = ensurePersistentCa({ caDir, onWarn: opts?.onWarn });
  const ca = createMitmCA({
    caCertPath: state.certPath,
    caKeyPath: state.keyPath,
  });
  return Object.freeze({ ca, state });
}

/**
 * 信任链 bind 候选 —— SC8 测试钉的 SSOT：进围栏的只有 trust bundle
 * （仅 CERTIFICATE 块，包内过滤），CA key 路径永不出现在此表。
 * dest 落位与 ro-bind 组装归 T2（Assumption 11）。
 */
export function egressCaBindSources(ca: MitmCA): readonly EgressCaBindSource[] {
  return Object.freeze([
    Object.freeze({ src: ca.trustBundlePath, readonly: true as const }),
  ]);
}

// ── 私有件 ──────────────────────────────────────────────────────────────

function regenerate(
  caDir: string,
  certPath: string,
  keyPath: string,
  notice: CaStoreNotice,
  onWarn: (message: string) => void
): PersistentCaState {
  onWarn(`[egress-ca-store] ${describeNotice(notice)}`);
  ensureCaDirMode(caDir);
  writeCaPair(certPath, keyPath);
  return { certPath, keyPath, action: "regenerated", notice };
}

/**
 * 目录模式核对/恢复。返回值 = 本次发现过权限偏离（拒用告警用）；
 * 目录不存在 → 创建（0700，递归父目录不视为偏离——父归 home 管辖）。
 */
function ensureCaDirMode(caDir: string): CaStoreNotice | null {
  let notice: CaStoreNotice | null = null;
  const st = statOrNull(caDir);
  if (st !== null) {
    const mode = st.mode & 0o777;
    if (mode !== CA_DIR_MODE) {
      notice = {
        kind: "ca_permissions",
        detail: `CA dir mode is ${octal(mode)} at ${caDir} (required ${octal(CA_DIR_MODE)}) — refused, regenerating`,
      };
    }
  } else {
    mkdirSync(caDir, { recursive: true, mode: CA_DIR_MODE });
  }
  // 无论新旧，统一收口到 0700（mkdir 的 mode 受 umask 剪除，chmod 兜底）。
  chmodSync(caDir, CA_DIR_MODE);
  return notice;
}

function writeCaPair(certPath: string, keyPath: string): void {
  const pair = generateCa({ cn: CA_SUBJECT_CN });
  writeSecretFile(certPath, pair.certPem);
  writeSecretFile(keyPath, pair.keyPem);
}

/**
 * 私密文件写入：先清障（旧文件 mode 可能过宽、条目可能被换成目录 ——
 * unlink/rm 失败则透出给 writeFileSync 走硬错误路径），writeFileSync 的
 * mode 只对新建生效，故 chmod 兜底保证 0600。
 */
function writeSecretFile(path: string, content: string): void {
  const st = statOrNull(path);
  if (st !== null) {
    if (st.isDirectory()) {
      rmRecursive(path);
    } else {
      try {
        unlinkSync(path);
      } catch {
        /* 竞争删除/权限：交给随后的 writeFileSync 报错 */
      }
    }
  }
  mkdirSync(dirname(path), { recursive: true, mode: CA_DIR_MODE });
  writeFileSync(path, content, { mode: CA_KEY_MODE });
  chmodSync(path, CA_KEY_MODE);
}

function describeNotice(n: CaStoreNotice): string {
  switch (n.kind) {
    case "ca_permissions":
      return n.detail;
    case "ca_pair_invalid":
      return n.reason;
    case "ca_pair_incomplete":
      return n.detail;
  }
}

function readOptional(path: string): string | null {
  const st = statOrNull(path);
  if (st === null) return null;
  if (st.isDirectory()) return null; // 坏条目 → 视作缺席，重生成时清障
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null; // 不可读 = 读不到；重生成路径会以 0600 重建
  }
}

function statOrNull(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function rmRecursive(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function modeOfOrThrow(path: string): number {
  return statSync(path).mode & 0o777;
}

function octal(mode: number): string {
  return mode.toString(8).padStart(3, "0");
}
