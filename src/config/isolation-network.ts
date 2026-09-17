/**
 * spec/network-egress-allowlist.md SC12 配置层契约 — `isolation.network` 解析体。
 *
 * 承载 `allowedDomains` / `deniedDomains` 两个域名允许/拒绝集；只做形态合法判定：
 *  - 空数组 → 保留空数组事实（fail-closed 信号，由判定层据此全拒），非错误；
 *  - 非字符串条目 / trim 后为空字符串 → 丢弃该条目 + onWarn 留痕（不抛）；
 *  - allowed / denied 中裸 `*` → 丢弃该条目 + onWarn（保守做法：denied 与
 *    allowed 同纪律；裸 `*` 不允许成为合法域模式）；
 *  - `:port` 越界（0 / >65535 / 非数字 / 空 / 负数）→ 拒绝该条目 + onWarn；
 *    **不得透传为永不匹配**（避免「静默退化」伪装成 fail-closed）；
 *  - 非法条目不影响同批合法条目（逐条判定）；
 *  - 丢弃方向恒为收紧：丢弃后若导致空集 → 保留空数组事实，不合成「允许一切」。
 *
 * `*.x` 通配语义 / 大小写归一 / 端口拼接形态留给 T3（语义层）。
 *
 * 独立文件承载 —— `settings.ts` 已 1639 行（依赖 fork「文件承载纪律」）。
 */
export interface IknowSettingsIsolationNetwork {
  /**
   * 允许通过的域名列表（逐条解析后的 trim 结果）。
   * 空数组 = 全拒（fail-closed 合法态，由判定层据此全拒）。
   */
  allowedDomains?: string[];
  /**
   * 拒绝的域名列表（逐条解析后的 trim 结果）。
   * 与 allowedDomains 同款解析纪律；deny 优先于 allow（在语义层判定）。
   */
  deniedDomains?: string[];
}

/** 端口范围合法（1-65535）；0 / 65536 / 负数 / 非整数 / 非数字均非法。 */
function isValidPort(p: number): boolean {
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

/**
 * 解析 `:port` 后缀形态 —— 严格数字串（1-65535）；空串 / 非数字串 / 越界均非法。
 * 独立成函数：SC12 要求非法 port 整条拒（不透传为永不匹配），此判定与
 * host 形态判定是两条独立规则，拆开后各自保持单一职责。
 */
function parsePortSuffix(portStr: string): number | undefined {
  // 非数字 / 含前导零 / 含小数点 / 含空白 → 拒；Number() 过于宽松，必须严格数字串
  if (!/^\d+$/.test(portStr)) return undefined;
  const n = Number(portStr);
  if (!isValidPort(n)) return undefined;
  return n;
}

/**
 * 解析「域名[:port]」条目 —— 仅判定「形态合法」，不解释通配 `*.x` 的语义
 * （留给语义层）。返回 `{ host, port }` 或 `undefined`（非法）。
 *
 * 形态要求：
 *  - host trim 后非空；
 *  - host 不为裸 `*`（保守做法：denied 同纪律，allowed 不允许「通配一切」）；
 *  - 无 `:port` 后缀 → port = undefined；
 *  - 有 `:port` 后缀 → port 必须为合法整数（1-65535），否则整条拒；
 *  - host 内可包含若干点号（如 `api.example.com`），不要求包含点号
 *    （允许单标签 host，由语义层裁定是否含点号）。
 *
 * 返回的 `host` 是 trim 后的字符串；`port` 是 number 或 undefined。
 */
function parseNetworkEntry(
  raw: unknown
): { host: string; port?: number } | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === "*") return undefined;

  // 最多一个 ':' 切分；host 不含 ':' 时整串就是 host，无 port。
  const colonIdx = trimmed.lastIndexOf(":");
  let host: string;
  let portStr: string | undefined;
  if (colonIdx === -1) {
    host = trimmed;
  } else {
    host = trimmed.slice(0, colonIdx);
    portStr = trimmed.slice(colonIdx + 1);
  }

  if (host.length === 0) return undefined; // 形如 ":443" 或 "example.com:"
  // host 为裸 `*`（含 `*:` 前缀）也拒 —— 与全串裸 `*` 同纪律
  if (host === "*") return undefined;

  const port = portStr === undefined ? undefined : parsePortSuffix(portStr);
  // 有 ":" 但 port 非法（空串 / 非数字 / 越界）→ 整条拒
  if (portStr !== undefined && port === undefined) return undefined;

  return { host, port };
}

