/**
 * specs/egress-credential-sentinel.md T1 配置层契约 —— `isolation.credentials` 解析体。
 *
 * 用户层凭据名册段（Assumption 2：仅用户层，项目文件不采纳 —— ADR-0084
 * 由 `filterProjectSettingsKeys` 对整个 isolation 键统一丢段 + 警告，本层
 * 不重复发）。github 两条目由代码内置名册提供
 * （`src/harness/sandbox/egress/credential-assembly.ts` SSOT），本段只做
 * 收窄/追加的数据承载。
 *
 * 校验纪律对齐 settings.ts:34-43 既有形态（drop-not-throw、恒收紧）：
 *  - 非普通对象段 → 丢段不抛、不警告（同 network 段）；
 *  - 条目非法（缺 path/name、缺 injectHosts、extract 编译失败或无捕获组 1、
 *    decode 非 "jwt"）→ 丢该条目 + `[settings]` 警告，其余条目保留；
 *  - injectHosts 必填：缺失/空数组/含非法串 → 丢该条目（Assumption 6：
 *    本仓不吃包「缺省 = 全部 allowedDomains」的 trade-off，宁可丢条目）；
 *  - extract 捕获组校验：命名组 `(?<n>…)` 不占编号，不算捕获组 1
 *    （sandbox-config.js:180-197 的 group-1 校验是教训）；
 *  - 用户层条目总数上限 16（Input-contract overflow 档）：files 优先、
 *    envVars 其次，超出丢尾 + 警告；
 *  - 丢弃后空数组 = 保留空数组事实（无追加 = 仅内置名册），段不合成。
 *
 * 独立文件承载 —— settings.ts 文件承载纪律（前例 isolation-network.ts）。
 */

/** 单条凭据文件条目（settings 侧形态；egress 侧数据形状见 credential-assembly.ts）。 */
export interface IknowSettingsCredentialFileEntry {
  /** 凭据文件路径（字面串原样承载，`~` 展开归消费方/铸造层）。 */
  path: string;
  /** 可选提取正则源串，必须可编译且含捕获组 1。 */
  extract?: string;
  /** 可选解码标记，仅字面量 "jwt" 合法。 */
  decode?: "jwt";
  /** 注入域名单，必填非空（invariant 3 洗出防护的数据面）。 */
  injectHosts: string[];
}

/** 单条凭据 env 变量条目。 */
export interface IknowSettingsCredentialEnvVarEntry {
  /** env 变量名（字面串，trim 后非空）。 */
  name: string;
  /** 注入域名单，必填非空。 */
  injectHosts: string[];
}

/** `isolation.credentials` 段。 */
export interface IknowSettingsIsolationCredentials {
  files?: IknowSettingsCredentialFileEntry[];
  envVars?: IknowSettingsCredentialEnvVarEntry[];
}

/** 用户层条目总数上限（files + envVars 合计，plan 子弹 1 钉死）。 */
export const CREDENTIALS_ENTRY_CAP = 16;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * injectHosts 值域：非空数组且每项 trim 后非空字符串。
 * 整体判定（任一非法串 → 整条拒）：凭据注入面走部分接受会造成
 * 「以为收窄了实际没窄」的静默半生效，宁可丢条目 + 留痕。
 */
function parseInjectHosts(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (!isNonEmptyString(item)) return undefined;
    out.push(item.trim());
  }
  return out;
}

/**
 * 捕获组 1 存在性扫描：统计「不在字符类内、未被转义、后随不是 `?`」的
 * `(` 个数（JS 里只有裸 `(` 产编号组；`(?:` `(?=` `(?!` `(?<=` `(?<!`
 * `(?<name>` 均不占编号）。
 */
function hasCaptureGroup1(source: string): boolean {
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") {
      i++; // 跳过被转义的下一字符（含 `\(` `\]` 等）
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(" && source[i + 1] !== "?") return true;
  }
  return false;
}

/** 编译性 + 捕获组 1 双查；非法返回 reason 串，合法返回 undefined。 */
function validateExtract(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return "extract is not a string";
  try {
    new RegExp(raw);
  } catch {
    return "extract does not compile";
  }
  if (!hasCaptureGroup1(raw)) return "extract lacks capture group 1";
  return undefined;
}

/** decode 值域：仅字面量 "jwt"（缺席合法）。 */
function validateDecode(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "jwt") return 'decode must be the literal "jwt"';
  return undefined;
}

function warn(
  onWarn: ((message: string) => void) | undefined,
  list: "files" | "envVars",
  entry: unknown,
  reason: string
): void {
  onWarn?.(
    `[settings] isolation.credentials.${list} entry ${JSON.stringify(entry)} dropped: ${reason}`
  );
}

