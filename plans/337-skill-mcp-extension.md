# Plan: ACI 扩展源 skill 工具 + MCP 客户端（#337）

> **Spec**: `specs/337-skill-mcp-extension.md`（ACR Round 2 五裁决 5/5 yes，2026-08-10）
> **Map**: wayfinder:map #337；决策出典 R1 #338 / R2 #339 / G1 #340 / G2 #341 / G3 #342
> **Tracker**: GitHub issue #344（`ready-for-agent` 标签，**单 issue 承载全部 12 bullets——操作员裁决不拆票**，同 #321/#343 先例）；blocked-by 以本文件依赖图为真值。
> **前置隔离**（spec 假设 15）：工作树已存在的 `package.json` / `package-lock.json` 未提交漂移与本 plan 无关——执行第一票前先单独提交或 stash 隔离，此后每票 diff 只含 Affects 所列文件。

## 依赖图

```
D1（ajv 探针）──┐
T1（动态缝）────┼──────────────────── T7（manager）── T10（集成链）──┐
T3（config）────┤                                                     │
T4（adapter）───┘                                                     │
T2（scanner）── T5（两件工具）── T6（正文+清单段）──┐                 │
                │                                   ├─ T8（装配）─────┼─ T11（E2E A）
                └── T9（seed 迁移）────────────────┘                 │
```

- `[parallel]`：T1 ∥ T2 ∥ T3 ∥ T4（互不消费彼此产出）；T5/T6 仅依赖 T2 链；T7 依赖 D1+T1+T3+T4
- D1 只阻塞 T7（探针结论决定 manager 注册路径是否需 schema 归一化）

---

## Tracer Bullets

### D1. `[decision]` ajv strict × MCP inputSchema 兼容性探针 `[blocks: T7]`

- **Affects**: `scripts/mcp-schema-probe.ts`（新，一次性探针）
- **Acceptance**:
  1. 探针用仓库同款 ajv 配置（`strict: true` + ajv-formats，同 `src/harness/tools/registry.ts:30-34`）编译三组 MCP 形态 schema（plain / `$ref` / `anyOf`，样本取自 codebase-memory-mcp 实测工具 schema），输出每组 pass/fail
  2. 结论写入本 plan D1 裁决区：**全 pass → T7 直连**；**任一 fail → T7 前置 schema 归一化子步骤**（只作用于 MCP 注册路径，不改全局 ajv，spec Boundaries Ask first）

### T1. `[implementation]` registerExternal 动态注册缝 + Gate 2/Gate 3 豁免 `[parallel]`

- **Affects**: `src/harness/aci/aci-registry.ts`、`tests/harness/aci-registry-external.test.ts`（新）
- **Acceptance**:
  1. `registerExternal(defs)` 存在：追加项过 Gate 2 防撞（非 `mcp__` 前缀即抛 `RegistryConstructionError`）+ 查重 + 同 ajv 实例编译 validator；追加后 `catalog.get/all`、`discover`、`visibleSchemas` 可见（lazy 默认不进 visibleSchemas，discover 后晋升）
  2. `inner.list()` 快照不变（追加前后长度相等，单测断言）；`ACI_TOOLSET_NAMES` Gate 3 静态校验不受影响（registry.test.ts 既有断言仍绿）
  3. `npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T2. `[implementation]` skill 扫描器 + catalog 索引 `[parallel]`

- **Affects**: `src/harness/skill/scanner.ts`（新）、`src/harness/skill/catalog.ts`（新）、`tests/skill/scanner.test.ts`（新）、`tests/skill/catalog.test.ts`（新）
- **Acceptance**:
  1. 三级路径扫描 `~/.iknow/skills` → `<cwd>/.iknow/skills` → `IKNOW_SKILL_DIRS`，同名后扫覆盖（覆盖序单测断言）；`.claude/skills` 零扫描（反例单测）
  2. frontmatter：生效三字段（name/description/disable-model-invocation）+ 存档六字段；description >1536 截断 + warn；布局只认 `<dir>/SKILL.md`
  3. 兜底：缺 name → 父目录名；缺 description → 加载不入清单；解析失败 → 跳过 + warn 不毒化；全目录缺席 → 空索引不抛（SC2）
  4. `npm test` 全绿（tmp fixture SKILL.md，无网络）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T3. `[implementation]` MCP 两级 config 解析 `[parallel]`

- **Affects**: `src/harness/mcp/config.ts`（新）、`tests/mcp/config.test.ts`（新）
- **Acceptance**:
  1. 两级 union：`~/.iknow/mcp.json` + `.iknow/mcp.json`，同名 server 项目级条目级整体覆盖（单测断言无字段级深合并）
  2. 判别联合 `{type:"stdio"|"remote"}` 校验；`disabled:true` / `enabled:false` → disabled 态；坏条目跳过 + warn 恰好一行且不含 env 值（SC7）
  3. 不读 `~/.claude.json` / `.kiro/settings/mcp.json`（代码 grep 零命中）；`npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T4. `[implementation]` McpToolAdapter `[parallel]`

