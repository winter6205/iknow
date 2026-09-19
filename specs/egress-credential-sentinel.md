# Spec: 出口凭据 sentinel 代换层 —— 假值进围栏，真值只在宿主代理出口对放行域假换真

**Status:** rev 2（ADR-0107 不自动启用本 spec）
**Basis:** ADR-0105（本 spec 的主决策）；ADR-0097（代理缝结构、filter 回调语义、违例文案所有权在本仓、node-forge 硬依赖实测、生命周期表）；ADR-0104（放行域全集 = preset ∪ 用户层增量，deny 优先）；`docs/CONTEXT.md`「凭据 sentinel」「secret-roundtrip mask（#406）」「secrets guard」「域名允许集」「出口代理缝」词条（逐字引用，不重新定义）
**Surface:** `src/harness/sandbox/egress/`（新增 `credential-assembly.ts`，扩 `session.ts` / `assembly.ts` / `upstream.ts`）、`src/harness/sandbox/bwrap.ts`（EgressFenceSpec 扩 binds 段）、`src/harness/aci/tools/bash.ts`（装配接线）、`src/harness/background/manager.ts`、`src/harness/verify/sandbox-run.ts`（同一 factory 消费面）、`src/config/settings.ts`（用户层新段 `isolation.credentials`）、`scripts/sandbox-probe.ts`（可选探针类）、`package-lock.json`（零新增第三方依赖，见 invariant 8）

## Assumptions（编号清单——全部「待确认」，人类 gate 由主会话走）

1. 首期凭据源名册 = `GH_TOKEN` env 条目 + `~/.config/gh/hosts.yml` 文件条目（structured extract 掩码）+ 一般化形态（`credentials.files` / `credentials.envVars` 式：extract pattern + `decode: "jwt"`）；AWS 凭据对、GITHUB_TOKEN 等其余 env 源登记为远期不入首期。→ 待确认
2. 凭据条目配置承载 = **用户层 settings 新段 `isolation.credentials`**（entries 名册 + 每条目可选 `injectHosts` 收窄），项目文件不采纳（ADR-0084 纪律）；github 两条目由代码内置名册提供默认值，用户段只做收窄/追加。→ 待确认
3. 复用件路线：`SentinelRegistry` / `buildMaskedEnvVars` / `buildMaskedFileBinds` / `MaskedFileStore` / `createMitmCA` / http-proxy 的 `mitmCA` 系 options 全部经 `egress/upstream.ts` 单一适配层收口 re-export，**不复刻**；本仓其它模块不得直接 import 包内路径（0097 Dependency fork 纪律）。→ 待确认
4. CA 生命周期 = **宿主级持久单例**（固定目录，key 0600 / 目录 0700，启动 `validateCaPair` 失败 → 重新生成），不走 per-call ephemeral——RSA-2048 生成在冷路径上（`mitm-ca.js:52-56` 性能注记），前台 per-call session 形态下每调用重生不可接受。→ 待确认
5. 重签范围 = mitmCA 在场时对**全部放行域**终止 TLS（`http-proxy.js:268-269` 的 `shouldTerminateTLS` 缺省 true），不做「仅凭据域才终止」的窄化优化；`shouldTerminateTLS` 豁免钩子保留为硬 pin / mTLS 域的操作员退出口。→ 待确认
6. 每凭据条目 `injectHosts` **静态钉死**（github 条目 = `github.com`、`*.github.com`、`*.githubusercontent.com`），默认值不随放行集自动扩张——特别是**不随批准门新批域扩张**（防「批准 A 域 → B 凭据经 A 域洗出」，`credential-sentinel.js:38-43` 的 per-sentinel 门是设计核心）。包默认「injectHosts 缺省 = 全部 allowedDomains」（`credential-mask-env.js:70-75` 注释自述为 trade-off），本仓适配层必须显式传条目自带值，不吃该缺省。→ 待确认
7. 明文 HTTP 臂永不代换（不配 `mutateHeadersPlaintext` / `getBodySubstitutionsPlaintext`，`http-proxy.js:476-479`），sentinel 假值经 80 端口出去恒为假值。→ 待确认
8. 不可掩形态策略**偏离包默认**：非 UTF-8 / 二进制凭据文件（包 skip = 文件原样可读，fail-open，`credential-mask-files.js:160-172`）与 `onExtractNoMatch` 未命中（包默认 `"warn"` fail-open，`:248-264`）在本仓一律**降级 deny**（围栏内该路径不可读 + 违例留痕）——对齐本仓 fail-closed 全覆盖纪律（前 spec invariant 3）。→ 待确认
9. yolo / isolation OFF（围栏整体退场）时 sentinel 层**同跳**：不铸假值、不装配 registry，宿主 env 真值直达子进程——与既有「无 fence 即无 egress 消费面」（`specs/egress-preset-allowlist.md` F6）同族，姿态差异显式登记（本层提供「看起来有保护实则无」的反命门），不静默。→ 待确认
10. egress session 起不来（缺 socat 等既有 F4 路径）时凭据层随 session 整体缺席：真值文件仍可按 FS 档被围栏读到，但 `--unshare-net` 恒在 = 无出口 = 无外泄通道（存在面保护退化为「不可达」而非「假值」，如实写明）。→ 待确认
11. 信任注入面 = 包 `CA_TRUST_VARS` 名册全量（`sandbox-utils.js:403-420`：`NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` / `CURL_CA_BUNDLE` / `REQUESTS_CA_BUNDLE` / `PIP_CERT` / `GIT_SSL_CAINFO` / `AWS_CA_BUNDLE` / `CARGO_HTTP_CAINFO` / `DENO_CERT` / `CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE` / `NIX_SSL_CERT_FILE`），值指向 trust bundle（含代理 CA + 常规根，`mitm-ca.js:133-186`），且 trust bundle 文件与 masked-file store 目录**经 EgressFenceSpec 扩段 ro-bind 进围栏**（宿主 tmpdir 在围栏内被 `--tmpfs /tmp` 盖掉，不 bind 即不可达）。→ 待确认
12. 代换生效的端到端判据用真实 `gh`（`gh auth status` / `gh pr list` 在围栏内成功）+ 集成层自建 echo 端点（headers 与 body 双臂）；echo 测试经 session 的地址判定注入 seam 放行测试域（生产地址守卫不放宽）。→ 待确认
13. 代换层的包内告警（body `Content-Encoding` 跳过 warn、豁免域上存在可注入凭据的 `namesInjectableAt` 诊断）接入本仓 egress 违例/诊断通道（0097「违例文案所有权在本仓」的延伸），不散落包私有 logger。→ 待确认
14. 本 spec 不改 secret-roundtrip mask / output-mask / secrets guard 任何一层的实现，只加「sentinel 假值不得被三层触发」的反向钉子测试。→ 待确认

