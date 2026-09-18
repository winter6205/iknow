# Spec: 出口域名允许集 —— 代码承载的默认预放行档（builtin preset）

**Status:** draft (rev 1, 待 review)
**Basis:** ADR-0104（推翻 ADR-0097 Decision「不做预置常用域兜底集」，修订「允许集只认用户层 settings」为「preset（代码承载）∪ 用户层增量」）；`docs/CONTEXT.md`「预放行档（builtin preset）」「域名允许集」词条；承接 `specs/network-egress-allowlist.md`
**Surface:** 新增 `src/harness/sandbox/egress/preset-domains.ts`、`src/harness/sandbox/egress/assembly.ts`（合并语义 + 工厂恒返 policy）、`session.ts` / `violations.ts`（`allowlistSource` 标签重定）、`src/harness/aci/tools/bash.ts`（source fallback 接线）、既有 egress 测试（`tests/harness/sandbox/egress-assembly.test.ts` 等断言反转）

## Goal

把「默认安全」从实测证实的失败形态（默认不可达：`git push` / `gh` 全 DNS 失败、批准门死在入口、模型烧 12 分钟走 6 条死路 workaround——conversation `ee13c787`）改回可用：出厂即带**预放行档**（代码承载的 6 条高频构建/交付域），同时恢复 ADR-0097 生命周期表「允许集非空**或批准流可问**才起」的起 session 条件——preset 非空使生产入口默认起 egress session，首见域名批准门从死码恢复在岗。

## Boundaries

- **Does:**
  - 新增 `preset-domains.ts`：`BUILTIN_PRESET_ALLOWED_DOMAINS`（frozen 数组，**清单 SSOT 仅此一处**）= `github.com`、`*.github.com`、`*.githubusercontent.com`、`registry.npmjs.org`、`playwright.download.prss.microsoft.com`、`cdn.playwright.dev`（apex 与 `*.x` 并列写——`*.x` 严格子域不含 apex 是 0097 实测语义，缺一漏面）。
  - `createEgressPolicyFactory` 合并语义：`allowedDomains = preset ∪ 用户层 allowedDomains`（去重后顺序：preset 在前、用户增量在后，便于人读）；`deniedDomains` 只取用户层，**deny 优先不变**（用户可用 denied 精确砍掉任一 preset 域）。
  - **配置段缺席也起 session**：`settings.isolation.network === undefined` 时工厂不再返回 `undefined`，改返回 preset-only policy（见 T1；同时修复 0097 生命周期表实现落差，显式引用见下）。
  - `allowlistSource` 标签重定 + 违例文案联动（见 T2）。
  - 三消费面（bash 前台 / background / verify，均经 `createEgressPolicyFactory` 派生）自动获得 preset，无需各面单独接线。
- **不变（显式重申，防漂移）：**
  - `--unshare-net` 恒在、代理缝结构、地址守卫（loopback / 私网 / link-local / metadata + `DEFAULT_PRIVATE_DENIED_RANGES` opt-in 注入）、首次批准流、违例回灌三跳通道——全部照 ADR-0097 / 前 spec 逐字不动。
  - **项目文件不采纳**：`mergeIsolationNetwork` 忽略 project 段（ADR-0084 纪律）；preset 的正当性来源是「代码承载、经代码变更流与 review」，不是任何 settings 层放宽。
  - 模型供应商 API 域**显式不入档**（围栏内有 key，预放行 = secret 直传通道）——单测钉住 preset 清单不含已知 provider 域。
  - 预放行收口原则：后续新增 preset 域须对照「可重复构建 / 交付流高频域」论证（ADR-0104 §Decision 4），走代码 review。
- **Out of this spec:**
  - SSH remote push（git-over-SOCKS / ProxyCommand，0097 T7/T8 扩展遗留）；凭据面（gh 登录态、ssh-agent）出口另案。
  - `web_fetch` / `web_search` 的 network-guard 栈（另一条防线）。
  - settings schema 形态变更（`isolation.network` 键不改；只是「缺席」的下游语义从「无 session」变「preset session」）。

## Settled invariants