- **Affects**: `src/harness/mcp/adapter.ts`（新）、`tests/mcp/adapter.test.ts`（新）
- **Acceptance**:
  1. 命名 `mcp__<server>__<tool>` 双段 sanitize；元数据四元组 = lazy:true / category:write / isConcurrencySafe:false / interruptBehavior:cancel；inputSchema 缺席兜底 `{type:"object", properties:{}}`
  2. wire 三分支（SC10）：structuredContent 优先 / isError:true 返文本不抛 / 协议错误抛 execution_failed（stub client 单测全覆盖）
  3. adapter 无截断逻辑（契约 X，grep `slice|truncate` 于 adapter 零命中）；`npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T5. `[implementation]` skill / skill_search 两件工具 + 名单 21→23 `[blocks: T2]`

- **Affects**: `src/harness/aci/tools/skill.ts`（新）、`src/harness/aci/tools/skill-search.ts`（新）、`src/harness/aci/tools/registry.ts`、`tests/harness/registry.test.ts`（改断言 23 件）
- **Acceptance**:
  1. `ACI_TOOLSET_NAMES` 长度 23、末两位 `skill` / `skill_search`；Gate 3 装配校验通过（SC1）
  2. `skill_search({query})`：大小写不敏感子串匹配 name/description，每行 `{name, description}` JSON，检索源不含 disabled（SC3/SC5）
  3. `skill({name})`：直呼名返回正文；叫错名返回引导回检索文本；两件均 read-only / lazy:false / timeoutTier:fast
  4. `npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T6. `[implementation]` skill 正文装配 + `<available_skills>` 加性段 `[blocks: T2, T5]`