## Goal

落地 ADR-0105 的凭据面：HTTP(S) 系凭据（`GH_TOKEN` 类 env 与凭据文件形态）以 **sentinel 假值**进围栏——真值永不进围栏；宿主出口代理在 TLS 终止后、仅对**放行域 ∩ 条目 `injectHosts`** 做 headers + body 流式的 **fake→real** 单向代换。失败方向是设计出来的：任何漏代换（压缩体、base64 包裹、被编码器拆散）= 假值原样到达 API = 认证失败，**永不为真值泄露**（ADR-0105 §Decision 3）。

用户故事：ADR-0104 放开数据面后，实测事故（conversation `ee13c787`）证实围栏内 `gh` / git push 对凭据的真实需求；而「真值 + 放行域」组合即完整外泄通道——secret-roundtrip mask（可见面）防模型的眼、防不住围栏内代码的手（ADR-0105 §Context）。本 spec 装上存在面防线：围栏内代码摸到的只有假值，滥用放行域也带不走真凭据。

## Boundaries

- **Does:**
  - **凭据源与启动期装配**：宿主读真值（env + `~/.config/gh/hosts.yml` + 一般化 `credentials.files` 形态：extract pattern + `decode: "jwt"`）→ 铸 sentinel（`fake_value_<uuid4>`，长值配平，`credential-sentinel.js:24-34`；JWT 形铸同形假值，`credential-decode.js:73-77`）→ 掩码版文件经 `MaskedFileStore` 落宿主 temp 目录、`--ro-bind` 盖过真路径 → fence env 放假值（经 egress env 增量通道，晚于白名单 scrub 合入，`bwrap.ts:229-238` 的 mergedEnv 次序已钉 egress.env 覆盖方向）。真值文件永不进围栏。
  - **代换面接线**：session 的代理实例启用 `mitmCA` + `shouldTerminateTLS` + `mutateHeaders`（= `SentinelRegistry.substituteInHeaders`，`credential-sentinel.js:175-190`）+ `getBodySubstitutions`（= `sentinelsForHost`，`:135-146`）；per-destHost 门 = filter 已放行 ∧ 条目 `injectHosts` 命中；与 ADR-0097 `filter` 回调（域判定 + 违例留痕）共存：代换只发生在放行之后的转发腿，不改判定、不再记违例。
  - **TLS 终止信任链**：CA 持久层（路径、权限、`validateCaPair` 自检重生成，`mitm-ca.js:82-108` `:357-370`）、per-session trust bundle 生成与 bind 进围栏、`CA_TRUST_VARS` 名册注入、逐客户端行为确认（gh=Go 吃 `SSL_CERT_FILE`；git 吃 `GIT_SSL_CAINFO`；curl 吃 `CURL_CA_BUNDLE`）。硬 pin 证书客户端连不上 = fail-closed，`shouldTerminateTLS` 豁免为其操作面退出口（豁免域上凭据代换必然失效 → 该域 401，方向仍是 fail-safe，诊断须说人话）。
  - **fail-safe 与共存钉子**：encoded body 跳过代换 → 假值到达 API → 401 + 可诊断 warn（`body-substitution.js:49-58` 现成件，warn 接本仓诊断通道）；sentinel 假值**不得**触发 secret-roundtrip recognize（`src/harness/secret-roundtrip/patterns.ts:23-31`）、output-mask（`currentSecretValues`，`env-isolation.ts:142-162`）、secrets guard（mode:block 同 patterns SSOT）——三重误报防线各给判据；双重代换防护（代换单向、real value 永不回扫，见 invariant 6）。
  - **各入口形态**：前台 bash / background / verify / worker 四形态沿用 0097 生命周期表三装配点（worker 不单独造 fence）；session dispose 释放通道扩展 registry.clear() + masked store dispose（`credential-mask-files.js:80-92`）；非交互 fail-closed 纪律逐字沿用。**yolo**：围栏整体退场 → sentinel 层同跳，姿态差异显式（Assumption 9），不许静默。
  - **测试矩阵**：单测（铸造 / registry 契约 / 代换流 / destHost 判据 / 误报三连）+ 集成（代理起落 + CA 信任 + 自建 echo 双臂判据）+ TUI pty 实测 + 真实 `gh` e2e 验收判据。
