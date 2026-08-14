# Plan: #228 记忆注入着陆 — 5 层 commit 落地

> 实施 spec: `specs/228-memory-injection-landing.md`（ACR Round 2 PASS 5/5）
> base: `master` HEAD `8ac3628`
> 实施分支: `worktree-wayfinder-228-domain-modeling-landing`（独立 worktree）
> 5 commit 单元 = docs / memory 模块 / 工具注册 / 接线 / 测试

## 编译耦合关系（分解的依据）

```
layer 1 (docs)                              ─┐
                                              ↓
layer 2 (src/harness/memory/)                ─┐
                                              ↓
layer 3 (aci/tools/registry + 2 tool files) ←┘
                                              ↓
layer 4 (assemble.ts + build-engine.ts + cli.ts + cli/runtime.ts + tui/deps.ts ←─ ACR 缺口补)
                                              ↓
layer 5 (tests/harness/memory/* + tests/harness/build-engine.test.ts + tests/harness/identity/* + tests/session-api/ensure-deps-aci-tools.test.ts + tests/harness/build-message-params.test.ts + .evals/tasks/016-*.yaml + CHANGELOG.md)
```

各 layer 严格单向编译耦合：1 → 2 → 3 → 4 → 5。

## Tracer bullet

风险最高的 layer 是 4（接线：5 个冲突文件，其中 build-engine 5 冲突块 / cli 2 块）。Tracer 流程：

1. 先在 worktree 内做一次性"全量装配"：把 layer 2/3/4 的代码落盘到 staging（不 commit），用 `tsc --noEmit + vitest run tests/harness/memory` 验证端到端编译与 memory 域测试绿 → 这是 tracer bullet 击穿 seam 的证据。
2. 然后拆 commit，按 layer 顺序逐 commit 提交（每个 commit 独立绿）。

## 实施层决策（来自侦察）

### Dropped diffs（master 已有 / spec ACR 取消的误判）

- `src/harness/loop-engine.ts` **不动**（master 023 raceModel 重构已包含 `deps.system?.()` + `RaceModelOpts.systemText`；ACR §15 "保 master 形态，无新增 system 逻辑"）。
- `src/harness/model-adapter/anthropic-adapter.ts` **不动**（master 已含 `system !== undefined && system !== ""` 条件 spread）。
- `src/session-api/hub.ts` **不动**（#194 加 `memory:{enabled:true}` 冗余：master 默认 surface="serve" 通过 ensureDeps 装配；ACR §196 边界"不动 session-api 装配层"）。
- `CHANGELOG.md` 留在 layer 5 commit（landing CHANGELOG 条目）。

### ACR 缺口补（Round 1 → Round 2 修补后再增的）

- `src/tui/deps.ts` 增 ~3 行：`createIknowSystemResolver` 调用补 `memoryEnabled` + `memoryResolver`（surface split "tui = memory-on"）；不破坏现有 tui 形态。归入 layer 4。

### 测试基线维护（layer 3 + layer 4 内的最小改动以保 commit 绿）

- `src/harness/aci/tools/registry.ts` 的 `ACI_TOOLSET_NAMES` SSOT（行 44-53）8→10（memory_recall + memory_save append，order append-only）。
- `tests/harness/aci/tools/registry.test.ts` 标题 "8 工具" → "10 工具"（断言已用 SSOT 引用，length 自动跟）。
- `tests/harness/build-engine.test.ts`：import `ACI_TOOLSET_NAMES` 替 `EXPECTED_TOOLS`，标题"8-tool" → "10-tool"。**layer 4 内同步改**（不然 registry 默认 10 会破 expect.toEqual）。
- `tests/session-api/ensure-deps-aci-tools.test.ts`：`EXPECTED_TOOLS` 扩 2 项（同 #194 模式）。**layer 4 内同步改**。
- `tests/tui/deps-tools.test.ts`：若断言工具 length = 8 → 同步扩 10；待 layer 3 后 spot-check。**layer 4 内同步改**。
- `tests/harness/identity/system-injection.test.ts`：line 105-112 的"5 段 absent" it 的语义过时（#121 已落地，`memory_layer` slot 是 5 段折叠）。layer 4 落地后目录/tmp 下无 AGENTS/memory 文件 → slot 仍返回 undefined → 5 段 absent 断言**继续绿**；layer 5 再改写。

### 新增 D3/D4/降级测试（layer 5）

