# Plan: egress-credential-sentinel —— 假值进围栏，宿主代理只对放行域 ∧ injectHosts 假换真

**Goal:** 凭据存在面防线落地：围栏内只见铸造的 sentinel 假值（env 假值 + masked-file 显式 bind 盖过真路径），宿主代理 TLS 终止后仅对放行域 ∧ 条目 `injectHosts` 命中做 headers + body 单向 fake→real 代换；漏代换 = 认证失败而非泄露；与 secret-roundtrip mask（可见面）并存不互替。
**Approach:** 按 spec T1–T7 各收一颗垂直子弹、编号与 spec 任务拆分段 1:1，每颗 = 1 commit（spec 落地粒度声明）；列表按依赖排序——T4（CA 持久层）先于其消费方 T2（铸造装配）落地，T1 与 T4 可并行。关键防线各归其弹：fail-open→deny 降级在 T2、`injectHosts` 静态钉在 T1/T3、三重误报防线在 T5、tmpfs 显式 bind 判据在 T2/T7、CA key 不进 bind 表在 T4。SSH/SOCKS 传输面、AWS SigV4、LLM key sentinel 化、三层 mask 实现变更均不入本 plan（spec Out-of-scope）。
**Spec link:** `specs/egress-credential-sentinel.md`（rev 2）
**ACR:** PASS（rev 2 返工后，verdict 块照录如下）
**Tracker:** 本地 markdown fallback（仓惯例，无 GitHub issue 边；blockers 以 `[blocks: Tn]` 标注）。
**待写入:** 无——spec 待写入清单已判「无新 CONTEXT 词条需求」（「凭据 sentinel」已随 ADR-0105 落 `docs/CONTEXT.md:217-218`）；yolo 模式词条缺口由 ssh-bridge 侧登记、主会话统一 flush，不在本 plan 重复。
**Assumption gate:** Assumptions 1–14 全部**待确认**，人类 gate 由主会话另行走，本 plan 不代为裁定。翻车时的回退形态只用 spec 已声明的出口：OQ3——若实测 `gh` 拒收 `fake_value_…` 前缀，假值改 `gho_` 前缀同形铸造（`registerWithSentinel` caller-minted 通道，装配层参数，不动架构、不加子弹）；Assumption 5——若全放行域终止出现高误伤（pinning 生态域），退出口 = `shouldTerminateTLS` 豁免钩子形状（OQ1 的 per-domain 配置档、OQ2 豁免名单是否进 settings 均留 spec 悬置，plan 不预设）。各弹 Surface/Acceptance 不因待确认 assumption 而阻塞——人类 gate 翻车只触发对应弹的局部回退。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## ACR

```text
bounded-context-guardian: yes — 铸造/代换/CA 全收在 egress/{credential-assembly,session,upstream}+settings 缝（T1–T4）；upstream.ts 单点收口经 SC10 grep 钉；与 mask 并存不改（Assumption 14/invariant 4）、与 ssh-bridge 双向 Out-of-scope 声明互不侵入
defensive-contract-validator: yes — Input-contract 表覆盖五类边界；F3 覆盖非 UTF-8/extract 未命中，invariant 6+F4 钉子串契约，F8 钉 tmpfs 可达，名册表钉 per-session 并发隔离；残余缺口（CA 并发重生成、同 destHost 多凭据序）属 plan 级不阻断
error-handling-enforcer: yes — F1–F9 全表 typed 分类；fail-open→deny 降级（Assumption 8/F3）显式偏离包默认；F7 CA 权限/validate 失败拒用+重生成+告警；F5/F6 告警接 violationSink 新 reason，invariant 7 禁静默降级
complexity-anti-drift: yes — Assumption 3 + T2/T3 全部经 upstream.ts re-export 复用包内 SentinelRegistry/buildMasked*/createMitmCA/body-substitution，本仓只做接线闭包，不复刻代换引擎；锚点实测存在
minimal-change-verifier: no → 已返工（rev 2）— 原判：11 文件跨 T1–T7 远超 1 commit，须声明拆分-提交映射；另一处引用路径判词经 grep 复核为误报（spec 从未含 `sandbox/secret-roundtrip` 串），但裸 `patterns.ts` 引用确有歧义，已消歧为全路径。返工：任务拆分段补「T1–T7 各 = 1 逻辑任务 = 1 commit」落地粒度声明（审查方明示补齐即可复审放行）
OVERALL: PASS（rev 2，返工点已按审查方清单落实）
```

## Tasks (ordered by dependency)