function parseFileEntry(
  raw: unknown,
  onWarn?: (message: string) => void
): IknowSettingsCredentialFileEntry | undefined {
  if (!isPlainObject(raw)) {
    warn(onWarn, "files", raw, "entry is not an object");
    return undefined;
  }
  if (!isNonEmptyString(raw.path)) {
    warn(onWarn, "files", raw, "path missing or empty");
    return undefined;
  }
  const injectHosts = parseInjectHosts(raw.injectHosts);
  if (injectHosts === undefined) {
    warn(onWarn, "files", raw, "injectHosts missing, empty or invalid");
    return undefined;
  }
  const extractReason = validateExtract(raw.extract);
  if (extractReason !== undefined) {
    warn(onWarn, "files", raw, extractReason);
    return undefined;
  }
  const decodeReason = validateDecode(raw.decode);
  if (decodeReason !== undefined) {
    warn(onWarn, "files", raw, decodeReason);
    return undefined;
  }
  const out: IknowSettingsCredentialFileEntry = {
    path: raw.path.trim(),
    injectHosts,
  };
  if (typeof raw.extract === "string") out.extract = raw.extract;
  if (raw.decode === "jwt") out.decode = "jwt";
  return out;
}

function parseEnvVarEntry(
  raw: unknown,
  onWarn?: (message: string) => void
): IknowSettingsCredentialEnvVarEntry | undefined {
  if (!isPlainObject(raw)) {
    warn(onWarn, "envVars", raw, "entry is not an object");
    return undefined;
  }
  if (!isNonEmptyString(raw.name)) {
    warn(onWarn, "envVars", raw, "name missing or empty");
    return undefined;
  }
  const injectHosts = parseInjectHosts(raw.injectHosts);
  if (injectHosts === undefined) {
    warn(onWarn, "envVars", raw, "injectHosts missing, empty or invalid");
    return undefined;
  }
  return { name: raw.name.trim(), injectHosts };
}

/**
 * 上限收尾：files 优先、envVars 其次的稳定序，超出 CREDENTIALS_ENTRY_CAP
 * 的尾部条目丢弃 + 逐条警告（丢弃方向恒为收紧）。
 */
function applyEntryCap(
  files: IknowSettingsCredentialFileEntry[],
  envVars: IknowSettingsCredentialEnvVarEntry[],
  onWarn?: (message: string) => void
): {
  files: IknowSettingsCredentialFileEntry[];
  envVars: IknowSettingsCredentialEnvVarEntry[];
} {
  const total = files.length + envVars.length;
  if (total <= CREDENTIALS_ENTRY_CAP) return { files, envVars };
  let budget = CREDENTIALS_ENTRY_CAP;
  const keptFiles = files.slice(0, budget);
  budget -= keptFiles.length;
  const keptEnvVars = envVars.slice(0, budget);
  for (const dropped of files.slice(keptFiles.length)) {
    warn(onWarn, "files", dropped, `entry cap ${CREDENTIALS_ENTRY_CAP} exceeded`);
  }
  for (const dropped of envVars.slice(keptEnvVars.length)) {
    warn(
      onWarn,
      "envVars",
      dropped,
      `entry cap ${CREDENTIALS_ENTRY_CAP} exceeded`
    );
  }
  return { files: keptFiles, envVars: keptEnvVars };
}

/**
 * 解析 `isolation.credentials` 段 —— 仅用户层。
 * 非普通对象 → undefined（丢段不警告，同 parseIsolationNetwork）；
 * 两列表各自逐条解析（非法条目丢该条 + 警告）；合计超上限丢尾 + 警告；
 * 两字段皆缺席 → undefined（空段不产出）。
 */
export function parseIsolationCredentials(
  raw: unknown,
  onWarn?: (message: string) => void
): IknowSettingsIsolationCredentials | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) return undefined;

  const files: IknowSettingsCredentialFileEntry[] = [];
  if (Array.isArray(raw.files)) {
    for (const entry of raw.files) {
      const parsed = parseFileEntry(entry, onWarn);
      if (parsed !== undefined) files.push(parsed);
    }
  }
  const envVars: IknowSettingsCredentialEnvVarEntry[] = [];
  if (Array.isArray(raw.envVars)) {
    for (const entry of raw.envVars) {
      const parsed = parseEnvVarEntry(entry, onWarn);
      if (parsed !== undefined) envVars.push(parsed);
    }
  }

  const hasFiles = Array.isArray(raw.files);
  const hasEnvVars = Array.isArray(raw.envVars);
  if (!hasFiles && !hasEnvVars) return undefined;
  const capped = applyEntryCap(files, envVars, onWarn);

  const out: IknowSettingsIsolationCredentials = {};
  if (hasFiles) out.files = capped.files;
  if (hasEnvVars) out.envVars = capped.envVars;
  return out;
}

/**
 * 合并 user / project 的 `isolation.credentials` —— project 整段被
 * ADR-0084 allowlist 在 filter 阶段丢弃，本函数实际只看 user（与
 * mergeIsolationNetwork 同款对称保留）。
 */
export function mergeIsolationCredentials(
  user: IknowSettingsIsolationCredentials | undefined,
  _project: IknowSettingsIsolationCredentials | undefined
): IknowSettingsIsolationCredentials | undefined {
  if (!user) return undefined;
  return user;
}
