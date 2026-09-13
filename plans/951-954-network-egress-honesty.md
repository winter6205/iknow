# Plan: 网络出口诚实化与防线（#951 #952 #953 #954）

**Goal:** 网络出口两条路的真实强度被诚实披露并处置：`bash network:true` 批准轴诚实化（#951 文案 + #952 资格门禁），`web_fetch` 默认路径的 DNS-rebinding TOCTOU 先 spike 定处置（#953），最后用 ADR-0072 诚实记录 TUN 出口过滤「可行但不做」+ 当前替代方案的真实强度（#954）。

**Approach:** skip-spec —— #951/#952 的设计已在各自 issue 定死（形=定死），issue 正文即设计真值，本 plan 只做 tracer bullet 切分。三簇：(1) **#953 spike** 是 AFK 决策输入，威胁模型已证真实（见下「威胁模型」），可立即起、与实施并行，出结论按**预定判据**决定 #953 实施或 defer；(2) **#951+#952** 是已定死实施，代码不相交可并行，合成一个「批准轴诚实化」逻辑变更（两次 commit，可一 PR）；(3) **#954 ADR-0072** 收口，downstream of #953 判据 —— 诚实写「真实强度」必须知道 TOCTOU 是被修还是被 defer。#953 spike 与 #951/#952 实施无依赖，全并行。

**Spec link:** skip-spec（#951/#952 issue 正文即设计真值，参照 `plans/556-562-builtin-catalog-bash-readonly.md` 的 skip-spec 先例）。设计真值：#951 https://github.com/winter6205/iknow/issues/951 · #952 https://github.com/winter6205/iknow/issues/952 · #953 https://github.com/winter6205/iknow/issues/953 · #954 https://github.com/winter6205/iknow/issues/954。相邻 ADR：`docs/adr/0022-*`（bash network 批准轴）、`docs/adr/0072-*`（本 plan T5 产出）。

**Tracker:** GitHub main path（`gh` 可用，已 auth winter6205）。bullet → issue 映射：**T1/T4=#953 · T2=#951 · T3=#952 · T5=#954**。native blocking 边（GraphQL `addBlockedBy`）：**T4←T1**、**T5←T4**；T1/T2/T3 无前驱（三者可并行）。父跟踪 = wayfinder map **#956**（https://github.com/winter6205/iknow/issues/956）。

**ACR:** **待跑（实施前 gate）。** 本 plan 跨 >3 文件、跨模块（`permission` + `aci/tools` + `sandbox`/network-guard + `docs/adr`），触发 `arthurpower:architecture-change-reviewer-agent`。T2/T3 落地前必须过 ACR 五维 verdict；本规划会话不 fabricate verdict，留待实施方跑并回填。

**Per-ticket loop (all bullets):** `arthurpower:test-driven-development` → typecheck + tests → `arthurpower:code-review` → `arthurpower:verification-before-completion` → one commit on the ticket branch。全部 bullet 落地后再跑一轮 `code-review`。

> **本计划的 headroom：** 钉切片形状、不变量与判据，不钉补丁。除已被代码冻结的名字（`NETWORK_HINT_MARKER` / `isBashNetworkTrue` / `SUPPORTED_PREDICATES` / `ensurePublicTarget` / `followGuardedRedirects`）外，文件内 helper 拆分留给实施方。

---

## 威胁模型（已实测，不是假设）

**根因（一句话）：** `web_fetch` 的 URL 供给面是**开放的** —— 模型填任意 `url`，无域名 allowlist、permission 默认 allow、且 ≤5 跳重定向让「良性 URL 302 到攻击者域名」也成立，因此 `network-guard` 第 4 层「校验用 lookup」与「生产 fetch 再解析」之间的 DNS-rebinding TOCTOU 是**真实、模型可达、在默认路径上**的洞，不是理论洞。

**支撑证据（read-only explorer，2026-09-08）：**