- **Confirms with human:**
  - 上文 Assumptions 1–14 全部（尤其是 4 CA 持久化、5 重签范围、6 injectHosts 静态钉、8 deny 偏离包默认、9 yolo 姿态）。
- **Out of this spec:**
  - **SSH 桥 / `GIT_SSH_COMMAND` / `SSH_AUTH_SOCK`**：归并行 spec `specs/egress-ssh-bridge.md`（ADR-0105 §Decision 5 明示 SSH 不在本决策；`http-proxy.js:270-276` 的 CONNECT 非 TLS 字节落 opaque tunnel 即其例外注记）。共享面仅声明依赖：egress session / 代理装配缝与生命周期表（本 spec 在 `createEgressSession` / proxy options 上做的扩展必须保持 ssh 桥 spec 可按同缝接线，不预定对方设计）。
  - E 逃逸缝（backlog，ADR-0104 §Consequences「逃逸重执行缝待立项」）。
  - AWS SigV4 凭据对（`credential-aws-pairs.js` 的 `planSigv4` 钩子为通用性参考，远期，不入首期）。
  - LLM API key 的 sentinel 化（ADR-0104 已拒绝预放行、ADR-0105 §Consequences 登记「即便未来放行也应走 sentinel」——届时另案）。
  - secret-roundtrip mask / output-mask / secrets guard 三层自身的实现变更（只加反向钉子测试）。
  - `web_fetch` / `web_search` 的 network-guard 栈（另一条防线，CONTEXT「域名允许集 vs network-guard」条目）。

## Settled invariants

1. **真值存在面二分**：真值只存在于宿主进程的 registry 与代理转发腿；围栏内 env / 文件 / 任何进程可见字节恒为假值。`TOKEN` 系变量名进围栏的唯一通道是 egress env 增量且值必为 registry 铸造的 sentinel（装配期 assert：凡注入的凭据条目 env 值 ∉ registry 假值空间 → 不起 session）。
2. **代换方向恒 fake→real、仅两处门都开才代换**：destHost 过 filter（域判定，0097）∧ 命中该 sentinel 所属条目的 `injectHosts`（per-sentinel 门，`credential-sentinel.js:38-43`）。漏门方向恒为「假值出去 = 认证失败」。
3. **`injectHosts` 静态**：条目名单是配置/代码常量，批准门新批域**不**并入任何条目的 `injectHosts`（洗出防护）。
4. **两层并存不互替**（ADR-0105 §Decision 6）：sentinel 管存在面，secret-roundtrip mask 管可见面；sentinel 假值不是 secret——不进 recognize 注册、不进 output-mask 遮蔽集、不被 secrets guard 拦（Assumption 14 的三连判据）。
5. **明文 HTTP 臂与 SSH/opaque 臂零代换**：`allowPlaintextInject` 永假；非 TLS 字节（含 ssh 流量）落 opaque tunnel 不进内容面（`http-proxy.js:270-276` `:302`）。
6. **双重代换防护**：body transform 替换后从 sentinel 尾后继续、real value 永不回扫（`body-substitution.js:94-115`）；headers 代换 split/join 单向（`credential-sentinel.js:203`）；registry 注册期契约「任一 sentinel 不得是另一 sentinel 的子串」（`credential-sentinel.js:84-89`）由本仓装配层在全部注册完成后 assert，违反 = 装配失败（typed error，不起带部分代换的 session）。
7. **fail-closed 全覆盖沿用**：session/代理/桥死 = 无出网；CA 不可用 = 不起 mitm session（不静默降级为「有假值无代换」还谎称可用——降级必须留 infra 违例痕）；硬 pin 客户端 = 连接失败。
8. **零新增第三方依赖**：mitmCA / sentinel / body-substitution 均为 pin 依赖包内现成件；node-forge 已在加载图上（ADR-0097 实测 `http-proxy.js:8` ← `mitm-ca.js:10`），本 spec 使「运行时惰性」变为运行时也启用——依赖面不扩，lockfile 无新条目（改 lockfile 仍需依据凭证的仓规不变）。
9. **`--unshare-net` 恒在 / argv 顺序纪律不动**（`.qoder/rules/security-boundaries.md` §Sandbox argv）：masked-file bind 与 trust-bundle bind 落 `egressBind` 段（workspaceMounts 之后、cwdReadonly 之前，`bwrap.ts:191-196`）——last-mount-wins 是盖过 home ro-bind 真路径的机制本身。

