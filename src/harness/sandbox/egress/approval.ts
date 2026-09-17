/**
 * src/harness/sandbox/egress/approval.ts
 *
 * T6 首次域名批准流 —— 会话级门件(specs/network-egress-allowlist.md
 * §Boundaries「首次域名批准流」+ SC10 + ADR-0097 §批准持久化粒度)。
 *
 * 单一职责：把 per-process 会话级允许/拒绝集 + 并发合并表装在一处，
 * 把"host 决策 = ask 接口"封装成 `askIfUnknown(host): Promise<boolean>`。
 * 判定侧(session.ts filter 回调)只问一次 boolean;判定之后该 host 进
 * 集合,本会话内不再问。
 *
 * 不变量(钉自 spec + ADR):
 *   - pending 期间同 host 并发 → 合并为同一次 ask(返回同一 Promise);
 *   - 不同 host 并发 → 各自独立 ask,不合并;
 *   - 拒绝 → 该 host 本会话内直接 deny,不再 ask;
 *   - 批准 → 该 host 本会话内直接放行,不再 ask;
 *   - askApproval 缺席 → 首次见到即 deny(fail-closed);
 *   - askApproval 抛异常 → fail-closed,该 host 入 denied 集,后续
 *     请求不再尝试 ask(避免 stale in-flight 阻塞后续)。
 *
 * 持久化写回:本任务(ADR-0097 §批准持久化粒度)裁定批准 = 会话级放行必成;
 * 写回用户层 settings 是可选附属动作 —— settings.ts 已有 `persist-settings`
 * 形态可借用,但本任务**不**实现写回调用,留 TODO(见报告)。
 *
 * 状态容器刻意放在 egress 域侧(不放 session-grants / NormalRuleSpec):
 *   - session-grants 是 NormalRuleSpec 形态,与"批准一个 host"的语义不对齐;
 *   - 域名允许/拒绝集在 egress 域内自包含,判定侧就近消费;
 *   - 单进程内 Map/Set 即可,不引入新依赖面。
 */

/**
 * AskApproval 接口 —— 注入到 bash tool(由调用面把既有 AskUser 转写为
 * `(host) => askUser({ tool: "egress-domain-approval", summaryHint: ... })`)。
 *
 * 缺省 = fail-closed:首次见到的新 host 直接 deny,理由 `no-approval-inlet`
 * (见 session.ts filter 与 violations.ts 渲染)。
 */
export type AskApproval = (host: string) => Promise<boolean>;

export interface EgressApprovalGate {
  /**
   * 给定 host,返回该 host 在本会话是否放行。
   * - 已在 allowedThisSession 集 → 返回 true,不再 ask;
   * - 已在 deniedThisSession 集 → 返回 false,不再 ask;
   * - 已有 in-flight Promise → 返回它(同 host 并发合并);
   * - 否则调 askApproval(host) → 解决后更新两集之一,再返回结果。
   */
  askIfUnknown(host: string): Promise<boolean>;
  /** 观察本会话已批准的 host 集合(已冻结;供回灌「session-level allowlist」标注)。 */
  allowedThisSession(): readonly string[];
  /** 观察本会话已拒绝的 host 集合(已冻结)。 */
  deniedThisSession(): readonly string[];
}

export interface CreateEgressApprovalGateOptions {
  /**
   * 注入的 ask 面;缺省 = fail-closed(首次见到新 host 直接 deny)。
   * 抛异常 → fail-closed(同 attended deny),host 入 denied 集。
   */
  readonly askApproval?: AskApproval;
}

/**
 * 归一 host key —— trim + lowercase。
 * 域匹配器对大小写不敏感(对齐 domain-matcher.ts:110 `host.trim().toLowerCase()`),
 * 批准集合的存储键与之同形态,避免 "Example.COM" 与 "example.com" 视为不同 host
 * 重复问。
 */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

/**
 * 构造 egress 批准门件 —— 单实例存活 = bash tool 工厂闭包期,跨调用共享。
 *
 * 并发模型:Node 单线程事件循环下,append in-flight Promise 与读取 in-flight
 * 必须在同一 tick 内可观察,所以 `askIfUnknown` 实现是**同步**写 in-flight
 * 表、异步返回。同一 host 在 pending 期间反复进入 → 直接返回 in-flight
 * Promise,不并发调 askApproval。
 */
export function createEgressApprovalGate(
  opts: CreateEgressApprovalGateOptions
): EgressApprovalGate {
  const inFlight = new Map<string, Promise<boolean>>();
  const allowed = new Set<string>();
  const denied = new Set<string>();

  const askIfUnknown = async (host: string): Promise<boolean> => {
    const key = normalizeHost(host);
    if (allowed.has(key)) return true;
    if (denied.has(key)) return false;

    // 已有同 host in-flight Promise → 合并,直接 await 它。
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;

    // askApproval 缺席 → fail-closed:首次见到即 deny,且入 denied 集,
    // 后续重复请求不再尝试任何 ask。spec §Failure paths「非交互入口首见
    // 新域名」表行要求该路径 typed-fail,违例理由由调用面记为
    // `no-approval-inlet`。
    if (opts.askApproval === undefined) {
      denied.add(key);
      return false;
    }

    // 起 in-flight Promise —— 同步写入 inFlight 表(此时同 host 后续并发
    // 进入会直接命中表,合并)。
    const promise = (async (): Promise<boolean> => {
      let approved: boolean;
      try {
        approved = await opts.askApproval!(host);
      } catch {
        // fail-closed:ask 抛异常 → 该 host 入 denied 集。catch 不重抛,
        // 保证 inFlight.delete 一定执行,后续请求走 deniedThisSession
        // 命中路径。
        approved = false;
      }
      // 终态固化:approved → allowed,否则 → denied。无论哪条,清 in-flight。
      if (approved) allowed.add(key);
      else denied.add(key);
      inFlight.delete(key);
      return approved;
    })();
    inFlight.set(key, promise);
    return promise;
  };

  const allowedThisSession = (): readonly string[] =>
    Object.freeze([...allowed]);
  const deniedThisSession = (): readonly string[] => Object.freeze([...denied]);

  return Object.freeze({
    askIfUnknown,
    allowedThisSession,
    deniedThisSession,
  });
}