子弹编号沿用 spec 任务拆分 T1–T7，排列按依赖图（T4 前置于 T2）；每颗 = 1 逻辑任务 = 1 commit，禁止跨弹混 commit。

1. **T1 凭据名册 + settings 装配** — tag: `[implementation]`
   - **Inherits:** spec T1（代码内置 github 名册表列两条目、SSOT 单文件；`EgressPolicyInput` 扩 `credentials` 字段为数据形状注入，「egress 域不反向 import config——`session.ts:50-56` 同款纪律」；`injectHosts` 缺省策略「条目未声明 → **不铸造**……留 warn 痕」）；invariant 3（「条目名单是配置/代码常量，批准门新批域**不**并入任何条目的 `injectHosts`（洗出防护）」）；Assumption 2（用户层 settings 新段 `isolation.credentials`，项目文件不采纳——ADR-0084 纪律；github 两条目代码内置，用户段只做收窄/追加）；Assumption 6（「本仓适配层必须显式传条目自带值，不吃该缺省」）；凭据名册与配置形态表（github.com / `*.github.com` / `*.githubusercontent.com` 逐字）；Input-contract 表 settings 行五类。
   - **Surface:** `src/config/settings.ts`（新段 `isolation.credentials`，不动既有段语义）、`src/harness/sandbox/egress/credential-assembly.ts`（新文件，名册 SSOT）、`src/harness/sandbox/egress/assembly.ts`（接线）。
   - **Acceptance:** spec 交由 plan 定形的 schema 在此钉死：`isolation.credentials.files[]`（`path` / 可选 `extract`（须含捕获组 1）/ 可选 `decode: "jwt"` / `injectHosts` **必填**）与 `isolation.credentials.envVars[]`（`name` / `injectHosts` **必填**）；frozen 语义与非法处置对齐 `settings.ts:34-43` 既有纪律——非对象段、非法条目（缺 `injectHosts` / extract 无捕获组）丢该条目 + 警告不抛；条目上限 = 用户层条目总数 16，超出丢尾 + 警告（Input-contract overflow 档）。内置 github 两条目逐字单测（名册 SSOT）；项目层同段出现即丢弃 + 留痕测试（前 spec SC9 同族）；无 `injectHosts` 条目被拒铸 + warn 痕测试；`EgressPolicyInput` 扩字段的编译连锁——background/verify 消费面零改动或显式透传；`npm test` 绿。
   - Status: [x] pending
   - [parallel]（与 T4 无相互依赖）

2. **T4 CA 持久层与信任链装配面** — tag: `[implementation]`
   - **Inherits:** spec T4（持久 CA `~/.config/iknow/egress-mitm-ca/`，目录 0700 / key 0600，「权限不符 = 拒用 + 重生成前告警」；启动 `validateCaPair` 失败 → 重生成；trust bundle 每次 session 现写、CA 证书 + 常规根拼接、「**只含 CERTIFICATE 块**（防把 key 拷进 world-readable bundle）」）；Assumption 4（宿主级持久单例、key 0600 / 目录 0700，不走 per-call ephemeral——冷路径性能）；Assumption 11（`CA_TRUST_VARS` 名册全量注入、bundle 与 masked store 须经 EgressFenceSpec 扩段 ro-bind——bind 落位本身在 T2）；invariant 7（「CA 不可用 = 不起 mitm session……降级必须留 infra 违例痕」）；F7（拒用 → 重生成；旧 leaf 缓存随 session 自然失效）；SC8（「CA 私钥路径不进 bind 表（测试钉）」）。
   - **Surface:** `src/harness/sandbox/egress/`（持久 CA 模块，新文件名留实现定）、`src/harness/sandbox/egress/upstream.ts`（`createMitmCA` / `validateCaPair` / trust bundle 写件经 re-export 收口，Assumption 3）。
   - **Acceptance:** 注入临时目录单测：权限过宽 / 坏 pair → 拒用 + 告警 + 重生成，重生成后 session 可装载；bundle 内容 assert = 含代理 CA、含常规根、不含 PRIVATE KEY 块；CA key 路径不出现在任何 bind 表输出（SC8 测试钉）；逐客户端信任名册常量（gh/Go → `SSL_CERT_FILE`、git → `GIT_SSL_CAINFO`、curl → `CURL_CA_BUNDLE`）就位供 T2/T7 消费——三臂屏上成功证据归 T7，本弹不提前 claim；`npm test` 绿。
   - Status: [x] pending
   - [parallel]（与 T1 无相互依赖）

