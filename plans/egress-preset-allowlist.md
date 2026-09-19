# Plan: egress-preset-allowlist —— 出口域名允许集的代码承载预放行档

**Goal:** 域名允许集出厂即带预放行档（github 三域 + npm registry + playwright 两域），全集 = preset ∪ 用户层增量、deny 优先；配置段缺席时工厂恒返 policy，egress session 必起、首见批准门从死码恢复在岗；`allowlistSource` 清算为封闭三档 `builtin/persisted/session`。
**Approach:** 按 spec T1–T5 各切一颗垂直子弹：先落 preset SSOT 与 assembly 合并语义（工厂不再返 `undefined`），再全链清算 source 撞名与文案联动，然后用测试钉死批准门在岗与 ADR-0097 §生命周期表落差闭合，最后 probe 物理面回归 + TUI pty 实测作为仓规地面。姊妹面边界：SSH/SOCKS 传输面在 `specs/egress-ssh-bridge.md`（另一 plan），凭据面（gh 登录态、ssh-agent 出口）在 `specs/egress-credential-sentinel.md`——两者均不入本 plan；settings 写回（OQ1）显式不阻塞。
**Spec link:** `specs/egress-preset-allowlist.md`
**ACR:** all-yes（与 spec 块相同）
**Tracker:** 本地 markdown fallback（仓惯例，无 GitHub issue 边；blockers 以 `[blocks: Tn]` 标注）。
**待写入:** 无——「预放行档（builtin preset）」「域名允许集」词条已随 ADR-0104 flush 落 `docs/CONTEXT.md`（实证：词条 + vs 辨析行已在册），本 plan 无新增词条、无 ADR reopen 项。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## ACR

```text
bounded-context-guardian: yes — SSOT 单点：preset 清单仅 preset-domains.ts（Boundaries Does#1「仅此一处」）、合并仅 assembly（invariant 2）；settings schema 不改（Out#3）；grep 实证 domain-matcher.ts/approval.ts 零 "preset" 引用，egress 不反向 import config（assembly.ts:8-9 DI 纪律保持）
defensive-contract-validator: yes — 合并五边界各有钉：去重+次序（T1）、deny 优先砍 preset 且 F1 钉住 `*.github.com` 不含 apex 不对称、用户空列表不缩档（T1 皆空路径+SC3）、非法条目由 settings 层 parseIsolationNetwork+onWarn 留痕后 F3 退 preset-only、批准门单问（T3 交互/非交互双臂）
error-handling-enforcer: yes — F1-F6 全部 typed（denied-by-user / no-approval-inlet / address-denied / SocatUnavailableError / allowlist-empty 保留于直喂路径 F2），T3 明确「静默 DNS 失败 → 有名字的可行动违例」，三档 source 为封闭联合且「不留旧值别名」
complexity-anti-drift: yes — 复用 decideEgress/approval 缝不新造匹配器（Inherits「不动」+ T3「复用 T6 注入 filter 驱动 seam」）；allowlistSource 波及面经 grep 实证枚举（violations.ts:29/173-177、session.ts:78、assembly.ts:19/119、bash.ts:643-644）
minimal-change-verifier: yes — 范围严格对应 ADR-0104 §Decision 1-4；SSH/SOCKS、web_fetch 栈、settings 写回（OQ1 显式不阻塞）、schema 变更均列 Out-of-scope；T2 撞名清算系必要清算非夹带
OVERALL: PASS — hand to writing-plans
```

## Tasks (ordered by dependency)

1. **preset 常量 + 合并装配：段缺席工厂恒返 policy** — tag: `[implementation]`
   - **Inherits:** spec invariant 1（preset 是代码常量不是配置，无「关档」开关）、invariant 2（判定输入构造只发生在 assembly 一处，SSOT）、invariant 3（生产装配恒返 policy，`undefined` 分支仅留给测试/yolo 显式豁免路径）、T1（`BUILTIN_PRESET_ALLOWED_DOMAINS` frozen 6 条目逐字 = Boundaries 清单；段缺席 → preset-only；段在场 → 去重(preset ∪ 用户 `allowedDomains`)、`deniedDomains` 只取用户层；在场但两列表皆空 → 同「在场」路径不缩档）、SC1/SC2/SC3、F2（`allowlist-empty` 经工厂路径不可达但判定/渲染件不删）、F3（settings 段非法被丢弃 → preset-only）、ADR-0104 §Decision 1–2
   - **Surface:** `src/harness/sandbox/egress`（新增 `preset-domains.ts`——spec 已冻结此文件名，清单 SSOT 仅此一处；改既有 `assembly.ts`）
   - **Acceptance:** `egress-assembly.test.ts` 断言反转——旧「段缺席 → undefined」改为「段缺席 → preset-only policy，source 为 builtin 档」；合并去重且 preset 前置次序可测；`decideEgress` 直喂合并结果：`github.com` apex 与 `*.github.com` 子域双命中、`registry.npmjs.org` 命中而 `npmjs.org` apex 不命中（钉住不误扩）、`evil-github.com` / `github.com.evil.io` 不命中（后缀锚定回归）；preset 清单不含已知模型供应商域的反向断言；F1 不对称单测（用户 deny `*.github.com` 砍子域后 apex 仍在）；工厂返回类型保持 `() => EgressPolicyInput | undefined` 不缩（background/verify 消费面类型零改动）；`npm test` 绿
   - Status: [x]