- `tests/harness/build-engine.test.ts`：加 describe `memory opt-out (ask path, SC 12)` 2 it（D3 + D4）— 复刻 #194 T6 的写法。
- `tests/harness/identity/system-injection.test.ts` 末尾追加 2 it（chat/tui/serve = system 挂载 + memory_layer 装配；ask = system 挂载但 memory_layer 不装配）。
- 新增 `tests/harness/identity/assemble.test.ts`（master 上不存在）：SC16 的 seam 降级 3 用例。
- `tests/harness/build-message-params.test.ts`：master 不存在，byte-faithful 搬（#194 新增 98 行 5 例 system 字段）。

## Layer 拆解

### Layer 1 — docs commit（1 commit）

`docs(memory): ADR-0009 + ADR-0010 + CONTEXT.md 4 词条 + specs/228 + specs/196 改写`

**步骤**：

1. `git checkout worktree-wayfinder-228-domain-modeling -- docs/adr/0009-memory-file-layered-injection.md docs/adr/0010-memory-injection-landing-seam-integration.md docs/CONTEXT.md specs/228-memory-injection-landing.md`
2. 改写 `specs/196-identity-assembly.md`：
   - 行 30-40 IKNOW_ASSEMBLY_ORDER ts 注释块：`9 段` → `5 段`（identity/soul/user_profile/bootstrap/memory_layer）
   - 行 122-132 "9 段 LOCKED" 散文段：改写为"5 段 LOCKED + memory_layer 单 slot"
3. 验证：`git status` 只列 4 个 docs 文件 + 1 个 specs/196；`tsc -p tsconfig.json --noEmit` exit 0；`vitest run` 全绿（docs 不影响 src）。

**Commit message（Conventional Commits）**：`docs(memory): ADR-0009 + ADR-0010 + CONTEXT.md 4 词条 + specs/228 spec + specs/196 5 段改写 (#228)`

### Layer 2 — memory 模块 commit（1 commit）

`feat(harness): src/harness/memory/ 12 文件移植 (#194)`

**步骤**：

1. 整目录搬：`git checkout worktree-wayfinder-121-memory-injection -- src/harness/memory/`
2. 检查 frontmatter.ts 的 git binary 标记 → `git cat-file blob <blob> > src/harness/memory/frontmatter.ts`（保险）。
3. 核对 12 个文件齐全（paths.ts / schema.ts / frontmatter.ts / errors.ts / index.ts / discovery.ts / bm25.ts / promote.ts / assembly.ts / refresh.ts / tools/recall.ts / tools/save.ts）。
4. 验证：`tsc -p tsconfig.json --noEmit` exit 0（无 type 错误即模块可独立编译）；`vitest run` 全绿（无测试依赖，hits 不变）。

**Commit message**：`feat(harness): src/harness/memory/ 12 文件移植 (#194 T2+T3+T4+T5)`

### Layer 3 — 工具注册 commit（1 commit）

`feat(harness): createDefaultAciRegistry 8→10 — memory_recall + memory_save append`

**步骤**：

1. 在 src/harness/aci/tools/ 下加 2 个 wrapper 文件：
   - `src/harness/aci/tools/memory-recall.ts`：re-export layer 2 `createMemoryRecallTool`，构造 ACI 工具。
   - `src/harness/aci/tools/memory-save.ts`：同上。
   - 内容：薄壳 import layer 2 的工具定义 + 重导出；ACI 注册 API 形态对齐 master 的 `createBashTool` 等。
2. `src/harness/aci/tools/registry.ts`：
   - `ACI_TOOLSET_NAMES` append `memory_recall`, `memory_save`（行 44-53，order append-only）
   - `CreateDefaultAciRegistryOptions` 加 `readonly memoryDir?: string`
   - `createDefaultAciRegistry` 函数体内按 `opts.memoryDir` 条件 append memory 工具
3. 验证：`tsc --noEmit` exit 0；`vitest run tests/harness/aci/tools/registry.test.ts` 通过（标题文字"8 工具"→"10 工具"，数组断言跟随 SSOT 自动；layer 4 后 build-engine.test / ensure-deps-aci-tools.test 才同步改）。
4. 暂不调 build-engine / tui/deps → 工具未上线到 CLI/TUI（后续 layer 4 接通）。

**Commit message**：`feat(harness): ACI registry 8→10 — memory_recall + memory_save append (#194 T5 → T6 half)`

### Layer 4 — 接线 commit（1 commit，**tracer bullet 风险点**）

`feat(harness): memory_layer slot 收敛到 5 段 — assemble + build-engine + cli + tui/deps 接线`

**步骤**：