3. **T2 启动期铸造与围栏装配（假值进围栏）** — tag: `[implementation]`
   - **Inherits:** spec T2（session 装配新增步骤在 Step 2 起代理之前：createMitmCA → `SentinelRegistry` → `buildMaskedEnvVars` / `buildMaskedFileBinds`（经 `upstream.ts` re-export）→ 注册后 sentinel 子串契约 assert；`EgressFenceSpec` 扩 `binds` 段；env 增量在 `buildProxyEnv` 之上追加假值与 `CA_TRUST_VARS`）；invariant 1（「凡注入的凭据条目 env 值 ∉ registry 假值空间 → 不起 session」装配期 assert）；invariant 6（子串契约违反 = typed 错误，「不起带部分代换的 session」）；invariant 9（masked-file bind 与 trust-bundle bind 落 `egressBind` 段——workspaceMounts 之后、cwdReadonly 之前，last-mount-wins 盖过 home ro-bind 真路径）；Assumption 3（复用件全经 `upstream.ts` 收口，不复刻）；**Assumption 8 + F3：非 UTF-8 / 二进制文件与 `onExtractNoMatch` 未命中一律降级 deny（「围栏内该路径不可读 + 违例留痕（含修复指引），不随包默认 fail-open」——本仓偏离包默认的关键防线，不得在实现中退回 warn-and-include）**；F1（真值 env 缺席 → 跳过条目 + debug 痕，「presence 检查不翻转」不注入空假值）；F2（文件不可读/不存在/是目录 → 跳过 + 痕，不硬错）；F4；F8（「装配期 assert bind 表含全部依赖路径……测试必须以『围栏内真跑 TLS 客户端』为判据，不以『env 已设』为判据」）；SC1、SC7 后半（masked bind 段 bwrap argv 快照落位）、SC10（grep 收口断言自此弹成立）、SC9 后半（session 失败无假值半注入）。
   - **Surface:** `src/harness/sandbox/egress/credential-assembly.ts`、`session.ts`（铸造步骤 + `buildProxyEnv` 追加）、`bwrap.ts`（`EgressFenceSpec.binds` + `egressBindArgs` 消费）、`upstream.ts`（re-export 扩面）。
   - **Acceptance:** 铸造幂等 / 长值配平 / JWT 同形假值单测；「真值文件不进围栏」装配层测试：bind 表只含 fake path，且真值字面 ∉（fence env ∪ bind 表内容）全集（SC1）；fence env 断言 `GH_TOKEN` 值 ∈ registry 假值空间、真值 ∉；bwrap argv 快照测钉 masked store 目录 + trust bundle 文件落 `egressBind` 段位序（invariant 9——宿主 tmp 路径被 `--tmpfs /tmp` 盖掉，漏显式 bind 即不可达，F8 装配期 assert）；子串契约违例 fixture → typed 装配失败、session 不起（F4）；F3 deny 降级路径单测：非 UTF-8 / extract 未命中文件 → 该路径进围栏不可读 + typed 违例痕含修复指引（判据 = 围栏内真跑读取进程的等价断言或 bind 剔除，不以「已 warn」为通过）；F1/F2 跳过留痕测试；grep assert：`src/` 除 `egress/upstream.ts` 外无 `@anthropic-ai/sandbox-runtime` 深路径 import（SC10 收口面自此成立）；`npm test` 绿。
   - Status: [ ] pending
   - [blocks: T1, T4]

