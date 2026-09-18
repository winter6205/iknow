# 0097. 出口代理缝：`--unshare-net` 恒在 + 域白名单代理，取代 per-call `network:true` 全放行

Date: 2026-09-16
Status: accepted

> **Amended clause（ADR-0104 / 2026-09-19）**：Decision 段「**不做**『预置常用域兜底集』」已被推翻，「允许集只认**用户层** settings」修订为「**预放行档**（代码承载 preset）∪ 用户层增量」——项目文件仍不采纳（ADR-0084 纪律不变）。其余条款（`--unshare-net` 恒在、代理缝结构、首次批准流、地址守卫、违例回灌、生命周期表）逐字不变。

## Context

bash 围栏的出口语义长期是二值的：`--unshare-net` 默认断网（`src/harness/sandbox/bwrap.ts:162`），`network:true` per-call opt-in 摘除它 = 宿主网**零过滤**全放行（ADR-0022）；中间没有任何可表达「允许这几个域」的档位。与此同时 `STATIC_NETWORK_WHITELIST` / `NetworkPolicy.assertDomain`（`src/harness/sandbox/network-policy.ts:4`）是**声明了但从未实施**的死码（`bwrap.ts:224` 直接 `void opts.networkPolicy`）——仓库里挂着一个不存在的机制的名字。

ADR-0022 判「域名过滤不做」的依据是「内核层无抓手，做出来是装饰」——该判断对**内核级**过滤成立，但漏评了**代理路线**：netns 全断 + 文件系统出一条缝（unix socket bind 进沙箱），域判定在宿主侧代理做（HTTPS 只看 CONNECT host，不解密），无需 TUN 转发器、无需用户态 TCP/IP 栈、无需 TLS 终止、无需自建 CA——ADR-0072 列的四个组件一个都不需要。ADR-0072 的重开触发条件 3（对外承诺域名级白名单）由此命中。

## Decision