| 观察                        | 结果                                                                                | 证据                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| web_fetch `url` 参数        | 模型自由填，无 enum/域名约束                                                        | `web-fetch.ts:147-175`                                                                                   |
| URL → guard 之间是否有 gate | 无 allowlist、无 config 门、直接进 `fetchPublicResponse`                            | `web-fetch.ts:90-99`                                                                                     |
| web_fetch permission        | `read-only` → 默认 `allow`，无 per-URL ask                                          | `policy.ts:25-32`、`policy.ts:40-41`                                                                     |
| 域名/出口 allowlist         | **全代码库不存在**（只有无关的 bash 命令 allowlist）；guard 是纯 denylist           | grep `allowedDomains\|egress\|trustedHost` 0 命中；`ip-classify.ts` + `network-guard.ts:132-145,417-419` |
| 重定向放大                  | ≤5 跳，每跳 `redirect:"manual"` 跟随 `location`，rebinding 窗口逐跳存在             | `network-guard.ts:44,304-326`                                                                            |
| web_search bing（默认后端） | `search_url` 模型可覆写端点 host，仅 SSRF 校验、不 allowlist → 同样开放             | `web-search.ts:250-269,409-412,684`                                                                      |
| web_search exa 后端         | 固定 `https://api.exa.ai/search`，模型无 URL 影响，绕过 guard（native fetch）→ 无害 | `web-search.ts:731,802-827`                                                                              |
| TOCTOU 自记                 | 代码自己记的已知边界，指名「后续工单」= #953                                        | `network-guard.ts:15-17`                                                                                 |

**成本驱动（#953 spike 的最大未知）：** guard 走 Node 的 `globalThis.fetch`（Node 自带 undici），**不是** undici@7；已有 ProxyAgent 的 type-incompat bridge（`network-guard.ts:34-41,237-241`）。钉扎能否经现有 bridge 传进去，还是逼着迁到 undici 自己的 `fetch`（迁了就是动默认路径主干行为，量级同 #954 的「子系统」）—— 这条决定 #953 是聚焦补丁还是 defer。undici@7.29.0 可用 API 面：`dns` interceptor 自定义 `lookup`（`lib/interceptor/dns.js:142,151,177`）、`buildConnector`、`Dispatcher.prototype.compose`（`lib/dispatcher/dispatcher.js:20`）。

---

## 预定判据（T1 spike 出结论后 T4 直接套，不再悬）

- **聚焦改动**（自定义 connector/dispatcher 经现有 bridge 传入，或 connect-then-verify peer IP，**不迁** fetch 实现，`GuardFetchOptions` 接口改动有界）→ **开 #953 实施票**（形状 spike 落地才清晰，暂列 fog）。
- **逼迁 fetch 实现 / 成子系统**（必须弃 `globalThis.fetch` 改 undici 自 fetch，或钉扎 + 代理 + 多 A 回退 + 逐跳线程化交织成子系统）→ **defer**，在 T5 ADR-0072 里诚实记为「真实可达但未缓解的 TOCTOU」+ 重开触发条件，量级同 TUN「可行但不做」。

---

## Tasks (ordered by dependency)

Each numbered item is one tracer bullet: one vertical-slice outcome, one tag, one commit（T1 spike 不 commit 产品代码）, headroom for the implementer.

1. **#953 DNS-pinning spike（AFK 决策输入）** — tag: `[decision]`
   - **Inherits:** 威胁模型（web_fetch 开放面、模型可达、重定向放大）；undici@7.29.0 API 面（`dns` interceptor 自定义 lookup / `buildConnector` / `compose`）；`globalThis.fetch` vs undici@7 边界（最大成本驱动）；`GuardFetchOptions`（`network-guard.ts:148-150`）只带 `signal`、无 pin 通道 → 钉扎需接口改动；逐跳重定向每跳独立 re-validate（`followGuardedRedirects:304-326`）。
   - **Surface:** throwaway `spikes/953-dns-pinning/`（**不动 `src/`、不 commit、全离线**，沿 `network-guard.ts:19-21` 的 fetch/lookup 注入先例）。
   - **评估三形态（不只全量钉扎）：** (a) `dns` interceptor 自定义 `lookup` 只返回已验证 IP；(b) `buildConnector` 直接 dial 钉扎 IP + 显式 `servername`；(c) connect-then-verify —— 连上后校验 socket peer IP ∈ 已验证集否则 abort（可能最便宜，作 interim）。
   - **Acceptance:** ① rebinding 桩（`lookup` 第 1 次公网 IP、第 2 次 `127.0.0.1`）在钉扎后连接目标仍是已验证公网 IP，离线断言 connector 实际 dial 目标；② `servername`/Host 对假想公网 HTTPS origin 保留（断言 connector args，不需 live TLS）；③ ProxyAgent 在场/缺席两种配置都被答清（在场至少设计/桩级，缺席 direct-connect 桩）；④ 多 A/IPv6 回退被约束在**已验证集内**（回退集外 = 重开 TOCTOU，须显式排除）；⑤ 逐跳重定向 pin 线程化方式说清 + `GuardFetchOptions`/`GuardFetchFn`（`network-guard.ts:166-169`）需要的接口改动描述（不实施）；⑥ 结论 `CONCLUSION.md` 答清 5 问 + 边界发现（Q2）+ 按上方判据给 implement-or-defer 建议 + spike 离线测不出的残留风险（live TLS 证书链、Node 自带 undici 版本漂移）。
   - Status: [ ] pending
   - [parallel]