## 凭据名册与配置形态（T1 的钉死表）

| 条目                     | 源                                       | 掩码形态                                                                                                                                                | injectHosts（静态）                                   |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `GH_TOKEN`               | 宿主 env                                 | whole-value（一个 sentinel 替整值）                                                                                                                     | `github.com` `*.github.com` `*.githubusercontent.com` |
| `~/.config/gh/hosts.yml` | 凭据文件                                 | structured `extract`（YAML `oauth_token:` 捕获组，文件其余字节逐字保留，gh 解析不炸）                                                                   | 同上                                                  |
| 一般化文件条目           | settings `isolation.credentials.files[]` | `extract` 可选 + `decode: "jwt"` 可选（提取 `eyJ…` 模式 + `verifyJwt` 结构校验防误伤随机 base64，`credential-decode.js:20` `:39-48`；JWT 形铸同形假值） | 条目自带（必填，缺省不吃放行集扩张——invariant 3）     |

settings 段形状细节（键名、frozen 语义、非法值丢弃不抛 + 留痕）对齐 `settings.ts:34-43` 既有纪律，plan 阶段定形；本 spec 钉语义不钉 schema。

## 任务拆分

**落地粒度（minimal-change 门）**：T1–T7 各 = 一个独立逻辑任务 = 一个 commit；11 文件改动面按 T 分次落地，禁止跨 T 混 commit（拆分-提交映射由 plan 的 tracer bullets 承载）。

### T1 — 凭据名册 + settings 装配（`egress/credential-assembly.ts` 新文件 + `assembly.ts` 接线）

- 代码内置 github 名册（表列两条目，SSOT 单文件）；`createEgressPolicyFactory` 的产物 `EgressPolicyInput` 扩 `credentials` 字段（数据形状注入，egress 域不反向 import config——`session.ts:50-56` 同款纪律）。
- 用户层 `isolation.credentials` 段解析（追加/收窄；项目层出现即丢弃，前 spec SC9 同族测试）。
- `injectHosts` 缺省策略：条目未声明 → **不铸造**（本仓不吃包的 allowedDomains 缺省，Assumption 6），留 warn 痕。

**验收**：名册 SSOT 单测（github 条目逐字）；项目层丢弃测试；无 `injectHosts` 条目被拒铸 + 留痕测试；`EgressPolicyInput` 扩字段编译连锁（background/verify 消费面零改动或显式透传）。

### T2 — 启动期铸造与围栏装配

- session 装配新增步骤（在 Step 2 起代理之前）：`createMitmCA`（持久层，见 T4）→ 构造 `SentinelRegistry` → `buildMaskedEnvVars` / `buildMaskedFileBinds`（经 `upstream.ts` re-export）→ 注册后 sentinel 子串契约 assert（违反 = typed 错误，走 session 同一失败通道）。
- `EgressFenceSpec` 扩 `binds: readonly { src; dest; readonly: true }[]`（masked store 目录 + trust bundle 文件），`bwrap.ts` `egressBindArgs` 消费（顺序纪律见 invariant 9）；env 增量在 `buildProxyEnv`（`session.ts:243-259`）之上追加假值与 `CA_TRUST_VARS`。
- 失败路径表逐条落 typed 分类（见 Failure paths F1–F3、F7）。

**验收**：铸造幂等/配平测试（`credential-sentinel.js:24-34` 长值配平、register 幂等语义以包行为为准）；「真值文件不进围栏」装配层测试（bind 表只含 fake path）；fence env 断言：`GH_TOKEN` 值 ∈ registry 假值空间、真值 ∉ fence env；bwrap argv 快照测（bind 段落位）。

### T3 — 代理代换接线 + dispose

- `startHttpProxyStep`（`session.ts:367-404`）proxy options 增：`mitmCA`、`shouldTerminateTLS`（缺省全终止，Assumption 5）、`mutateHeaders = (h, dest) => registry.substituteInHeaders(h, dest, matchesDomainPattern)`、`getBodySubstitutions = dest => registry.sentinelsForHost(dest, matchesDomainPattern)`（接线形状 = 包 manager 的现成闭包，`sandbox-manager.js:282` `:293` `:389-394`，本仓自装配等价）。
- `filter` 回调不动（0097 违例所有权）；包内代换告警（F5/F6 两臂）经注入点接 violationSink 旁路诊断档（新 reason `substitution-skipped` / `tls-exempt-injectable`，**不**冒充域判定拒绝——三类信号可区分纪律延伸为四类）。
- dispose：`registry.clear()` + `MaskedFileStore.dispose()` + trust bundle 临时件清理；正常/异常同一释放通道（0097 生命周期表逐字沿用）。