- **Affects**: `src/harness/skill/body.ts`（新）、`src/harness/identity/assemble.ts`、`tests/skill/body.test.ts`（新）、`tests/harness/identity-assemble-skills.test.ts`（新）
- **Acceptance**:
  1. 正文 = frontmatter 剥离 + `Base directory` 行 + `<skill_files>`（glob `**/*` 排除 SKILL.md、排序、采样 ≤10、绝对路径、sampled 提示）；references/ 不递归（SC6）
  2. `<available_skills>` 为加性段（LOCKED 循环后追加，`IKNOW_ASSEMBLY_ORDER` 未触碰——单测断言数组引用不变）；名字序渲染；空清单显式语句；disabled 不出现（SC3/SC4 形态）
  3. 段文本跨 turn 字节稳定（同输入二次调用字符串相等，KV 缓存契约）；`npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T7. `[implementation]` MCP manager + 生命周期 + 并发 + registerExternal 接线 `[blocks: D1, T1, T3, T4]`

- **Affects**: `src/harness/mcp/manager.ts`（新）、`tests/mcp/manager.test.ts`（新）、（D1 判 fail 时追加 `src/harness/mcp/schema-normalize.ts`）
- **Acceptance**:
  1. 状态机 pending/connected/failed/disabled；connect+listTools 后台化：`start()` 返回先于慢 connect 完成（慢 stub 单测，SC8 形态）；注册 30s 超时 → failed + warn，不阻塞其余 server（SC9）
  2. connected → `registerExternal` 追加，tool_search discover 可见；list_changed 回调经同通道重注册且不打断在途 callTool、不重复注册同名（SC15）
  3. `shutdown()` = client.close + stdio 子孙 SIGTERM（子进程 fixture 断言信号，SC11）；shutdown 与在途调用并发 → 明确取消语义不悬挂（SC16）；onclose → failed 不重连
  4. `npm test` 全绿（stub client，无真 server）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T9. `[implementation]` seed 迁移（资源 commit）`[blocks: T2]`

- **Affects**: `git mv .claude/skills/* → .iknow/skills/*`（现有 5 件）、`.iknow/skills/{systematic-debugging,verification-before-completion,test-driven-development,session-handoff}/`（自 arthurpower 插件复制 4 件种子）
- **Acceptance**:
  1. `.claude/skills/` 不存在；`.iknow/skills/` 含 9 个 `<dir>/SKILL.md`；session-handoff frontmatter 含 `disable-model-invocation: true`
  2. T2 扫描器对迁移后目录单测/冒烟：索引 9 件、disabled 1 件（session-handoff）
  3. `npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T8. `[implementation]` build-engine 装配 + 四入口条件化 + shutdown 接线 `[blocks: T5, T6, T7]`

- **Affects**: `src/harness/build-engine.ts`、`src/cli/runtime.ts`（shutdown 钩子）、`tests/build-engine.test.ts`（扩）
- **Acceptance**:
  1. chat/serve/TUI surface：skill 两件 + MCP manager 在场；ask surface：skill 两件在场、manager 未创建、registry/executor/catalog 三方视图零 `mcp__*`（SC12）
  2. `buildHarnessEngine` 返回不因慢 MCP server 阻塞（慢 connect stub 计时断言，SC8）；`BuiltEngine` 透出 shutdown 句柄且 RuntimeBundle 生命周期钩子调用它
  3. `npm test` + `npm run typecheck` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T10. `[implementation]` 集成链：fixture stdio MCP server + discover→执行 `[blocks: T7]`

- **Affects**: `tests/fixtures/mcp-server/`（新，最小 stdio MCP server 数件工具）、`tests/integration/mcp-chain.test.ts`（新）
- **Acceptance**:
  1. 真子进程链路：connect+listTools → registerExternal → `tool_search` discover → `mcp__*` 调用执行，每步真实结果断言；list_changed 触发热更新可见
  2. Gate 2 防撞：注册与静态工具冲突名 → 装配期抛（反例断言）
  3. `npm test` 全绿（无 LLM、无外部 server）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T11. `[implementation]` E2E A 验收：stub-model 脚本化全链路 `[blocks: T8, T9, T10]`

- **Affects**: `tests/fixtures/skills/echo/SKILL.md`（新）、`tests/e2e/skill-mcp-acceptance.test.ts`（新）
- **Acceptance**:
  1. stub-model 固定脚本 `skill_search → skill({echo}) → tool_search → mcp__codebase_memory__<工具>`，逐步断言真实结果（SC13）
  2. `<available_skills>` 段含 3 个可调用种子 skill、session-handoff 隐形（SC3/SC4）
  3. codebase-memory-mcp 缺席 → 显式 skip + Not run 记录（spec 假设 14 格式），其余子断言照跑
  4. `npm test` + `npm run typecheck` exit 0（SC14）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## Commit 纪律（spec 假设 15）

- 每 bullet ≤1 commit、独立票分支；12 bullets = 12 commits（自然满足 ≥4 逻辑分组：①T1 动态缝 ②T2/T5/T6/T9 skill 源 ③T3/T4/T7/T10 MCP ④T8/T11 装配与验收）
- E2E B（真实 LLM 冒烟）不入本 plan 自动化：待 operator 提供测试 key 后手工执行（spec OQ3），冒烟清单随 T11 票附录