4. **T3 代理代换接线 + dispose** — tag: `[implementation]`
   - **Inherits:** spec T3（`startHttpProxyStep` proxy options 增 `mitmCA` / `shouldTerminateTLS`（缺省全终止，Assumption 5）/ `mutateHeaders = registry.substituteInHeaders` / `getBodySubstitutions = registry.sentinelsForHost`，接线形状 = 包 manager 现成闭包的本仓等价自装配；`filter` 回调不动（0097 违例所有权）；F5/F6 告警接 violationSink 旁路诊断档，新 reason `substitution-skipped` / `tls-exempt-injectable`，「三类信号可区分纪律延伸为四类」；dispose = `registry.clear()` + `MaskedFileStore.dispose()` + trust bundle 临时件清理，0097 生命周期表逐字沿用）；invariant 2（「destHost 过 filter ∧ 命中该 sentinel 所属条目的 `injectHosts`……漏门方向恒为『假值出去 = 认证失败』」）；invariant 5（「明文 HTTP 臂与 SSH/opaque 臂零代换：`allowPlaintextInject` 永假」）；invariant 3 / SC4（批准门新批域不扩任何条目 `injectHosts`——本弹测试钉）；Assumption 7（不配 `mutateHeadersPlaintext` / `getBodySubstitutionsPlaintext`）；Assumption 13（包内告警接本仓通道，不散落包私有 logger）；Boundaries「代换只发生在放行之后的转发腿，不改判定、不再记违例」。
   - **Surface:** `src/harness/sandbox/egress/session.ts`（proxy options + dispose 通道）、`upstream.ts`（http-proxy options 形收口）。
   - **Acceptance:** 注入 seam 捕获 options 不真起代理的正交性测试：filter 放行 ∧ `injectHosts` 命中 → 转发腿代换，不改 filter 判定、不重复记违例；放行但条目 `injectHosts` 不命中 → 假值原样转发；批准门新批域不进入任何条目 `injectHosts`（invariant 3/SC4 单测钉——防「批准 A 域 → B 凭据经 A 域洗出」）；明文 80 臂零代换 + CONNECT 非 TLS 字节落 opaque tunnel 不进内容面（invariant 5 测试）；F5 `Content-Encoding` → 原样透传 + reason `substitution-skipped` 痕，与域判定拒绝 / 上游故障 / infra 故障四类信号互不混淆（SC6 方向断言：绝无真值出现在应到假值处）；dispose 幂等 + 异常路径（spawn 失败先起代理）三资源释放测试；**姊妹面边界：传输面（SOCKS / git ssh 桥）在 `specs/egress-ssh-bridge.md` / `plans/egress-ssh-bridge.md`，本弹对 `session.ts` / proxy options 缝的改动与对方 plan 串行落地、合并冲突由主会话裁，且保持「CONNECT 非 TLS 字节 → opaque tunnel」臂不动（spec 依赖声明，对方范围零设计）**；`npm test` 绿。
   - Status: [ ] pending
   - [blocks: T2]

5. **T5 三重误报防线 + 双重代换防护测试钉** — tag: `[implementation]`
   - **Inherits:** spec T5 三条判据逐项（recognize：「`fake_value_<uuid>`、同形假 JWT、配平长假值喂 `recognize()` → `matched = []` 且 `replaced` 逐字等于输入」；output-mask：「假值 ∉ `currentSecretValues(process.env, registry.values())`……`echo $GH_TOKEN` 经 mask 层输出原样含假值」；secrets guard：「mode:block 下含假值的工具参数不被拦（patterns 同一 SSOT，`src/harness/secret-roundtrip/patterns.ts:23-31` 零命中）」）；invariant 4（「两层并存不互替（ADR-0105 §Decision 6）……三重误报防线各给判据」）；invariant 6（双重代换防护：body transform 替换后从 sentinel 尾后继续、real value 永不回扫；headers split/join 单向）；Assumption 14（「不改 secret-roundtrip mask / output-mask / secrets guard 任何一层的实现，只加……反向钉子测试」）；SC5。
   - **Surface:** `src/harness/secret-roundtrip/` 测试面（三层各一具名钉）、egress 装配层子串契约 fixture 与 body transform 夹具——三层源文件零 diff。
   - **Acceptance:** 以上每条为具名单测/夹具进 `npm test`：①三类假值喂 recognize 零命中且输入逐字回；②假值不进 output-mask 遮蔽集、屏上假值原样可诊断；③mode:block 不拦含假值工具参数；④铸两个嵌套假值 → 装配失败 typed 错误（F4 违例 fixture）；⑤「真值含假值前缀」构造体过 body transform → 替换产物不回扫、real value 永不回扫；⑥Assumption 14 的可核验形态：本弹 diff 仅测试文件，三层实现源文件不变；`npm test` 绿。
   - Status: [ ] pending
   - [blocks: T2, T3]