`--unshare-net` 改为**恒定项**（不再被任何路径摘除）；唯一出网通路 = **出口代理缝**：宿主出口代理（HTTP CONNECT + SOCKS5）的 unix socket bind 进沙箱，socat 在**宿主与沙箱两侧**各转一段（宿主：unix socket → 代理 TCP；沙箱内：本地端口 → unix socket），`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 等环境变量指过去。域判定 = **域名允许集**（CONNECT host 命中才转发；`*.x` 严格子域不含 apex、可选 `:port` 后缀、deny 优先）；地址守卫（拒 loopback / 私网 / link-local / metadata）与域名集正交。允许集只认**用户层** settings（ADR-0084 纪律，项目文件不采纳）。

**`socat` 是宿主前置依赖，且不由本仓分发**（实测：包内 `vendor/` 只有 seccomp / srt-win / java-proxy-agent，无 socat；缺它时上游报 `socat not installed`）。缺失时网络能力 **fail-closed**（不静默降级为「无网」），并给出补装指引。

**代理的拒绝文案是硬编码常量**（实测 `http-proxy.js` 的 `ALLOWLIST_DENY`，无 options 注入点）：403 body 恒为 `Connection blocked by network allowlist` + `X-Proxy-Error: blocked-by-allowlist`。「可行动违例详情」（被拒域名 + 允许集来源 + 补配指引）**由本仓承担**——在传给代理的 `filter` 回调里记录，经 bash tool_result 的 `stderr` 回灌，前缀沿用既有的 `VIOLATION_PREFIXES.networkDenied`（该前缀**保留并升级**，使 mid-tier 升级路径继续生效）。这不是实现细节而是决策：把违例文案的所有权留在本仓，代理仅作判定执行者。

per-call `network:true` 字段与其 ask 规则（`code-ask-bash-network`）**整体废除**——不是新旧并存、不留逃生门。依赖面只取 `@anthropic-ai/sandbox-runtime`（Apache-2.0，pin 版）的**网络半场**（代理 + 桥 + 匹配器 + 地址守卫）；bwrap argv 仍由本仓自装配（fsMode / workspace mount / argv 顺序纪律不动）。

**首次域名批准流是结构件，不是可选项**：交互入口首见新域名 → 走既有 ask 面问一次 → 批准 = 会话级放行 + 可选持久化到用户层 settings；非交互入口（background / verify / 无 ask 面）无法问 = **fail-closed 拒绝**（违例含缺失域名与补配指引）。配置白名单（`isolation.network.allowedDomains` / `deniedDomains`，仅用户层）是**预置**路径，用于 CI 与免打断场景——两者并存，不是批准流被配置取代。理由：只有配置白名单会让日常退化为「被拒 → 手改配置 → 重跑」；只有批准流则 CI 无法预先声明边界。**不做**「预置常用域兜底集」——等于静默放宽边界。

**代理生命周期 / dispose 契约（2026-09-17 裁定，spec「Ownership / dispose contract」的显式接口化）**：三形态共用同一接口形状「起桥 → 绑定 socket → 注入环境变量 → 收尾清理」，**异常路径（spawn 失败 / 执行抛错 / 任务中止）与正常路径走同一释放通道**——泄漏的 socat / 代理进程是下一次调用的 stale socket 来源。逐形态时机：

| 形态                        | 起                                                                                  | 绑 + 注入                                                                                         | 释放                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 前台 bash 调用（per-call）  | bash handler fence 装配期，且仅当本次调用具备出网资格（允许集非空或批准流可问）才起 | 桥 socket 经 bwrap `--bind` 进沙箱；`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 经 `--setenv` 注入 | 调用收尾（成功 / 失败 / 异常同一 finally）kill 代理 + socat 进程、清 socket                                           |
| background 任务（per-task） | 任务 spawn 装配期起，随任务存活                                                     | 同上，注入走 manager 的 fenceEnv                                                                  | 挂 `settle()`（terminal-state 迁移单次触发点，exit 事件与 shutdown 级联共用）；spawn 失败路径在 settle 触发前直接清理 |
| verify（随宿主）            | 模块级单例，首次使用 lazy 起，跨调用复用                                            | 同上                                                                                              | 随宿主进程退出；shutdown 钩子兜底清理                                                                                 |

stale socket 防线（对应 spec Failure paths）：socket 路径带 per-session 随机 id + 启动前清理；残留 socket 的连接失败归类为基础设施故障，不误报域判定拒绝。

**批准持久化粒度（2026-09-17 单一裁定）**：批准 = **会话级放行必成**（入 session-grants 镜像容器，进程内存活）；写回用户层 settings（`isolation.network.allowedDomains`）是批准的**可选附属动作**，不是批准的必要条件——写回失败降级为仅会话放行 + 一次性警告，已批准的调用照常执行，不回滚。非交互入口无批准流，只能走预置配置。

## Considered Options

- **TUN + 用户态栈（ADR-0072 路线）**：为「内核级强制 + 内容检查」付一个子系统的价；域名白名单（不做内容检查）不需要它。拒。
- **per-call ask 保留、只加域过滤**：ask 是「一次批准 = 环境信任」，与域白名单的「持续边界」是不同轴，叠加保留会让模型面对两条互相干扰的出口语言。拒。
- **IP 白名单（nftables + DNS 钉扎）**：域名→IP 是 N:M 且随 CDN 轮换漂移，等价于误伤与漏网并存。拒。

## Consequences

**正面 / Applied:**

- 出口可表达且 fail-closed：未命中允许集 = 代理拒绝（带违例详情回灌），不再有「批准即全开」。
- 结构单点：`--unshare-net` 永在，出网资格只由域判定一处回答，非交互入口（background / verify / 无 ask 面）与交互入口同规则。
- 死码清算：`STATIC_NETWORK_WHITELIST` / `NetworkPolicy.assertDomain` 由真匹配器取代（接口形状保留并升级，不另立第二套）。

**负面 / Trade-offs:**

