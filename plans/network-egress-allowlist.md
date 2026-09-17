# Plan: 出口代理缝 —— 域白名单网络边界

**Goal:** bash 围栏的出口从「二值开关」改为唯一通路：netns 恒定断网 + 宿主出口代理缝 + 域名允许集判定，旧 per-call `network:true` 轴整体废除、不留双轨。
**Approach:** 先落决策（代理生命周期 / dispose 契约 / 批准持久化粒度——spec 明说这层不留给实现即兴）。再并行做两个纯逻辑件（配置层解析纪律、域匹配与地址守卫适配层），它们是判定核心、可脱离沙箱单测。然后 **expand**：代理 + 桥 + 环境注入在与旧路径并存的前提下打通出网，接上违例回灌与首次域名批准流，确认新路真的能用。最后 **contract**：把 `--unshare-net` 收成恒定项，再清掉已成惰性的旧轴全链与对应测试。`--yolo`(#1035)、内容级管控、反向可达、network-guard 栈均不在本计划。
**Spec link:** `specs/network-egress-allowlist.md`
**ACR:** PASS（四轮终裁，全 yes；裁决史与 block 见下节）
**待写入:** ADR-0097 `proposed` → `accepted`（随 contract 子弹落地翻状态）；T1 若判定满足三条件则新开 ADR（生命周期接口）；无新 CONTEXT 词条（出口代理缝 / 域名允许集已在 spec 阶段落盘）。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## ACR

**终裁（第四轮，2026-09-17）：PASS**

```
bounded-context-guardian: yes — 模块边界未动, 删除面与新 egress 域各居其位
input-contract-tests: yes — 5 边界类测试矩阵由 plan T1–T6 任务覆盖, 上轮已实测收敛
error-handling-enforcer: yes — T5 typed failure 三跳通道契约 + 三类信号互相可区分, 上轮已 yes
complexity-anti-drift: yes — 单任务单抽象, 8 个 T 任务各自一域, 无 god-function/file
minimal-change-verifier: yes — 20 文件迁移表与 10 文件编译连锁注记均经独立 grep 实证, T8 Inherits 显写"替代"非"只删 import"
OVERALL: PASS
```

**裁决史**（每轮 `no` 均经代码实测收敛后再裁）：

- **rev 1** BLOCKED — input-contract-tests（允许集解析语义与 settings 纪律矛盾）/ error-handling-enforcer（违例回灌缺具名通道）/ minimal-change-verifier（删除面漏列 + 依赖分叉未关）。收敛：invariant #7、Violation feedback channel、Deletion surface 初表、spike 闭环（commit `8896771f`）。
- **rev 2** BLOCKED — error-handling-enforcer（**tier 升级路径结构性不可达**：`violation-handling.ts:120-122` 非 `execution_failed` 直接返回 undefined，而 bash 非零退出走 `kind:"ok"`）/ minimal-change-verifier（漏 4 生产文件 + 7 测试文件；node-forge 声明被证伪）。收敛：选定形态 (a) 转 typed failure、私网 opt-in 前提、清单补至 17 生产文件（commit `ec95eb09`）。
- **rev 3** BLOCKED — minimal-change-verifier 仅剩：测试迁移清单漏 4 个 `createNetworkPolicy` import 文件（编译连锁）。收敛：清单补至 20 文件 + 编译连锁注记 + T8 替换语义（commit `6cd367b9`）。
- **rev 4** PASS（终裁 block 如上）。

## Locked before slicing

spec 已钉死、实现者不必再选的项：`--unshare-net` 恒在且无逃生开关；判定只看 CONNECT host 不解密；fail-closed 全覆盖；删除而非并存；只认用户层配置；地址守卫与域名集正交；配置层永不抛但恒留痕且丢弃方向恒为收紧；违例文案所有权在本仓（三跳通道）。
实测事实（ADR-0097 已记）：上游代理拒绝文案硬编码、`socat` 为宿主前置依赖且未 vendored、包无 `exports` 字段、匹配器件可独立导入。

## Tasks (ordered by dependency)

1. **[parallel] 代理生命周期 / dispose 契约 + 批准持久化粒度** — tag: `[decision]`
   - **Inherits:** spec「代理实例三形态，plan 必须落成显式接口（不留给实现即兴）」；`Confirms with human` 两项：首次批准的持久化粒度、代理进程生命周期细节
   - **Surface:** `docs/adr/` 与 `specs/network-egress-allowlist.md`——决策的落点文档即本条产物
   - **Acceptance:** 三形态（前台 per-call / background per-task / verify 随宿主）各有明确的起、绑、注入、释放时机，**异常路径的释放**被显式写出；批准持久化粒度（仅会话 vs 可写回用户层）有单一裁定；两份文档不与 ADR-0097 现有决策冲突。**验收前须取得 operator 对上述两项 `Confirms with human` 的确认**
   - Status: [x] done

2. **[parallel] 用户层允许集配置键** — tag: `[implementation]`
   - **Inherits:** spec: 只认用户层 settings（ADR-0084 纪律）；配置层永不抛、恒留痕、丢弃方向恒为收紧；键名 `isolation.network.allowedDomains` / `deniedDomains`；项目层同段丢弃
   - **Surface:** `src/config`（现有 settings 解析与 merge 路径），新解析体入独立文件，主文件只加接线点
   - **Acceptance:** 用户层写入的允许集经 reader 原样读回；项目层同段不生效；空集、非字符串条目、裸 `*`、`:port` 越界（0 / >65535 / 非数字 / 空）逐条按 spec 的输入契约表处置——**丢弃该条目而非抛错，且丢弃有可观测留痕**；合法条目不受同批非法条目影响
   - Status: [x] done

3. **[parallel] 域匹配与地址守卫适配层** — tag: `[implementation]`
   - **Inherits:** spec: `*.x` 严格子域不含 apex、可选 `:port`、deny 优先；地址守卫拒 loopback / 私网 / link-local / metadata 且与域名集正交；地址守卫**只有一份实现**（复用上游 `resolved-address-guard`，不另写私网判定）；上游件经**单一适配层**收口（包无 `exports` 字段）；**私网拒绝须经 `deniedResolvedAddresses` 显式 opt-in**（上游 `DENIED_CLASSES` 故意不含 RFC 1918 / ULA / CGNAT）
   - **Surface:** `src/harness/sandbox/` 新目录下的适配层；上游依赖的引入依据随 lockfile 变更写入 commit 正文
   - **Acceptance:** 命中允许集的 host 判 allow；未命中判 deny；deny 优先于 allow；`*.example.com` 匹配子域、不匹配 apex、不匹配 `evilexample.com` 与 `example.com.evil.com`；大小写不敏感；允许集域名解析到私网 / loopback 一律拒（DNS rebinding 防线，**含 RFC 1918 / ULA / CGNAT——验证 opt-in 确实传了**）；上游版本升级只需改这一个文件
   - Status: [x] done

4. **沙箱内出网经代理可达（expand：旧路径仍在）** — tag: `[implementation]`
   - **Inherits:** spec: 宿主出口代理（HTTP CONNECT + SOCKS5）的 unix socket bind 进沙箱、沙箱侧转本地端口、`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 注入；`--unshare-net` 此时仍可被旧路径摘除（本条是 expand，不是 contract）；宿主缺 `socat` 时 fail-closed 且给出补装指引；argv 顺序纪律与 fsMode / workspace mount 不动
   - **Surface:** `src/harness/sandbox/`（新 egress 目录 + bwrap argv）、`src/harness/aci/tools/bash.ts`、T1 定的生命周期接口
   - **Acceptance:** 沙箱内 `curl` 经代理拿到命中允许集站点的真实 HTTP 响应；未命中站点被拒且**不**回落直连；代理 / 桥进程被杀后后续出网调用失败、不出现直连回落；非代理感知程序（raw socket）在沙箱内无路由；宿主缺 `socat` 时网络能力 fail-closed 并给出可执行指引（用注入的探测结果断言，不依赖 CI 是否装了 socat）；异常路径不泄漏代理进程
   - Status: [x] done
   - [blocks: T1, T2, T3]

5. **违例记录与回灌通道** — tag: `[implementation]`
   - **Inherits:** spec「Violation feedback channel」三跳通道（本仓 `filter` 回调记录 → bash handler 收尾 drain → **转 `execution_failed`**，message 载违例文案）；前缀沿用 `VIOLATION_PREFIXES.networkDenied`；选定形态为 spec 的 **(a) 转 typed failure**（非扩展 tier 门）；三类信号（域判定拒绝 / 上游故障 / 基础设施故障）必须互相可区分
   - **Surface:** `src/harness/sandbox/`（记录侧）、`src/harness/aci/tools/bash.ts`（回灌侧）、既有 violation tier 挂点
   - **Acceptance:** 未命中域名时模型可见的 tool_result 以 `execution_failed` 形态含被拒域名、允许集来源与补配指引，且**不**含代理自带的硬编码文案作为唯一说明；文案同时交代「命令已跑完但出网被拒」，不误导为进程崩溃；未命中 → 域判定拒绝、上游失败 → 上游故障、进程死 → 基础设施故障，三者文案互不混淆；`networkDenied` 前缀能触发既有 mid-tier 升级路径（**测试走 bash 真实返回形状 handler → executor，不得直接构造 `execution_failed`——那是假绿**）
   - Status: [x] done
   - [blocks: T4]

6. **首次域名批准流** — tag: `[implementation]`
   - **Inherits:** spec: 交互入口首见新域名走既有 ask 面问一次、批准 = 会话级放行 + 按 T1 的粒度可选持久化；非交互入口（background / verify / 无 ask 面）无法问 = fail-closed 拒绝；pending 期间同域名并发请求**合并为一次询问**（后到者等待）；拒绝后该域名本会话不再问；持久化写回失败降级为仅会话放行、**已批准的调用照常执行**；不做预置常用域兜底集
   - **Surface:** `src/harness/permission/`（ask 面）与 `src/harness/sandbox/`（判定侧）的接缝
   - **Acceptance:** 交互入口新域名触发一次 ask，批准后本会话内不再问；同域名并发首见只问一次；非交互入口直接拒绝且违例含缺失域名与建议的配置键；拒绝后不再重复询问；持久化失败不导致已批准的调用失败
   - Status: [x] done
   - [blocks: T5]

7. **`--unshare-net` 收成恒定项（contract 第一步）** — tag: `[implementation]`
   - **Inherits:** spec: `--unshare-net` 恒在、任何路径不摘除；覆盖**全部 3 处 fence 装配点**（前台 / background / verify——实测 subagent worker 不单独造 fence）；探针类别随之改建
   - **Surface:** `src/harness/sandbox/bwrap.ts` 与三处装配点、`scripts/sandbox-probe.ts`
   - **Acceptance:** 三处装配点产出的 argv 在任何输入下都含 `--unshare-net`；旧 opt-in 路径不再能摘除它；`npm run probe:sandbox` 全部类别全绿（新增 fence flag 必跑）；旧 opt-in 探针类别改建后仍能证明「经代理可达 / 无代理不可达」
   - Status: [x] done
   - [blocks: T6]

8. **旧 opt-in 轴全链清算 + 测试迁移** — tag: `[implementation]`
   - **Inherits:** spec「Deletion surface」表（17 个生产文件逐行号）与「测试迁移清单」（20 个测试文件，含 `createNetworkPolicy` 编译连锁的 10 文件）；spec: 删除而非并存、不留双轨；`VIOLATION_PREFIXES.networkDenied` **不删**（已升级为真拒绝路径的发射前缀）；`manager.ts:265` 的 `createNetworkPolicy()` 位置由**新 egress 域判定 + 地址守卫替代**，不是只删 import——`createBwrapFence` 的 `networkPolicy` 字段随之移除，代理判定接管该职责
   - **Surface:** `src/harness/permission/`（含 `ask-user.ts` 的 `PendingAskView.network`）、`src/harness/aci/tools/bash.ts`、`src/harness/background/`、`src/harness/verify/`、`src/harness/sandbox/`、`src/tui/`（ask 视图的 `[宿主网络]` 标记与 `network` 透传）、`scripts/` 两个探针及对应 `tests/harness/**`
   - **Acceptance:** spec 删除面表逐行的对象全仓 grep 无残留（bash input 的 `network` 字段与 description、`code-ask-bash-network` 规则、`isBashNetworkTrue`、`wantsHostNetwork` 全部分支、`BackgroundSpawnRequest.network`、`AskUser` ctx 与 `PendingAskView.network`、`NETWORK_HINT_MARKER` / `summarizeNetworkBash` / `NETWORK_HINT_TAIL` / `SECRET_WARNING`、`network:` declarative specifier 家族、`createNetworkPolicy` / `STATIC_NETWORK_WHITELIST` / `NetworkPolicy.assertDomain`）；**三处 UI 渲染点全清**（`tui/app.tsx`、`tui/modal.tsx`、`web/components/PermissionDialog.tsx` 的 `[宿主网络]` / `host network` 标记）；20 个测试文件改写为钉住新语义而非删除断言（含 CI 排除清单内两个 e2e，不得因 CI 不跑而跳过；含 `createNetworkPolicy` 编译连锁的 10 文件摘除 import 与 `networkPolicy:` 传参）；`npm test` 全绿；ADR-0097 状态翻 `accepted`
   - Status: [x] done
   - [blocks: T7]

## Notes

- **Affected files**（review 枚举用，非实现者冻结）：`src/config/settings.ts` + 新解析文件、`src/harness/sandbox/egress/*`（新）、`src/harness/sandbox/{bwrap,index,network-policy}.ts`、`src/harness/aci/tools/bash.ts`、`src/harness/permission/{policy,permission-executor,types,declarative,prefixes}.ts`、`src/harness/background/manager.ts`、`src/harness/verify/sandbox-run.ts`、`scripts/sandbox-probe.ts`、`tests/harness/**` 9 个测试文件、`docs/adr/0097-*.md`。
- **T2 / T3 可并行**：两者无相互依赖（匹配器是纯函数，不消费配置解析的返回形状），但 T4 同时消费两者。
- **T7 与 T8 的次序不可颠倒**：T7 一旦落地，旧 opt-in 即失效；必须确认代理缝与批准流真的能用（T4–T6）之后再收恒定项，否则会留下「旧路已断、新路未通」的窗口。
- **上游依赖风险**：`@anthropic-ai/sandbox-runtime` 为 beta，深路径导入无契约稳定性——适配层是唯一收口点（T3 已把这条写进 Acceptance）。