2. **`allowlistSource` 三档清算 + 违例文案联动** — tag: `[implementation]`
   - **Inherits:** spec invariant 4（封闭三档 `"builtin" | "persisted" | "session"`，全链一次改齐、不留旧值别名）、invariant 6（纯 infra 文案不掺配置指引，source 标签只出现在域判定段）、T2 钉死表（三档生产者归属与 `SOURCE_LABEL` 渲染行不变格式）、SC4、联动点 grep 实证全集（`violations.ts` 类型与标签、`session.ts` inline union 收敛为引用消双处漂移、`assembly.ts` 注释+赋值、`bash.ts` 工厂包装层 fallback）
   - **Surface:** `src/harness/sandbox/egress`（`violations.ts`、`session.ts`、`assembly.ts`）、`src/harness/aci/tools/bash.ts`（source fallback 接线）、既有 egress 测试面
   - **Acceptance:** 三档各有真生产者与消费渲染测试（`persisted` 档自始有真生产者，消灭零生产者占位）；grep 断言全仓无字符串 `"preset"` 残留在 source 语义位（渲染文案 `"built-in preset allowlist (github / npm / playwright defaults)"` 除外）；`not-in-allowlist` / `no-approval-inlet` / `denied-by-user` 行文案结构不变、配置键指引仍指 `isolation.network.allowedDomains`；`bash-egress-typed-failure.test.ts` / `egress-violations.test.ts` 迁移后 source 标注逐字钉子绿；`npm test` 绿
   - Status: [x]
   - [blocks: T1]

3. **批准门恢复在岗 + 生命周期落差闭合的测试钉** — tag: `[implementation]`
   - **Inherits:** spec invariant 3（本条以测试显式引用 ADR-0097 §生命周期表「允许集非空或批准流可问才起」+ ADR-0104 §Consequences「副作用（正向）」闭合实现落差，不另立文字例外）、invariant 5（fail-closed 面不缩：批准门非交互拒、代理死 fail-closed、地址守卫正交逐字继承）、T3（三臂验收）、SC5
   - **Surface:** `src/harness/sandbox/egress`（批准缝，复用注入 filter 驱动 seam、不真起代理）、`build-engine-egress-wiring.test.ts`（既有装配接线测试面）
   - **Acceptance:** 三条单测——①干净装配（无 settings 网络段）交互前台访问档外域触发首见批准门（ask 一次），批准 → 本会话放行，拒绝 → `denied-by-user` 违例回灌 `execution_failed`；②干净装配非交互面（background / verify）档外域 → `no-approval-inlet` fail-closed，违例回灌有名字（区别于旧「session 不起、静默 DNS 失败」）；③wiring 断言 `settings` 无 `isolation.network` 时 `egressPolicyFactory()` 返回非 `undefined`；「批准门死在入口」旧行为有回归反转记录；`npm test` 绿
   - Status: [x]
   - [blocks: T1, T2]

4. **probe 物理面回归 + 不加真网 probe 的裁定维持** — tag: `[implementation]`
   - **Inherits:** spec T4（默认不新增真域 probe 类别避免 CI 抖动，登记于此；若实现期新增须同步 `security-boundaries` 的 11 类探针纪律说明）、F4（宿主缺 socat → `SocatUnavailableError` infra 文案不冒充域判定拒绝，既有面回归即可）、F5（preset 命中不豁免地址守卫，invariant 5）、仓规「动 fence 相关必跑 probe」
   - **Surface:** `src/harness/sandbox`（fence 装配面）、`scripts/sandbox-probe.ts`
   - **Acceptance:** `npm run probe:sandbox` 全部类别全绿（11 类探针维持）；F5 单测钉住 preset 域解析到私网/loopback（rebinding）照拒、`address-denied` 文案不变；F4 既有面回归绿；未新增真网 probe 类别（或已按纪律同步登记）
   - Status: [x]
   - [blocks: T1]

5. **TUI pty 实测：三操作屏上证据（仓规地面）** — tag: `[implementation]`
   - **Inherits:** spec T5 三条操作、SC6（`npm test` + probe + TUI 实测证据留档）、F1 不对称在文案与测试双向钉住、OQ2（playwright 两域以 webui 浏览器二进制下载实测复核）、Boundaries Out（凭据面未就绪的 `git push` 遗留如实登记，不算本档失败）
   - **Surface:** `mcp__aiterm__pty_*` 起 TUI 的真实装配链（干净 settings：无 `isolation.network` 段）
   - **Acceptance:** 三条操作各有 transcript 屏上证据——①`curl -sI https://github.com` 直通（档内无需批准）；②`curl -sI https://example.com` 触发首见批准门：拒 → tool_result 含 `[network_denied]` + 字面 `Current allowlist source: built-in preset allowlist (github / npm / playwright defaults).`；批 → 同会话再访不再问；③`git push --dry-run`（https remote）档内可达（凭据遗留如实登记）
   - Status: [ ] pending
   - [blocks: T2, T3]

## Notes

- **T1/T2 的落地次序留 headroom**：T1 测试钉 `"builtin"` 字面值意味着封闭联合的枚举扩展须随其一 landing——union 改动放 T1 还是 T2 由实现者按「每颗子弹单 commit 且 build 绿」自行裁量，两颗合起来的形状由 Acceptance 钉死。
- **OQ1（批准写回 settings）不阻塞**：`persisted` 档生产者暂由「settings 段在场」承担；写回 API 落地时若需第四档另裁。
- 全部 bullets 落地后进入 end-of-round code review phase，再按 `docs/guides/prompt-development.md` 之外的常规收尾（`arthurpower:verification-before-completion`）闭轮。