2. **#951 批准文案说真话** — tag: `[implementation]`
   - **Inherits:** #951 改法 —— `NETWORK_HINT_MARKER`（`permission-executor.ts:493`，现 `[请求宿主网络] `）扩为 `[请求宿主网络·不经 network-guard] ` + hint 尾追加一行常驻说明（宿主 netns 全量可见：localhost 服务 / 局域网 / link-local 元数据 `169.254.169.254`；无 IP 过滤、无域名过滤）；`policy.ts:95-96` 的 `reason`（现 `changes the fence shape (host network)`）改同口径。沿用既有 80 字符命令摘要截断 + secret 警告机制，不改结构。
   - **长度封顶边界（必查）：** `markerLen` 是动态读的（`permission-executor.ts:507`），扩词自动调预留；但盯两个退化 —— (a) `markerLen + 3 > 80` 时 `slice(0, 负)` 使命令摘要空、hint 退化成 `marker + "..."`；(b) `SECRET_WARNING`（`:494-495,516-518`）是**叠加在 80 封顶之外**，marker 变长会推高总长，现有 hint 长度断言需同步。
   - **Surface:** `src/harness/permission/permission-executor.ts` + `src/harness/permission/policy.ts` + `tests/harness/permission/policy.test.ts`（SC8 块）+ `tests/harness/aci/permission.test.ts:56-92`（`code-ask-bash-network`）。
   - **Acceptance:** ask hint 文本含「network-guard 绕过」与「link-local 元数据」两项事实；`policy.ts` reason 与 hint 口径一致；命令摘要 + marker + secret 警告三者叠加总长仍在既定封顶内（长度断言同步更新）；上述两个测试文件相关断言全绿；`npm test` 绿。
   - Status: [ ] pending
   - [parallel]（与 T3 代码不相交）

3. **#952 `network_equals` 谓词** — tag: `[implementation]`
   - **Inherits:** #952 改法 —— 三处同步（一处漏即 fail-loud）：`SUPPORTED_PREDICATES`（`project-settings.ts:42-53`）加名 / ajv schema（`:74-83`，`additionalProperties:false` 保持）加允许值 / `matchPredicate`（`:170-212`）加 shape check，复用 `isBashNetworkTrue`（`policy.ts:43-51`）的严格 `=== true` 语义。**wrinkle（spike 已探明，spec 须点명）：** `matchPredicate(predicate, expected, inputObj)` 收不到 tool 名，但 `isBashNetworkTrue(tool, input)` 需要 → 要么把 tool 透传进 `matchPredicate`，要么改成 `inputObj.network === true` + 抽共享 helper（`buildRuleMatcher:149` 已 check `ctx.tool === toolName`，可沿此）。
   - **定位诚实标注：** 资格门禁，不是安全边界 —— 拦「模型有没有资格提这个请求」，批准后（或未设规则时）出站内容仍零过滤，**不得当 SSRF 防线宣传**。默认值不动，仍走 `code-ask-bash-network` 的 ask，不偷偷改 deny。
   - **Surface:** `src/harness/permission/project-settings.ts`（+ `policy.ts` 共享 helper 若走 refactor 臂）+ `.iknow/permissions.toml` 相关文档 + 对应单测。
   - **Acceptance:** `network_equals = true` 命中 `{ command, network: true }`；不命中 `network: false` / 缺省 / `"true"` 字符串 / 非 bash 工具的同名字段；未知谓词仍 fail-loud 且错误消息带失败 JSON path；项目层 deny 先于 code 层 ask 生效（`checkPermission` 分层顺序）；`.iknow/permissions.toml` 文档同步；`npm test` 绿。
   - Status: [ ] pending
   - [parallel]（与 T2 代码不相交）

4. **#953 处置决策（套判据）** — tag: `[decision]`
   - **Inherits:** T1 的 `CONCLUSION.md`；上方「预定判据」。
   - **Surface:** 无产品代码 —— 决策落 #953 issue comment（回写结论 + implement-or-defer）+ 若 implement 则新开实施票（fog，形状待 spike）；若 defer 则把「真实可达但未缓解」喂给 T5。
   - **Acceptance:** 判据二选一有明确结论 + 证据（spike 观察）；若 implement，实施票的 Surface/Acceptance 依 spike 推荐的钉扎形态成形；若 defer，T5 ADR 的「真实强度」段据此写。#953 issue 收到回写。
   - Status: [ ] pending
   - [blocks: T1]