1. **`src/harness/identity/assemble.ts`**：
   - `AssemblyContext`（行 46-50）增 `readonly memoryEnabled: boolean` + `readonly memoryResolver?: () => Promise<string | undefined>` 字段。
   - `IKNOW_ASSEMBLY_ORDER` 改 5 段：`["identity", "soul", "user_profile", "bootstrap", "memory_layer"]`。
   - `resolveSegment`（行 91-115）switch：删 5 个 #121 预留 case（`user_agents / priority_dec / project_agents / existence_pointer / promote`），合并成 1 个 `memory_layer`：
     ```ts
     case "memory_layer": {
       if (!ctx.memoryEnabled) return undefined;
       if (!ctx.memoryResolver) return undefined;
       try {
         return await ctx.memoryResolver();
       } catch (err) {
         console.warn(`[identity/assemble] memory_layer resolver failed: ${err}`);
         return undefined;
       }
     }
     ```
   - `createIknowSystemResolver`（行 62-74）签名增 `memoryEnabled: boolean` + `memoryResolver?: () => Promise<string | undefined>`，透传到 ctx。

2. **`src/harness/build-engine.ts`**：
   - `BuildEngineOpts`（行 35-42）增 `readonly memory?: { readonly enabled: boolean }`（默认 true）。
   - 函数体内 `const memoryEnabled = opts.memory?.enabled !== false;` + `const memoryDir = resolveProjectMemoryDir(process.cwd());`。
   - `createDefaultAciRegistry` 调用传 `memoryDir`。
   - registry 工具过滤：`const filteredTools = memoryEnabled ? reg.inner : reg.inner.filter(t => t.name !== "memory_recall" && t.name !== "memory_save");`
   - `deps.system`：`memoryEnabled ? createIknowSystemResolver({ cwd, userHome, surface, memoryEnabled: true, memoryResolver: createSystemResolver({ cwd, userHome, memoryDir }) }) : createIknowSystemResolver({ cwd, userHome, surface, memoryEnabled: false })`
   - 关键：ask 仍挂 system（走 identity 4 段），只是 `memoryEnabled: false` 让 memory_layer 不装配。

3. **`src/cli.ts`**：
   - ask 分支：`buildHarnessEngine(bundle, { askUser: createFailClosedAskUser(), surface: "ask", memory: { enabled: false } })`
   - chat 分支：`memory: { enabled: true }` 显式传
   - serve 不在 cli.ts，不动

4. **`src/cli/runtime.ts`**：
   - `buildHarnessEngine` 签名增 `memory?: ...` 字段，透传 `...(opts.memory ? { memory: opts.memory } : {})`

5. **`src/tui/deps.ts`（ACR 缺口补）**：
   - `system` 调用：`createIknowSystemResolver({ cwd, userHome, surface: "tui", memoryEnabled: true, memoryResolver: createSystemResolver({ cwd, userHome, memoryDir }) })`

6. **`src/harness/loop-engine.ts`**：**不动**（master 形态保留）。

**Baseline 维护（layer 4 必动，保 commit 绿）**：

- `tests/harness/build-engine.test.ts`：import `ACI_TOOLSET_NAMES`，改 `EXPECTED_TOOLS = [...ACI_TOOLSET_NAMES]`，更新 it 标题"8-tool" → "10-tool"。
- `tests/session-api/ensure-deps-aci-tools.test.ts`：`EXPECTED_TOOLS` 扩 2 项（同 #194 模式），标题"ACI 8-tool" → "ACI 10-tool"。
- `tests/harness/aci/tools/registry.test.ts`：标题"8 工具" → "10 工具"。
- `tests/tui/deps-tools.test.ts`：若断言 length=8 同步扩 10（spot-check）。

**Tracer 验证**：落地后跑 `tsc --noEmit` + `vitest run tests/harness/identity/system-injection.test.ts tests/harness/build-engine.test.ts tests/session-api/ensure-deps-aci-tools.test.ts` 全绿。

**Commit message**：`feat(harness): memory_layer slot 收敛到 5 段 — assemble + build-engine + cli + tui/deps 接线 (#194 T6)`

### Layer 5 — 测试 commit（1 commit）

`test(harness): memory 域 11 文件 + 接缝层 D3/D4/降级契约 + evals 016 + CHANGELOG`

**步骤**：