- 「沙箱内起服务 → 宿主可达」能力消亡（旧 ADR-0022 的核心用例）：netns 恒断下无反向通路，代理只管出站。如需反向可见性须另开独立轴，不在本决策内。
- **domain fronting 不可防**：代理只看客户端自报 host、不解密，`github.com` 放行即允许经该域外泄。本决策解决「能连到哪」，不解决「连上后传了什么」——不得表述为内容级管控。
- 非代理感知程序（raw socket / 不读 `HTTP_PROXY` 的工具）在沙箱内 = 断网；代理/桥进程死 = fail-closed（连不上）。用户可见行为变化，需违例详情回灌质量兜底。
- 引入 `@anthropic-ai/sandbox-runtime`（beta 0.0.76，API 可能漂移）：只用网络半场。spike 已验**匹配器与地址守卫可独立导入**（`domain-pattern` / `address` / `resolved-address-guard` / `parent-proxy` 只依赖 `node:*`），代理 server 件需完整依赖安装后可导入，且**硬依赖 `node-forge`**（MITM 模块在加载图上无法裁掉，即使运行时不终止 TLS）。**包无 `exports` 字段** = 深路径导入可用但无契约稳定性 → 经单一适配层收口，升级只改该文件。
- 多一条宿主依赖：`socat`。缺失即无网络（fail-closed + 指引），本决策不承担 socat 分发。

## Evidence pointers

- `src/harness/sandbox/bwrap.ts:162`（`--unshare-net` 现状）、`:224`（`void opts.networkPolicy` 死码锚点）、`src/harness/sandbox/network-policy.ts:4`（`STATIC_NETWORK_WHITELIST`）。
- `src/harness/permission/policy.ts`（`code-ask-bash-network` 废除对象）；`src/harness/aci/tools/bash.ts`（`network` input 字段废除对象）。
- 外部调研（2026-09-16）：`@anthropic-ai/sandbox-runtime` 源码 `linux-sandbox-utils.ts` 装配序（netns 恒 unshare + socket bind + 两侧 socat + 代理环境变量）、`domain-pattern.ts` 匹配语义（零依赖、Apache-2.0）、`resolved-address-guard.ts` 地址守卫。
- **实测（2026-09-16/17，包 0.0.76）**：四件纯逻辑件（`domain-pattern` / `address` / `resolved-address-guard` / `parent-proxy`）在**无 node_modules** 时即可 import；`http-proxy` / `socks-proxy` 需完整依赖。**`http-proxy` 无条件拉入 `node-forge`**（`http-proxy.js:8` 静态 import `CRL_PATH` ← `mitm-ca.js:10` 顶层 `import forge`）——「MITM 惰性」只在**运行时**成立（不传 `mitmCA` 即不终止 TLS），模块加载图上 node-forge 是硬依赖（早先据 `moduleLoadList` 判定「不加载」有误，该方法不追踪 ESM 用户态模块）。拒绝文案硬编码（`http-proxy.js:10-13`）；`socat` 未 vendored（`linux-sandbox-utils.js:437-438` 报 `socat not installed`），本机 `which socat` = 无。
- **地址守卫的私网档是 opt-in**：复用件 `DENIED_CLASSES` **故意不含** RFC 1918 / ULA / CGNAT（`resolved-address-guard.js:52-65` 注释明写「allow-listing an intranet hostname is legitimate」），须经 `deniedResolvedAddresses` 显式传入——本决策要求拒私网，故适配层必须传，否则该防线落空。
- 信号可分实测：未命中 → 403 + `X-Proxy-Error: blocked-by-allowlist`；命中但上游死 → 502；畸形 → 400（不崩）。
- 域匹配语义实测：`*.example.com` 匹配子域、**不**匹配 apex；`evilexample.com` 不匹配（后缀锚定正确）；大小写不敏感；端口非法值（`:0` / `:65536` / `:abc` / 空）**不抛错**、静默退化为永不匹配（→ 需配置层拒绝）。
- spec 落点：`specs/network-egress-allowlist.md`（rev 2，ACR 三项 `no` 已收敛）。