**验收**：filter 与代换正交测试（注入 seam 捕获 options，不真起代理）；dispose 幂等 + 异常路径（spawn 失败先起代理）释放测试；告警→sink reason 测试。

### T4 — CA 生命周期与信任链

- 持久 CA：`~/.config/iknow/egress-mitm-ca/`（目录 0700 / key 0600，权限不符 = 拒用 + 重生成前告警）；启动 `validateCaPair`（`mitm-ca.js:357-370`）失败 → 重生成；`createMitmCA({caCertPath, caKeyPath})` 装载。
- trust bundle 每次 session 现写：CA 证书 + 常规根拼接，**只含 CERTIFICATE 块**（防把 key 拷进 world-readable bundle——`mitm-ca.js:166-175` 的 PEM 过滤是现成教训）；bundle 目录 0644 文件仅证书，key 永不落围栏可达路径。
- 逐客户端确认（T7 实测面）：gh（Go → `SSL_CERT_FILE`）、git-over-https（`GIT_SSL_CAINFO`）、curl（`CURL_CA_BUNDLE`）三臂屏上成功即名册生效证据；其余 `CA_TRUST_VARS` 条目随 env 注入不设单独判据。

**验收**：权限/自检/重生成单测（注入临时目录）；bundle 内容 assert（含代理 CA、含常规根、不含 PRIVATE KEY 块）；CA 私钥路径不进 bind 表（测试钉）。

### T5 — 三重误报防线 + 双重代换防护测试钉

- recognize：`fake_value_<uuid>`、同形假 JWT、配平长假值喂 `recognize()` → `matched = []` 且 `replaced` 逐字等于输入；
- output-mask：假值 ∉ `currentSecretValues(process.env, registry.values())`（宿主 env 无假值、registry 无假值）→ `createOutputMask` 不掩假值；`echo $GH_TOKEN` 经 mask 层输出原样含假值（屏上可诊断性）；
- secrets guard：mode:block 下含假值的工具参数不被拦（patterns 同一 SSOT，`src/harness/secret-roundtrip/patterns.ts:23-31` 零命中）。
- 双重代换：registry 子串契约 assert 的违例 fixture（铸两个嵌套假值 → 装配失败）；body transform「替换产物不回扫」用例（真值含假值前缀的构造）。

**验收**：以上每条为具名单测/夹具，进 `npm test`。

### T6 — 入口形态接线 + yolo 姿态显式

- 三装配点（`bash.ts` 前台 / `background/manager.ts` / `verify/sandbox-run.ts`，worker 走这三条——前 spec 实测）经同一 `createEgressSession` 获得凭据层，无各面分支；background 挂 `settle()` 的释放通道覆盖 registry/store。
- yolo / isolation OFF：凭据装配函数入口显式分支「不铸造、不注入」，返回结构带 `skipped: "no-fence"` 之类别名进诊断/日志——离线可查证「此时宿主真值直达、无存在面保护」。
- session 起不来（缺 socat → `SocatUnavailableError` 既有路径）：凭据层随 session 缺席，infra 文案不变（不新增冒充）。

**验收**：三装配点 wiring 测试（工厂注入 seam）；yolo 路径「registry 未构造 + env 无假值键 + skipped 痕」断言；`build-engine-egress-wiring.test.ts` 同族回归。

### T7 — 测试矩阵与实测（完成 = 实测过）

- 单测/集成：T1–T6 各钉；集成臂 = 真起代理 + mitmCA + 自建 HTTPS echo server（`tlsTerminateUpstreamCA` 信任测试上游根，`http-proxy.js:289` `:420`）+ 测试域进 `allowedDomains` 且凭据条目 `injectHosts=[测试域]` + 地址判定注入 seam 放行回环（生产档位不动，Assumption 12）；断言 echo 收到的 header 与 body 均为真值、未配 `injectHosts` 的放行域收到假值、`Content-Encoding` 请求体原样透传 + 诊断痕。
- `npm run probe:sandbox` 全类别全绿（动 fence bind 段的仓规强制面）；若新增探针类别（如「masked bind 盖过真路径」物理探针），同步 `security-boundaries` 11 类纪律说明——默认不强行加。
- TUI pty（`mcp__aiterm__pty_*`，干净装配 + 本机已配 gh 凭据）：①围栏内 `echo $GH_TOKEN` → `fake_value_…`；②`cat ~/.config/gh/hosts.yml` → 假 token、YAML 结构完整；③`gh auth status` → 登录态可用；④`gh pr list`（真 repo）→ 成功 = header 代换端到端生效；⑤屏上证据入验收报告。
- 真实 `gh` e2e 不触及 LLM 客户端/adapter 面，`npm run test:real-llm` 预期 Not run（理由 = 不触及，如实登记）。

