# Plan: 工具渐进式披露对齐修复（#631 审计三项）

**Goal:** 修掉对照 Claude Code 审计出的披露机制缺陷：discovered 工具破坏 KV cache 前缀、MCP 开局失明、tool_search 无引导。
**Approach:** 三个独立 tracer bullet，各 1 commit。T1 只动 `visibleSchemas` 的组合语义（尾部追加）；T2 仿 `<available_skills>` 段先例走 `deps.system` 缝注入 MCP 概览；T3 纯文案。不做：内建工具 lazy 化、检索算法升级（#635 裁决）。
**Spec link:** 无 spec（gh-22 skip-spec：决策由 [wayfinder grilling #635](https://github.com/winter6205/iknow/issues/635) 承载，5 段要素齐备）；对照基准 = #632 / #633 / #634。
**Tracker:** GitHub 主路径（每 bullet 一个 `ready-for-agent` issue + 原生 blocking 边）。
**ACR:** 全 yes（两处在切片时解决，见下方记录）

```
bounded-context-guardian: yes — T1 限于 aci-registry 内部；T2 走 deps.system 既有缝，mcp manager 只读
defensive-contract-validator: yes* — *ACR 初判 unclear：T2 缺边界矩阵；已在 T2 Acceptance 补齐 5 类边界
error-handling-enforcer: yes* — *ACR 初判 unclear：T2 缺席/降级渲染未定义；已补渲染契约
complexity-anti-drift: yes — 三 bullet 各为单一职责小改，无 god-function 意图
minimal-change-verifier: yes — ACR 初判 no 实为执行约束：3 bullet = 3 commit，禁合并落地（本计划即按此切片）
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## 待写入（persist 段）

- CONTEXT.md 新词条「渐进式披露 (progressive disclosure)」：便宜索引常驻（skill 清单 / MCP 概览）+ 重载荷按需（SKILL.md 全文 / 工具完整 schema）；iknow 机制 = lazy + discover + visibleSchemas（非 lazy 注册序 + discovered 发现序尾追加）+ 两级工具披露。含 _Avoid_：把发现的工具插回注册序中部（破 KV cache 前缀）；只延迟载荷不给索引线索。
- Status: [x] done — 2a53ac93（PR #640）

## Tasks (ordered by dependency)

Each numbered item is one tracer bullet: one vertical-slice outcome, one tag, one commit, headroom for the implementer.

1. **T1 discovered 工具尾部追加（保 KV cache 前缀）** — tag: `[implementation]`
   - **Inherits:** #635 P0 裁决："discovered 工具 append 到 tools 数组尾部，不按注册顺序插回"；对照基准 = CC 官方 "Discovered tool schemas are appended to the request, not swapped in — this preserves the prompt cache"（#633）；不变式继承 #224：非 lazy 工具注册顺序与集合不变、discovered set 闭包于 registry 不跨 session。
   - **Surface:** `src/harness/aci`（registry 的可见面组合逻辑）。
   - **Acceptance:** ① 可见面 = 非 lazy 全量（注册顺序、字节级不变）后接已发现 lazy 工具（发现顺序）；② 无新发现的相邻两轮，可见面前缀完全不变（可断言数组前 N 项逐位相等）；③ 既有发现语义测试（`tests/harness/loop-engine/discovered-set.test.ts` 所守护的行为）全绿不降级。
   - Status: [x] done — 36468365（PR #640）；code-review 跟进 d32ac617

2. **T2 MCP 概览段注入（索引常驻档）** — tag: `[implementation]` `[parallel]`
   - **Inherits:** #635 P1 裁决："每服务名+一句话描述，工具名+短描述（首行、截 ~120 字符），末行引导 tool_search 精查"；装配缝契约 = 「deps.system injection seam」（CONTEXT.md：唯一权威缝、禁绕开、禁发空串）；段渲染先例 = `<available_skills>`（assemble.ts:268-280 形态）。
   - **Surface:** `src/harness/identity`（段渲染）+ `src/harness`（build-engine 装配接线）+ `src/harness/mcp`（只读元数据，不改行为）。
   - **Acceptance:**
     - 有已连接 MCP 服务时，system prompt 含概览段：每服务一行（名+描述），其下每工具一行（名+短描述），末行引导文案。
     - 5 类边界：① **短描述截断**：取描述首行、超长截到 ~120 字符（临界值有测试）；② **空服务列表**：无连接服务 → 段整体缺席（不发空串，不破前缀）；③ **异步连接**：装配后连接成功的服务，下一轮装配周期自然出现——段内容在装配时刻取快照，不为等待连接引入阻塞或空转渲染；④ **元数据异常**：读取抛错 → 段缺席（降级不毒化，同 memory resolver 先例）；⑤ **缺失/失败态**：`description` 缺失 → 只渲染工具名；`failed` 态服务 → 整服务不渲染。
     - 既有 `<available_skills>` 段行为不受影响。
   - Status: [x] done — 470497b9（PR #640）；code-review 跟进 d32ac617

3. **T3 tool_search 引导文案** — tag: `[implementation]` `[parallel]`
   - **Inherits:** #635 P1 裁决："description 声明检索范围含 MCP + 换词引导；(no matches) 加引导语"；未命中引导先例 = `skill` 工具 "Use skill_search to find available skills."（skill.ts:54）。
   - **Surface:** `src/harness/aci/tools`（tool_search 一件）。
   - **Acceptance:** ① description 明确检索范围含 `mcp__` 前缀工具、并提示先搜后用的使用时机；② 空参/无匹配返回值为合法字符串且含换词或直呼名（配 `names` 参数）引导；③ 既有 `(no matches)` 契约测试更新后全绿（返回值形态不变、仍为合法返回非错误）。
   - Status: [x] done — a45aae29（PR #640）

## Code review phase

三 bullet 全部落地后，整轮改动过一次 end-of-round code review，再收尾。Status: [x] done — d32ac617（PR #640）