/**
 * 解析域名列表条目 —— 单字段（allowedDomains / deniedDomains）共用。
 *
 * 行为：
 *  - 非数组 → 返回 undefined（字段整体丢弃，不警告 —— 类型层错配，
 *    与 isolation.fsMode 等同款 drop-not-throw 纪律；非法整字段已隐含上层
 *    「非普通对象」上下文）；
 *  - 空数组 → 返回空数组（合法 fail-closed 态）；
 *  - 逐条 parseNetworkEntry，非法条目丢弃 + onWarn 留痕；
 *  - 合法条目保留为「序列化形态」：无 port → host 串；有 port → `host:port` 串
 *    （trim + port 数值校验后的形态，便于语义层直接 split）。
 *
 * onWarn 消息格式：`[settings] isolation.network.<field> entry "<raw>" dropped: <reason>`，
 * 对齐既有 `[settings] ...` 前缀（settings.ts:1617 / :1633）。
 */
export function parseNetworkDomainList(
  raw: unknown,
  field: "allowedDomains" | "deniedDomains",
  onWarn?: (message: string) => void
): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const out: string[] = [];
  const warn = onWarn ?? (() => {});
  for (const entry of raw) {
    const parsed = parseNetworkEntry(entry);
    if (parsed === undefined) {
      warn(
        `[settings] isolation.network.${field} entry ${JSON.stringify(entry)} dropped: invalid shape`
      );
      continue;
    }
    out.push(
      parsed.port === undefined ? parsed.host : `${parsed.host}:${parsed.port}`
    );
  }
  return out;
}

/**
 * 解析 `isolation.network` 整段 —— 用户层（仅用户层，ADR-0084）。
 *
 * 行为：
 *  - 非普通对象 → undefined（段整体丢弃，与 parseIsolation 同纪律）；
 *  - allowedDomains / deniedDomains 各自独立解析（逐字段 drop-not-throw）；
 *  - 未知 sibling 字段 → 静默丢弃（与 isolation.fsMode 同纪律：未来字段
 *    上线不影响旧解析体）；
 *  - allowedDomains 与 deniedDomains 同时空 → 段返回 undefined（无内容）；
 *    仅其中一个空数组 → 段保留空数组事实（合法 fail-closed 态）。
 */
export function parseIsolationNetwork(
  raw: unknown,
  onWarn?: (message: string) => void
): IknowSettingsIsolationNetwork | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;

  const allowed = parseNetworkDomainList(
    obj.allowedDomains,
    "allowedDomains",
    onWarn
  );
  const denied = parseNetworkDomainList(
    obj.deniedDomains,
    "deniedDomains",
    onWarn
  );

  const out: IknowSettingsIsolationNetwork = {};
  if (allowed !== undefined) out.allowedDomains = allowed;
  if (denied !== undefined) out.deniedDomains = denied;
  if (out.allowedDomains === undefined && out.deniedDomains === undefined) {
    return undefined;
  }
  return out;
}

/**
 * 合并 user / project 的 `isolation.network` —— project 整段被 ADR-0084
 * 丢弃（filterProjectSettingsKeys 对整个 isolation key 已发一条警告），故
 * 本函数实际只看 user。保留合并函数形态以与 parseIsolation / mergeIsolation
 * 配套（对称 + 未来若调整层归属时改一处即可）。
 */
export function mergeIsolationNetwork(
  user: IknowSettingsIsolationNetwork | undefined,
  _project: IknowSettingsIsolationNetwork | undefined
): IknowSettingsIsolationNetwork | undefined {
  if (!user) return undefined;
  return user;
}
