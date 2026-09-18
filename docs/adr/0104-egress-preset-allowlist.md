# 0104. 出口域名允许集：代码承载的默认预放行档（推翻 ADR-0097「不做预置兜底集」条款）

Date: 2026-09-19
Status: accepted

## Context

ADR-0097 建成出口代理缝，但裁定「**不做**『预置常用域兜底集』——等于静默放宽边界」，默认姿态为空集 fail-closed，且允许集只认用户层 settings。实现上 `createEgressPolicyFactory` 在用户层 `isolation.network` 段缺席时直接返回 `undefined` = 本次调用不起 egress session（沙箱内无代理 env，`assembly.ts:84-89`）——即使交互入口的批准流明明可问，首见域名批准门（T6）也无从触发（与 0097 生命周期表「允许集非空**或批准流可问**才起」存在实现落差）。实测会话（2026-09-18，conversation `ee13c787`）证实后果：`git push` / `gh` 全部 DNS 失败，模型做了 6 条死路 workaround（SSH 参数、找代理 env、tool_search、curl 探测）烧约 12 分钟，PR 未开出。「默认安全」在实际使用中退化为「默认不可达」：用户不会预先配置允许集，批准门死在入口。

## Decision

1. **代码承载默认预放行档（builtin preset）**，出厂即允许：
   - `github.com`、`*.github.com`、`*.githubusercontent.com` —— HTTPS git、PR/REST API（api/codeload/uploads）、release/raw 资产；
   - `registry.npmjs.org` —— 包管理主路径；
   - `playwright.download.prss.microsoft.com`、`cdn.playwright.dev` —— webui 测试浏览器二进制。
2. 合并语义：允许集全集 = preset ∪ 用户层 `allowedDomains` 增量；`deniedDomains` **deny 优先**不变；地址守卫（拒 loopback / 私网 / link-local / metadata）不变；项目文件不采纳（ADR-0084 纪律）不变——preset 由代码承载、经代码变更流与 review，不是「项目仓自授」。
3. **模型供应商 API 域显式不预放行**：围栏内存在 API key，预放行即打开 secret 直传通道；此类域走首见批准门（人在场问一次）。
4. 预放行收口原则：只收「可重复构建 / 交付流」的高频域（git、PR API、包管理、测试浏览器二进制）；**允许集越窄，批准门越有价值**。后续新增 preset 域须对照本原则论证。

## Why not

- **保持默认空集 + 文档推荐配置**：默认不可达已被实测证实为失败形态；等于要求每个用户先撞墙再配置，且配置段缺席时 session 不起、批准门连被问的机会都没有——空集默认没有保住「问一次」的交互，只保住了「死路」。
- **预放行 LLM API 域**：secret 外泄面大于便利；agent 在围栏内跑真实模型测试是低频场景，批准门一次点按足够。

## Consequences

- 推翻 ADR-0097 Decision 段「不做『预置常用域兜底集』」条款，并修订其「允许集只认用户层 settings」表述为「preset（代码承载）+ 用户层增量」；0097 其余条款（`--unshare-net` 恒在、代理缝结构、首次批准流、地址守卫、违例回灌、生命周期表）逐字不变。
- 0097 对预置的顾虑（静默放宽）由三点吸收：preset 由代码承载、可审计、变更走 review（非静默）；窄面收口原则；LLM API 域显式排除。接受的残留风险：preset 域成为默认在场的数据外泄面（domain fronting 不可防，与 0097 §Trade-offs 一致，不因本决策扩大性质）。
- 副作用（正向）：preset 非空 = 生产入口默认起 egress session，首见批准门从「死在入口」恢复在岗，同时修复上文的 0097 生命周期表实现落差。
- 遗留（不在本 ADR）：SSH remote push 需 git-over-SOCKS / ProxyCommand 形态（0097 T7/T8 形态扩展）；凭据面（gh 登录态、ssh-agent）出口另案——逃逸重执行缝待立项。

## Evidence pointers

- 会话 transcript `~/.iknow/projects/iknow-ddcb805367a0/ee13c787-5958-4524-95d3-0e89d520f12a/`（2026-09-18）：`Could not resolve hostname github.com`、`gh auth status → X Failed to log in`、`tool_search("push pull request github remote") → no matches`、无代理 env。
- `src/harness/sandbox/egress/assembly.ts:84-89`（配置段缺席 → `undefined` → session 不起）；`src/harness/aci/tools/bash.ts:130-135`（缺省 = 纯断网，fail-closed 合法态）。
- `docs/adr/0097-egress-proxy-seam-domain-allowlist.md` §Decision（「不做预置常用域兜底集」原文）、§生命周期表（起条件「允许集非空或批准流可问」）。
- 域匹配语义（0097 已实测）：`*.x` 严格子域不含 apex——`github.com` apex 与 `*.github.com` 必须并列写，缺一漏面。