**验收**：矩阵全绿证据 + TUI transcript 片段归档于验收报告。

## Failure paths

| #   | 路径                                                      | 行为                                                                                                                                                                                       |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | 真值 env 变量在宿主缺席（GH_TOKEN 未设）                  | 跳过条目（无可保护），debug 痕；**不**注入空假值（presence 检查不翻转，`credential-mask-env.js:66-69` 同款姿态）                                                                           |
| F2  | 真值文件不可读 / 不存在 / 是目录                          | 跳过条目 + 痕（宿主读不到 = 围栏同样读不到，不可达不是泄露）；不硬错（跨机可移植性，`credential-mask-files.js:167-172` 姿态）                                                              |
| F3  | 真值文件非 UTF-8 / extract 未命中 / decode 验证全数失败   | **deny 降级**（Assumption 8）：路径进围栏不可读 + typed 违例痕（含修复指引），不随包默认 fail-open                                                                                         |
| F4  | sentinel 子串契约违例（装配后 assert）                    | 起 session 失败，typed 错误（不跑「部分代换」的 session）                                                                                                                                  |
| F5  | 请求体带 `Content-Encoding`                               | 不缓冲不解码，原样透传 → 上游 401；诊断 reason `substitution-skipped` 进本仓通道（`body-substitution.js:49-58` 告警接线）                                                                  |
| F6  | 硬 pin 客户端 / mTLS 上游                                 | 连接失败（fail-closed），或经 `shouldTerminateTLS` 豁免 → 该域不代换 → 凭据不可用 + 豁免痕（`namesInjectableAt` 诊断，`credential-sentinel.js:115-127`）；豁免操作面是否进 settings 见 OQ2 |
| F7  | CA key 文件权限过宽 / validate 失败                       | 拒用 → 重生成（持久层，T4）；重生成后旧 leaf 缓存作废随 session 自然失效                                                                                                                   |
| F8  | trust bundle / masked store 的宿主 tmp 路径在围栏内不可达 | 装配期 assert bind 表含全部依赖路径；漏 bind 表现为客户端 TLS 校验失败——测试必须以「围栏内真跑 TLS 客户端」为判据，不以「env 已设」为判据（防本类静默半生效）                              |
| F9  | yolo / isolation OFF                                      | 整层跳过（Assumption 9），显式 `skipped` 痕；宿主真值直达属**声明的姿态**非缺陷                                                                                                            |

## Input-contract classes (public surfaces)

| Surface                             | empty                                                                             | invalid                                                                                                                                              | overflow                            | concurrent                                               | exception     |
| ----------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------- | ------------- |
| settings `isolation.credentials` 段 | 缺省 = 仅内置名册                                                                 | 非对象 / 条目缺 `injectHosts` / 非法正则（无捕获组，`sandbox-config.js:180-197` 的 group-1 校验是教训）→ 丢该条目 + 警告（不抛，对齐 settings 纪律） | 条目数上限 plan 定，超出丢尾 + 警告 | 多 session 并发铸造互不共享 registry（per-session 实例） | 不抛，恒留痕  |
| 铸造                                | 真值空串 → 跳过条目                                                               | 真值含 `fake_value_` 前缀（怪值）→ 照铸（uuid 熵在，代换方向不变）                                                                                   | —                                   | registry 单 session 内构造期串行                         | 子串契约 → F4 |
| 代换                                | 无注入凭据的 destHost → 零对（body transform 不建，`body-substitution.js:46-48`） | 假 JWT 被客户端改写后失配 → 不代换 = 假值出去（设计内）                                                                                              | —                                   | 多连接共享 registry 只读查表                             | —             |

## Success criteria