1. **preset 是代码常量不是配置**：不新增任何 settings 键、不可被项目文件 / 用户配置关闭整个档（用户可逐个 `deniedDomains` 砍——deny 优先是逃生通道，不需要「关档」开关）。
2. **允许集全集 = preset ∪ 用户增量，deny 优先**：判定输入构造只发生在 assembly 一处（SSOT），任何消费面不得再自行拼 preset。
3. **egress session 起条件兑现 0097 生命周期表**：生产装配下工厂**恒返 policy**（preset 非空 ⇒「允许集非空」恒真）；`EgressPolicyInput | undefined` 的 `undefined` 分支仅保留给「调用方显式不装配 egress」的测试 / yolo 类豁免路径，不再由「settings 段缺席」触发。ADR-0097 §生命周期表「bash handler fence 装配期，且仅当本次调用具备出网资格（允许集非空或批准流可问）才起」——现状实现（`assembly.ts:84-89` 段缺席 → `() => undefined`）与该表存在落差，本 spec 以 preset 非空闭合该落差，不另立文字例外。
4. **`allowlistSource` 语义与撞名清算**：现值 `"preset"` 指「用户层预置 settings 段」，与 ADR-0104 新词「预放行档 = builtin」**撞名**；本 spec 重定为封闭三档 `"builtin" | "persisted" | "session"`（见 T2 表），全链路（类型、生产者、渲染、测试）一次改齐，不留旧值别名。
5. **fail-closed 面不缩**：批准门非交互入口拒绝、代理死 fail-closed、地址守卫正交——前 spec invariant 3/6/7 逐字继承。
6. **纯 infra 文案不掺配置指引**（前 spec「三类信号可区分」）：新增 source 标签只出现在域判定段。

## allowlistSource 重定（T2 的钉死表）

| 档          | 生产者                                                                                                                 | 语义                           | 违例文案 `SOURCE_LABEL`（英文渲染行不变格式：`Current allowlist source: <label>.`） |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| `builtin`   | `assembly.ts`：settings `isolation.network` 段**缺席**                                                                 | 仅出厂预放行档在场             | `built-in preset allowlist (github / npm / playwright defaults)`                    |
| `persisted` | `assembly.ts`：settings 段在场（原 `"preset"` 值的本名）                                                               | 用户持久化 settings 增量并入档 | `user-settings persisted allowlist`                                                 |
| `session`   | `bash.ts` 工厂包装层：caller 未显式设 source 且交互批准面在场时的 fallback（既有 fallback 逻辑改常量引用）；批准流产物 | 会话级批准放行在场             | `session-level allowlist`                                                           |

联动点（grep 实证全集）：`violations.ts:29`（`EgressAllowlistSource` 类型）、`violations.ts:173-177`（`SOURCE_LABEL`）、`session.ts:78`（inline union 改引用 `EgressAllowlistSource`，消双处漂移）、`assembly.ts:19/:66-70/:104/:119`（注释 + 赋值）、`bash.ts:632-645`（fallback 注释与 `"session" as const` 保持、注释重述）、`tests/harness/sandbox/egress-violations.test.ts` 等。`persisted` 档自始有真生产者（原 `"persisted"` 值零生产者，属占位）。

## 任务拆分

### T1 — preset 常量 + 合并装配（`preset-domains.ts` + `assembly.ts`）

- `BUILTIN_PRESET_ALLOWED_DOMAINS`：frozen、6 条目逐字 = Boundaries 清单；文件注释挂 ADR-0104 与收口原则。
- `createEgressPolicyFactory`：
  - 段缺席 → `() => ({ allowedDomains: [...preset], deniedDomains: [], commandLabel, allowlistSource: "builtin" })`（**不再返 `undefined`**）；
  - 段在场 → `allowedDomains = 去重(preset ∪ network.allowedDomains)`、`deniedDomains = network.deniedDomains ?? []`、`allowlistSource: "persisted"`；
  - 用户段在场但两列表皆空 → 同「在场」路径（preset 仍在场，`allowlist-empty` 经工厂路径不可达，见 Failure paths F2）。
- `buildEgressPolicy` 签名接 preset 来源；工厂返回类型保持 `() => EgressPolicyInput | undefined` 不缩（background / verify 消费面类型零改动），但生产装配路径恒非 `undefined`。

**验收**：`egress-assembly.test.ts` 断言反转——旧「段缺席 → undefined」改为「段缺席 → preset-only policy, source `builtin`」；合并去重、preset 前置次序、用户空列表不覆盖 preset、`decideEgress` 直喂合并结果时 `github.com` apex 与 `api.github.com`（`*.github.com`）双命中、`registry.npmjs.org` 命中而 `npmjs.org` apex **不**命中（清单只写了 registry 子域——钉住不误扩）、`evil-github.com` / `github.com.evil.io` 不命中（后缀锚定回归）。