6. **T6 入口形态接线 + yolo 姿态显式** — tag: `[implementation]`
   - **Inherits:** spec T6（三装配点 `bash.ts` 前台 / `background/manager.ts` / `verify/sandbox-run.ts` 经同一 `createEgressSession` 获得凭据层、「无各面分支」，worker 走这三条；background 挂 `settle()` 释放通道覆盖 registry/store；yolo / isolation OFF「凭据装配函数入口显式分支『不铸造、不注入』，返回结构带 `skipped: \"no-fence\"` 之类别名进诊断/日志——离线可查证『此时宿主真值直达、无存在面保护』」）；Assumption 9（「姿态差异显式登记……不静默」）；Assumption 10 + F9（session 起不来 → 凭据层随 session 缺席，「infra 文案不变（不新增冒充）」）；invariant 7（fail-closed 全覆盖沿用）；SC9（yolo 断言 + SocatUnavailableError 无假值半注入）。
   - **Surface:** `src/harness/aci/tools/bash.ts`、`src/harness/background/manager.ts`、`src/harness/verify/sandbox-run.ts`（装配接线）、`credential-assembly.ts` 入口分支。
   - **Acceptance:** 三装配点 wiring 测试（工厂注入 seam）——各面对凭据零分支代码，差异只在生命周期表既有档位；yolo / isolation OFF 路径断言 = registry 未构造 + fence env 无假值键 + `skipped` 痕可离线查证（SC9，「看起来有保护实则无」的反命门闭合）；`SocatUnavailableError` 路径凭据层缺席且无假值半注入（wiring 测试）；`build-engine-egress-wiring.test.ts` 同族回归绿；**`createEgressSession` 缝扩展保持 ssh-bridge plan 可按同缝接线的形状（spec 依赖声明），本弹与对方 plan 对三装配点 / `session.ts` 的改动串行落地、合并冲突主会话裁**；`npm test` 绿。
   - Status: [ ] pending
   - [blocks: T3]

7. **T7 测试矩阵收口 + probe + TUI pty 实测（完成 = 实测过）** — tag: `[implementation]`
   - **Inherits:** spec T7 四面（单测/集成 T1–T6 各钉；集成臂 = 真起代理 + mitmCA + 自建 HTTPS echo server + 测试域进 `allowedDomains` 且凭据条目 `injectHosts=[测试域]` + 地址判定注入 seam 放行回环；probe 全类别全绿（仓规「动 fence bind 段必跑」）；TUI pty 五条；「真实 `gh` e2e 不触及 LLM 客户端/adapter 面，`npm run test:real-llm` 预期 Not run（理由 = 不触及，如实登记）」）；Assumption 12（echo seam「生产地址守卫不放宽」）；invariant 8（零新增第三方依赖，lockfile 无新条目）；SC1–SC11 全集；OQ3（假值前缀形态以本弹实测为准）。
   - **Surface:** 集成测试面（自建 echo 端点 + 注入 seam）、`scripts/sandbox-probe.ts`（默认不强行新增探针类别）、`mcp__aiterm__pty_*` TUI 真实装配链（干净装配 + 本机已配 gh 凭据）。
   - **Acceptance:** 集成 echo 双臂 binary 判据（SC3）——放行域 ∧ `injectHosts` 命中 → 宿主 echo 收到真值（header + body 各 1 例）、放行但条目收窄到别域 → 假值原样到达、非放行域 → 既有 403 面不变；`Content-Encoding` 体原样透传 + 诊断痕（SC6）。TUI pty 实测五条照 spec T7 钉：①围栏内 `echo $GH_TOKEN` → `fake_value_…`（SC1 屏上）；②`cat ~/.config/gh/hosts.yml` → 假 token 且 YAML 结构完整可被 gh 解析（SC7）；③`gh auth status` 登录态可用；④`gh pr list`（真 repo）成功 = header 代换端到端生效（SC2）；⑤屏上证据入验收报告——③④同时是 T4 三臂（gh/git/curl）TLS 与 F8「env 已设 ≠ 围栏内真跑 TLS 客户端」判据的直接实证。OQ3 当场裁定：若 gh 拒收 `fake_value_…` 前缀，改 `gho_` 同形铸造（装配层参数，不开新弹）。`npm run probe:sandbox` 全类别全绿且 dispose 后不留 stale（SC11）；`npm test` 全绿 + lockfile 零新条目 assert（invariant 8/SC10）；`npm run test:real-llm` 按 Not run 格式登记（理由 = 不触及）；transcript 片段归档于验收报告。
   - Status: [ ] pending
   - [blocks: T4, T5, T6]

## Notes

- **编号即契约**：子弹 1–7 与 spec T1–T7 一一映射，commit 拆分审计（`git log` / `git diff --stat`）按此对号；任何实现者想再细分（如 T2 拆 env 铸造 / bind 扩段两 commit）合法——粒度「一致或更细」，不得更粗。
- **T1 与 T4 并行、T2 汇合**：两颗前置弹无共享 mutable state；T2 同时消费名册（T1）与可装载 CA（T4）。
- **probe 新类别裁定**：T7 默认不新增探针类别；若实现期加「masked bind 盖过真路径」物理探针，须同步 `security-boundaries` 的 11 类纪律说明（spec T7 原文）。
- 全部 bullets 落地后进入 end-of-round code review phase，再走 `arthurpower:verification-before-completion` 闭轮；assumption 人类 gate 与 OQ 裁定均由主会话走，不阻塞本 plan 执行、只可能触发 Header 所列局部回退。