- **SC1**：围栏内 `echo $GH_TOKEN` 得 `fake_value_…`；装配层单测钉「真值字面 ∉ 围栏可见面全集（fence env ∪ bind 表内容）」，TUI 断言屏上假值。
- **SC2**：围栏内 `gh auth status` 与 `gh pr list` 成功（TUI pty 实测，headers 代换生效）；transcript 证据入报告。
- **SC3**：集成 echo 双臂判据：放行域 ∧ `injectHosts` 命中 → 宿主 echo 收到真值（header + body 各 1 例）；放行域但条目未配 `injectHosts` → 假值原样到达（本仓适配层不出现「无 injectHosts 条目」，该例由显式收窄到别域的条目充任）；非放行域 → 既有 403 面不变。测试绿/红即 binary。
- **SC4**：批准门新批域不扩任何凭据条目 `injectHosts`（T3 单测钉）；明文 80 臂零代换（invariant 5 测试）。
- **SC5**：三重误报防线逐条具名测试绿（T5）：假值过 recognize / output-mask / secrets guard 三重均零触发。
- **SC6**：F5 路径测试：`Content-Encoding` 体不代换 + 诊断痕 + 上游收假值；方向断言（绝无真值出现在应到假值处）。
- **SC7**：TUI 实测 `cat ~/.config/gh/hosts.yml` = 假 token 且 YAML 可被 gh 解析（SC2 登录态即其证据链）；masked bind 段在 bwrap argv 快照测试中落位正确（invariant 9）。
- **SC8**：CA 契约：权限过宽/坏 pair → 重生成测试；bundle 不含 PRIVATE KEY、bind 表不含 keyPath（单测）；gh/git/curl 三臂 TLS 屏上证据（T7）。
- **SC9**：yolo 路径断言：registry 未构造 + fence env 无凭据键 + `skipped` 痕（T6 测试）；session 失败路径凭据层随 `SocatUnavailableError` 缺席且无假值半注入（wiring 测试）。
- **SC10**：`npm test` 全绿 + `npm run probe:sandbox` 全绿 + grep assert：`src/` 除 `egress/upstream.ts` 外无 `@anthropic-ai/sandbox-runtime` 深路径 import（适配层收口，0097 Dependency fork 纪律）。
- **SC11**：dispose：session 正常/异常/中止三路径后 registry 清空、masked store 目录删除、trust bundle 临时件删除（测试 + `probe:sandbox` 不留 stale）。

## Open questions

- OQ1：重签范围若按 Assumption 5（全放行域终止）落地后实测发现高误伤（pinning 生态域），是否引入 per-domain 终止配置档——本 spec 只留 `shouldTerminateTLS` 钩子形状，不预设配置面。
- OQ2：`shouldTerminateTLS` 豁免名单进用户层 settings（operator 面）还是仅代码常量退出口。
- OQ3：`gh` 对 `GH_TOKEN` 假值形态（`fake_value_…` 非 `ghp_`/`gho_` 前缀）是否有客户端侧格式校验，以 T7 实测为准；若拒收，假值改 `gho_` 前缀同形铸造（`registerWithSentinel` 的 caller-minted 通道，`credential-sentinel.js:73-109`）——属装配层参数，不动架构。
- OQ4：一般化条目是否开放 `mode: "deny"`（不铸造纯禁读）与本层 `mode: "mask"` 并存——包 config schema 两模式都有，首期名册全 mask，deny 臂留接口不启用。

## 待写入清单（persist 用）

- 无新 CONTEXT 词条需求（「凭据 sentinel」已随 ADR-0105 落地，`docs/CONTEXT.md:217-218`）；ACR verdict 后若有新边界词再走 domain-modeling，主会话统一登记。

## ACR verdict（architecture-change-reviewer）

```text
bounded-context-guardian: yes — 铸造/代换/CA 全收在 egress/{credential-assembly,session,upstream}+settings 缝（T1–T4）；upstream.ts 单点收口经 SC10 grep 钉；与 mask 并存不改（Assumption 14/invariant 4）、与 ssh-bridge 双向 Out-of-scope 声明互不侵入
defensive-contract-validator: yes — Input-contract 表覆盖五类边界；F3 覆盖非 UTF-8/extract 未命中，invariant 6+F4 钉子串契约，F8 钉 tmpfs 可达，名册表钉 per-session 并发隔离；残余缺口（CA 并发重生成、同 destHost 多凭据序）属 plan 级不阻断
error-handling-enforcer: yes — F1–F9 全表 typed 分类；fail-open→deny 降级（Assumption 8/F3）显式偏离包默认；F7 CA 权限/validate 失败拒用+重生成+告警；F5/F6 告警接 violationSink 新 reason，invariant 7 禁静默降级
complexity-anti-drift: yes — Assumption 3 + T2/T3 全部经 upstream.ts re-export 复用包内 SentinelRegistry/buildMasked*/createMitmCA/body-substitution，本仓只做接线闭包，不复刻代换引擎；锚点实测存在
minimal-change-verifier: no → 已返工（rev 2）— 原判：11 文件跨 T1–T7 远超 1 commit，须声明拆分-提交映射；另一处引用路径判词经 grep 复核为误报（spec 从未含 `sandbox/secret-roundtrip` 串），但裸 `patterns.ts` 引用确有歧义，已消歧为全路径。返工：任务拆分段补「T1–T7 各 = 1 逻辑任务 = 1 commit」落地粒度声明（审查方明示补齐即可复审放行）
OVERALL: PASS（rev 2，返工点已按审查方清单落实）
```

## Inherits / Changes