### T2 — `allowlistSource` 重定与文案联动

按上表把 `"preset"` 全链改名 / 改值 / 改渲染，`session.ts` inline union 收敛为引用；`not-in-allowlist` 与 `no-approval-inlet` / `denied-by-user` 行文案不变结构（配置键指引仍指 `isolation.network.allowedDomains`——preset 在场时用户增量仍是补配处）。

**验收**：`EgressAllowlistSource` 三档各有真生产者与消费渲染测试；grep 断言全仓无字符串 `"preset"` 残留在 source 语义位（`"built-in preset allowlist"` 渲染文案除外）；`bash-egress-typed-failure.test.ts` / `egress-violations.test.ts` 迁移后 source 标注逐字钉子绿。

### T3 — 批准门恢复在岗 + 生命周期落差闭合的测试钉

- bash 前台（交互入口）：**无 settings 网络段的干净装配**下，访问档外域（如 `example.com`）→ 首见批准门触发（ask 一次），批准 → 本会话放行；拒绝 → `denied-by-user` 违例回灌 `execution_failed`。
- background / verify（非交互）：干净装配下档外域 → `no-approval-inlet` fail-closed（与旧「session 根本不起、命令纯断网」区分——现在违例回灌**有名字**，模型拿到的是可行动文案而非静默 DNS 失败）。
- 生命周期表闭合：`build-engine-egress-wiring.test.ts` 增断言——`settings` 无 `isolation.network` 时 `egressPolicyFactory()` 返回非 `undefined`（引用 ADR-0097 §生命周期表 + ADR-0104 §Consequences「副作用（正向）」）。

**验收**：以上三条各有单测（复用 T6 注入 filter 驱动 seam，不真起代理）；「批准门死在入口」的旧行为有回归测试反转记录。

### T4 — preset 域真实可达（probe / 实测层）

- `npm run probe:sandbox` 全类别维持全绿（仓规：动 fence 相关必跑）；如 probe 网络类别现有形状（`sandbox-probe.ts:291-367` loopback listener 档）不便扩真域，则**不强行加真网 probe**（CI 网络面不稳定），可达性证据下沉到 T5 实测。
- 判定层：`decideEgress` 纯函数吃合并集（T1 已含）。

**验收**：probe 全绿报告；若实现期新增真域 probe 类别，须同步 `security-boundaries` 的 11 类探针纪律说明——默认**不加**，避免 CI 抖动（登记于此）。

### T5 — TUI pty 实测（进会话改动的仓规地面）

`mcp__aiterm__pty_*` 起 TUI（干净 settings：无 `isolation.network` 段）：①`curl -sI https://github.com` 直通（preset 档内，无需批准）；②`curl -sI https://example.com` 触发首见批准门，拒 → 屏上 tool_result 含 `[network_denied]` + `Current allowlist source: built-in preset allowlist (github / npm / playwright defaults).` 字面；批 → 同会话再访不再问；③`git push --dry-run`（https remote）在档内可达（若凭据面未就绪，如实登记遗留，不算本档失败——Boundaries Out of scope）。

**验收**：三条操作的屏上证据（transcript 片段）入验收报告。

## Failure paths

| #   | 路径                                          | 行为                                                                                                                                                         |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | 用户 `deniedDomains` 含 `*.github.com`        | deny 优先砍掉 preset 子域；`github.com` apex 仍在（pattern 语义实测：`*.x` 不含 apex）——文案与测试都钉住该不对称                                             |
| F2  | `allowlist-empty` reason                      | 经工厂路径不可达（preset 恒非空）；判定件与渲染件保留（session 可被测试 / 其他调用方直喂空集），不删码                                                       |
| F3  | 用户 settings 段 shape 非法被 settings 层丢弃 | `network = undefined` → **preset-only 起 session**（旧行为是「无 session」；新行为 fail-closed 语义不变——preset 仍是窄集，丢弃留痕纪律在 settings 层已承担） |
| F4  | 宿主缺 socat                                  | 与档无关：session 起不来 → `SocatUnavailableError` → infra 文案（含装指引），不冒充域判定拒绝（既有 SC13 面，回归即可）                                      |
| F5  | preset 域解析到私网 / loopback（rebinding）   | 地址守卫照拒（invariant 5：preset 命中不豁免守卫），`address-denied` 文案不变                                                                                |
| F6  | yolo / isolation OFF 装配路径                 | 无 fence 即无 egress 消费面，两轴正交（0097 边界不变）；确认 `createEgressPolicyFactory` 在该路径不被调用即可，不加逻辑                                      |