1. **tests/harness/memory/** 11 文件 byte-faithful 搬：

   ```
   git checkout worktree-wayfinder-121-memory-injection -- tests/harness/memory/
   ```

   （spec 文本提 12 文件，实测 11：assembly/bm25/discovery/frontmatter/paths/promote/refresh/schema/tools-recall/tools-save/integration）
   - frontmatter binary 同 layer 2 处理。

2. **tests/harness/build-engine.test.ts** 加 memory opt-out describe（#194 T6 byte-faithful 移植）：
   - 引入 BASE_TOOLS / EXPECTED_TOOLS / ASK_TOOLS 三段
   - 加 `describe("buildHarnessEngine — memory opt-out (ask path, SC 12)")` + 2 it：
     - `memory disabled → registry stays at 8 + deps.system undefined`
     - `memory enabled (default) → deps.system is wired as async assembler`

3. **tests/session-api/ensure-deps-aci-tools.test.ts** 已是 layer 4 baseline 完状态；layer 5 仅在 doc-block 注释里把"10-tool registry"说完整（与 layer 4 重叠时以 layer 5 为最终态）。

4. **tests/harness/identity/system-injection.test.ts**：
   - it L105-112 改写为"memory_layer slot 在 chat/tui 装配（不泄漏 raw 段名）"
   - 末尾追加 2 it：
     - `chat/tui/serve: deps.system wired, memory_layer 段在装配（无 AGENTS/memory 文件时为空）`
     - `ask: deps.system wired, memoryEnabled=false → memory_layer 段不装配`

5. **新增 `tests/harness/identity/assemble.test.ts`**（master 上不存在）：
   - it 1：`memory_layer slot: ctx.memoryEnabled=false → 返回 undefined`
   - it 2：`memory_layer slot: ctx.memoryEnabled=true, resolver throws → console.warn 触发 + 返回 undefined（no rethrow）`
   - it 3：`memory_layer slot: ctx.memoryEnabled=true, resolver undefined → 返回 undefined`
   - 用 `vi.spyOn(console, "warn")` 验证 warn 触发。

6. **tests/harness/build-message-params.test.ts**（master 不存在）：byte-faithful 搬（#194 新增 98 行 5 例 system 字段：undefined / "" / actual prompt / 与 tools 并存 / 重复）。

7. **.evals/tasks/016-memory-injection.yaml** byte-faithful 搬。

8. **CHANGELOG.md** 加 1 条：
   ```
   ## feat(harness): #121 记忆文件分层注入 v0 着陆（#228 / ADR-0010 D1-D6）
   ```

**Commit message**：`test(harness): memory 域 + 接缝层测试 + evals 016 + CHANGELOG (#194 T7+T8 + SC16)`

## 验证 gate（每个 layer commit 后）

```bash
cd /home/winner/projects/iknow/.claude/worktrees/wayfinder-228-landing
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Tracer bullet（layer 4 后）：手工 e2e 验证 seam —— 创建临时 HOME + 临时 cwd，chat surface 调用 deps.system() 看 memory_layer 是否装配；ask surface 看是否不装配（仍保留 identity/soul/user_profile）。

## Sub-agent 分配（按编译耦合）

| 子代理              | 任务                                     | 编译前置          |
| ------------------- | ---------------------------------------- | ----------------- |
| Implementer A (TDD) | Layer 1 docs commit                      | 无                |
| Implementer B (TDD) | Layer 2 memory module commit             | 无（与 A 并行）   |
| Implementer C (TDD) | Layer 3 registry commit                  | layer 2（B 完成） |
| Implementer D (TDD) | Layer 4 wiring commit（tracer）          | layer 3（C 完成） |
| Implementer E (TDD) | Layer 5 tests + evals + CHANGELOG commit | layer 4（D 完成） |

并行策略：A ∥ B → C → D → E。每个 implementer 在 `wayfinder-228-landing` worktree 内 commit。

## 最终交付

- 5 个 commit 落在 `worktree-wayfinder-228-domain-modeling-landing` 分支
- `git push -u origin worktree-wayfinder-228-domain-modeling-landing`
- `gh pr create --base master --draft --title "feat(harness): #121 记忆文件分层注入 v0 着陆（#228 / ADR-0010 D1-D6）"`
- `gh pr close 194 --comment "Superseded by #<NNN>"`
- SC1-SC17 验证 + arthurpower:code-review 双轴

## 风险

- tui/deps.ts 不在 spec Project Structure → 层 4 补加（ACR Round 2 类缺口修复）。
- CHANGELOG.md 不在 spec Project Structure → 层 5 加（项目惯例 + 根真值）。
- .evals/tasks/016.yaml 不在 spec Project Structure → 层 5 加（SC3 必需）。
- build-message-params.test.ts 不在 spec Project Structure → 层 5 加（master 不存在此测试，但 #194 提供 byte-faithful）。
- layer 4 必须同步做 baseline 测试维护（EXPECTED_TOOLS 扩 2 项），否则 commit 红。spec Testing Strategy 的"layer 5 incremental rewrite"特指 D3/D4/降级语义增量，baseline 维护属于 layer 4 的硬绿条件。