- **继承**：ADR-0097 全部（`--unshare-net` 恒在、代理缝结构、filter 回调语义与违例回灌三跳通道、生命周期表、地址守卫正交、深路径导入经 `upstream.ts` 收口）；ADR-0104 放行集合并语义（判定输入构造单点在 assembly）；`specs/network-egress-allowlist.md` 的三类信号可区分、`EgressFenceSpec` / `createEgressSession` 既有形状；`specs/egress-preset-allowlist.md` 的 `allowlistSource` 三档与 F6「yolo 两轴正交」姿态；secret-roundtrip mask / output-mask / secrets guard 现状实现（`src/harness/secret-roundtrip/` 的 `patterns.ts` / `registry.ts` / `recognize.ts`、`bash.ts:739-740` restore 点、`env-isolation.ts` SECRET_PATTERN scrub）——本层与它们**并存不改**；`.qoder/rules/security-boundaries.md` bwrap argv 顺序纪律与敏感文件纪律（CA key、真值文件、trust bundle 内容审查均按「不泄露 key 到可见面」执行）。
- **变更**：`EgressPolicyInput` + `EgressFenceSpec`（扩 credentials / binds 字段）；`startHttpProxyStep` 的 proxy options（增 mitmCA 系四钩子）；`bwrap.ts` `egressBindArgs`（单 socket → bind 列表）；`session.ts` 装配步骤与 dispose；用户层 settings 新段（不动既有段语义）；新增诊断 reason 档（四类信号表）。不改任何 ADR / docs（登记由主会话做）。
- **依赖声明（并行 spec 接口面）**：`specs/egress-ssh-bridge.md` 与本 spec 共享 `createEgressSession` / proxy options / 生命周期表——本 spec 的扩展保持「CONNECT 非 TLS 字节 → opaque tunnel」臂不动（`http-proxy.js:270-276` `:302`），对方范围零设计。

## Evidence pointers

- 包内现成件（pin 依赖 `@anthropic-ai/sandbox-runtime/dist/sandbox/`）：`credential-sentinel.js:11`（`SENTINEL_PREFIX`）`:24-34`（配平铸造）`:38-43`（per-sentinel 门注释）`:84-89`（子串契约）`:115-127`（namesInjectableAt）`:135-146`（sentinelsForHost）`:175-206`（headers 代换 + 前缀 fast path）；`credential-decode.js:20`（`eyJ…` 提取模式）`:39-48`（verifyJwt）`:73-77`（同形假 JWT，`alg: HS256` 非 `none` 的拒验设计）`:109-137`（maskClaims 深度掩码）；`body-substitution.js:35-64`（CE 跳过 + chunked reframing + fail-safe 方向注释）`:94-127`（hold-back 流式）；`http-proxy.js:157-304`（mitm 接线与 ClientHello sniff；`:270-276` SSH 例外注记；`:286-299` terminateAndForward 传钩子）`:423-431`（CRL 服务臂）`:476-479`（明文两臂独立开关）；`mitm-ca.js:52-56`（冷路径性能注记）`:82-108`（createMitmCA 三来源）`:111-125`（disposeMitmCA）`:133-186`（writeTrustBundle + PEM 块过滤教训）`:357-370`（validateCaPair）；`credential-mask-env.js:65-120`（env 铸造流程 + fail-open 缺省即 Assumption 8 偏离对象）；`credential-mask-files.js:36-43`（FILE_KEY_PREFIX 防撞名）`:46-92`（MaskedFileStore + INVARIANT: store 目录围栏内不可写）`:145-275`（文件掩码全流程与三档 onExtractNoMatch）；`credential-aws-pairs.js:1-24`（SigV4 远期参考）；`sandbox-utils.js:403-420`（CA_TRUST_VARS 名册）；`sandbox-config.js:180-197`（extract 捕获组校验）`:220-260`（decode:"jwt" 语义）；`sandbox-manager.js:282` `:293` `:389-394` `:1302`（包侧接线形状参考，本仓自装配等价）。
- 本仓缝：`egress/session.ts:50-56`（依赖注入纪律）`:157-167`（EgressFenceSpec）`:243-259`（buildProxyEnv）`:286-358`（filter 回调）`:367-404`（proxy options 现状）`:462-537`（装配主流程 + dispose）；`egress/upstream.ts:20-38`（收口层现状）；`egress/assembly.ts:84-89`（工厂 fail-closed 缺省）；`bwrap.ts:191-238`（egress bind 段 + env 合入次序）；`aci/tools/bash.ts:366-369`（output mask 构造）`:727-729`（fenceEnv 白名单）`:739-740`（restore 点）；`sandbox/env-isolation.ts:67-68`（SECRET_PATTERN scrub——真值 env 今天本就进不了围栏，本层把「进不了」升级为「进去的是假值」）`:142-162`（currentSecretValues）；`secret-roundtrip/patterns.ts:23-31`（假值零命中的模式名册）。
- 决策与词条：ADR-0105 全文；ADR-0097 §Decision（违例文案所有权）§Evidence（node-forge 硬依赖）；ADR-0104 §Decision 3（LLM 域不入档在本决策下依然成立且更强）；`docs/CONTEXT.md:217-218`（凭据 sentinel + _Avoid_）`:738`（sentinel vs mask 二分）；事故 conversation `ee13c787`（`gh auth status → X Failed to log in`）。