## Success criteria

- **SC1**：干净装配（无任何 network 段）下三消费面均起 egress session，允许集 = preset 6 域；`assembly` 返 `undefined` 分支在生产装配路径不可达（wiring 测试）。
- **SC2**：preset 清单逐字 = ADR-0104 §Decision 1 六条目，SSOT 单文件；含「无已知 LLM provider 域」的反向断言测试。
- **SC3**：合并语义四断言：apex+子域并列命中、用户增量并集、deny 优先可砍 preset、用户空列表不缩档。
- **SC4**：`allowlistSource` 三档 `builtin/persisted/session` 各有生产者与 `SOURCE_LABEL` 渲染钉子；`"preset"` 旧值全仓清零（grep 断言）。
- **SC5**：首见批准门在干净装配下可触发（交互 ask 一次 / 非交互 `no-approval-inlet`），闭合 ADR-0097 §生命周期表与实现的既有落差（T3 钉子显式引用该表）。
- **SC6**：`npm test` 全绿（含反转的 `egress-assembly` / `bash-egress-approval` / `bash-egress-typed-failure` / `build-engine-egress-wiring` / `egress-violations` 与 manager / verify 相关迁移）+ `npm run probe:sandbox` 全绿 + TUI pty 实测（T5）证据留档。
- **SC7**：项目层 settings 写 `isolation.network` 仍整段丢弃（前 spec SC9 回归，不因 preset 引入而松动）。

## Inherits / Changes

- **继承**：`specs/network-egress-allowlist.md` 全部 Settled invariants / Violation feedback channel / Ownership-dispose 契约 / 三类信号可区分；ADR-0084 项目层不采纳；`decideEgress` 判定次序与地址守卫档。
- **变更**：ADR-0097 两条（已由 ADR-0104 + 0097 Amended clause 落盘，本 spec 不改 ADR）；`assembly.ts` fail-closed 缺省语义（段缺席 = 无 session → 段缺席 = preset session）；`EgressAllowlistSource` 枚举重定；`CONTEXT.md`「预放行档」「域名允许集」词条已随 fa7e8ac1 落地，本 spec 与之对齐（撞名清算即词条中 builtin preset 的代码正名）。
- **不动**：settings schema、domain-matcher 判定次序、session/proxy/桥生命周期、violations 记录与 drain 通道。

## Open questions

- OQ1：批准写回用户层 settings（0097「可选附属动作」）至今无实现（`approval.ts` 无 writeBack 路径、`"persisted"` 无生产者）——本 spec 的 `persisted` 档暂由「settings 段在场」承担生产者角色；写回 API 落地时应把批准后持久化的来源标注接上，是否扩第四档（批准且写回）届时另裁，不阻塞本 spec。
- OQ2：`playwright.download.prss.microsoft.com` / `cdn.playwright.dev` 是否覆盖 CI 镜像源实际需求，以 T5 实测（webui 浏览器二进制下载）复核；若另有高频构建域需入档，按 ADR-0104 §Decision 4 收口原则另走代码变更流，不入本 spec。

## Evidence pointers

- 事故：conversation `ee13c787-5958-4524-95d3-0e89d520f12a`（`Could not resolve hostname github.com`、`gh auth status → Failed to log in`、无代理 env）。
- 实现落差锚点：`src/harness/sandbox/egress/assembly.ts:84-89`（段缺席 → `() => undefined`）vs ADR-0097 §生命周期表「允许集非空或批准流可问才起」。
- 撞名锚点：`assembly.ts:19/:119`（现 `"preset"` = 用户层预置）vs `docs/CONTEXT.md:214`（「预放行档（builtin preset）」= 代码承载）。
- 消费面：`bash.ts:636-657`（工厂包装 + session fallback）、`background/manager.ts:171`、`verify/sandbox-run.ts:67`、`build-engine.ts:1193-1200`。
- 判定与文案件：`domain-matcher.ts`（`decideEgress` 次序、`DEFAULT_PRIVATE_DENIED_RANGES`）、`violations.ts:29/:173-177`（source 类型与标签）。
- 实测语义前提：`*.x` 不含 apex / 后缀锚定 / 大小写不敏感（ADR-0097 §Evidence pointers）。