5. **#954 ADR-0072（TUN 出口过滤「可行但不做」）** — tag: `[documentation]`
   - **Inherits:** #954 —— 修正「非特权下强制出口过滤不可能」为「可行但是子系统」，附三条实测证据（`/dev/net/tun` 存在且 `crw-rw-rw-` 可打开；`bwrap.ts:137-139` 已 `--dev-bind /dev /dev` 沙箱内可见；`--unshare-net`（`bwrap.ts:114`）新建 netns 内 bwrap 持 CAP_NET_ADMIN）；明确不做理由（用户态 TCP/IP 栈或 TUN 转发器 + 宿主代理进程 + TLS 终止/自建 CA + fail-open/fail-closed 抉择 + 与两既有面重排）；重开触发条件（真实数据外泄事故 / 开放给不受信操作员 / 对外承诺域名级白名单）；点名 #951/#952/#953 作当前替代与相邻议题。
   - **3 条件自检：** hard-to-reverse（弱 —— 是「不做某事」的决策，可后续重开）/ surprising-without-context（**满足** —— 推翻一条已记录的旧判断「不可能」）/ real-trade-off（**满足** —— enforcement vs 子系统成本）。判为**过 ADR bar**（推翻旧信念 + 重开触发条件是决策记录料），不降级为 spec 节。
   - **诚实强度（关键，依 T4）：** 当前替代方案 #951（知情）+ #952（资格）**不是强制过滤**；且 web_fetch 默认路径第 4 层有一个真实可达 TOCTOU —— 若 T4=implement，写明正在修；若 T4=defer，写明这是已知真实但未缓解的洞 + 重开条件。**不能让后来读者以为已有出口管控。**
   - **编号：** `docs/adr/` 最大号 0071 → 本 ADR = **0072**。`0046`/`0055` 各有同号重（并发会话产物）= 预存 hygiene 问题，**操作员单独裁定口径，本 plan 不 renumber**。
   - **附带观察（明确不并入本 ADR）：** `--dev-bind /dev /dev`（`bwrap.ts:137-139`）是全量绑设备面，而文件面是 deny-by-default 白名单（`createClosedWorldFsPolicy`（**2026-09-13 已随 ADR-0092 退役**））—— 两者姿态不一致，userns 下大概率不可利用，落 fog「值得单独看一眼」，不在本 ADR 展开。
   - **Surface:** `docs/adr/0072-<slug>.md`。
   - **Acceptance:** ADR 落 0072；含三条实测证据 + 不做理由 + 重开触发条件 + 真实强度（反映 T4 结论）+ 点名 #951/#952/#953；附带观察记为不并入；不 renumber 0046/0055。commit 无产品代码。
   - Status: [ ] pending
   - [blocks: T4]

---

## 依赖图

```
T1 #953 spike [parallel] ──▶ T4 #953 处置决策 ──▶ T5 #954 ADR-0072
T2 #951 批准文案 [parallel] ─┐
T3 #952 network_equals [parallel] ─┴─（批准轴诚实化，与 T1 无依赖，可同 PR 或各自 commit）
```

T1 / T2 / T3 三者互不阻塞，可全并行。T4 依赖 T1；T5 依赖 T4。T2/T3 与 T4/T5 无依赖 —— 批准轴诚实化可在 spike 进行时就落地。

---

## Out of scope（destination 之外，不 graduate）

- **bash `network:true` 的域名/IP 过滤**：过滤只能在进程自愿经过的出口点生效，bash 里是任意代码不自愿（#951「不做」）；要非自愿就得 netns 重定向（= T5 记的 TUN，已判可行但不做）。除非 TUN 重开，永久在外。
- **TUN 出口过滤子系统本身**：T5 ADR 记为「可行但不做」，不是本 plan 的实施目标。
- **#955 子代理能力面**：不同 bounded context（子代理身份 + 后台登记表所有权），代码 blast radius 与本簇不相交，走独立线（见 wayfinder map）。

---

## Fog（Not yet specified，暂不开票）

- **#953 实施票的具体形状**：仅当 T4=implement 才清晰 —— 钉扎形态（dns interceptor / buildConnector / connect-then-verify 三选一）、`GuardFetchOptions` 接口改动、逐跳 pin 线程化、是否迁 undici fetch，均待 spike 结论 graduate。
- **`--dev-bind /dev /dev` vs 文件面 deny-by-default 姿态不一致**（#954 附带观察）：值得单独看一眼是否可加固，但未 sharp 到能开票，且不并入 T5。
