# 2026-07-31 — kb_* 4-tool 归档 (023)

## 改了什么

- 4 个 kb_* 业务工具（`kb_retrieve` / `kb_verify_citation` / `kb_compile` / `kb_governance`）
  + 装配 facade `src/tools/registry.ts` 移到 `docs/archive/023-retire-kb-tools/`
- `src/index.ts` 删 13 行 export
- `src/shared/schema.ts` 重写：删 `Kb*Input/Output` / `Chunk` / `PriorChunk` /
  `SourceSpan` / `CompiledFact` / `SnapshotPayload` / `RRF_K` 等（~120 行），
  保留 `CallerRole` / `SessionContext` / `isCallerRole` / `parseCallerRole` /
  `CALLER_ROLES`
- `src/runtime/create-runtime.ts` 重写：删 embedding / vector-index 路径，
  简化为 `store + env`
- `src/cli/runtime.ts`：`RuntimeBundle` 删 `vectorIndex` 字段；`prepareRuntime`
  删解构与返回中的 `vectorIndex`
- `src/knowledge-store/types.ts` 注释去 `Chunk/CompiledFact` 字样
- 删 4 个 test 文件（`tests/{verify,compile,rrf,embedding}.test.ts`）
- 文档留痕：`docs/STATUS.md` §1.2 / §1.3 / §4 + `docs/architecture.md` Capability
  modules 表 + ASCII 架构图 + `README.md` layout 表 + `CHANGELOG.md` 0.1.0
  Breaking 段 + `docs/archive/023-retire-kb-tools/README.md`

## 实际运行的验证及结果

| 验证 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npx vitest run tests/harness/ tests/harness/aci/ tests/standalone.test.ts tests/cli-session.test.ts` | **18 files / 250 tests 全绿** (227 + cli-session 23) |
| `git diff --stat` | 移动 14 个文件 + 删 4 个 test + 改 5 个 src + 改 4 个 docs + 1 个新 README |
| 4-tool 协议文件 `src/harness/tools/types.ts` | git diff 为空（冻结协议不动） |

## 编排决策（写在留痕里，避免后续误解）

### 1. 保留为孤儿，待后续清理（不在 023 授权范围）

- `SessionContext.simulate_governance_timeout`：0 消费者（kb_* 归档后）。
- `--governance-timeout` CLI flag + `prepareRuntime.degrade` 入参：同上。
- `--embeddings` CLI flag：runtime 不再构建 vector index，flag 保留为表面兼容（runtime 内 no-op）。
- `src/fixtures/seed-kb.ts::seedDemoKnowledge`：仅被 `src/index.ts` re-export，无测试/活代码直接 import。

→ 这些是"彻底清掉"的产物，但用户授权范围是"归档 4 个 kb_* 工具"，删 CLI flag
  超范围。**保守做法**：保留 + 留痕（CHANGELOG.md + 023 README + 本 handoff），
  后续单独 cleanup commit 处理。

### 2. 文档权限边界

- `docs/CONTEXT.md` 第 148-151 行"4-tool 词条"段：被 `pre-context-write-guard`
  拦截（写权限属于 `domain-modeling` skill / ADR-0005）。**本次未动**。
  概念词条仍为协议真值（GraphRAG backend memory vocabulary），代码归档已在
  STATUS / README / CHANGELOG / archive README 充分留痕。
- `specs/` 与 `plans/` —— 协议和历史规划留痕，不动。
- `docs/iknow-spec/` —— 协议真值链（`HANDOFF` → `ADR-v0.1` → `tool-schema` →
  `mapping` → eval），不动。

### 3. 编译耦合拆解

- 1 个 logical task（"归档 4 个 kb_* 工具"）= 1 个 commit，包含 14+ 文件
  协调改动（移动 + 修剪 + 删 test）。原因：剪引用 + 移动文件 + 删 test 必须
  同原子，否则中间态 typecheck 挂。
- 文档留痕并入同 commit（避免代码 commit 1 + 文档 commit 2 两次 review），
  符合"1 logical task"语义。

### 4. 接线方向（task #14 起）

- 把 `src/harness/aci/` 5 个工具（`fs_search` / `fs_view` / `fs_edit` /
  `shell_exec` / `context_manager`）通过 `createAciRegistry` +
  `createAciExecutor` 装饰层接到 `src/cli/runtime.ts::buildHarnessEngine`，
  替换当前的 `createEchoTool + createGetTimeTool`（demo 工具）。
- 这与 023 归档是独立的 logical task，等用户单独指令。

## 未验证

- `npm test` 全量：含 `tests/session-api/serve.test.ts` 端口 8787 冲突（环境
  问题，与归档无关，handoff 不再追）。隔离跑已覆盖 18 files / 250 tests 全绿。
- `_evals/` 评估套件：未跑（021 已归档，本归档不影响 eval 套件）。
- `graphrag-memory/` 子项目：独立 backend，未跑（不受本归档影响）。

## 风险

- **孤儿字段 `simulate_governance_timeout` / `--embeddings` flag**：用户若
  跑 `chat --mode deterministic --governance-timeout` 会通过 CLI 解析，但
  runtime 内部 no-op（写入 SessionContext 但 kb_retrieve / kb_governance 已
  归档不读）。**无功能性错误**（不会抛错），但参数失效。后续 cleanup commit
  删除。
- **CONTEXT.md 4-tool 词条**：概念语义仍有效（GraphRAG backend memory
  vocabulary），代码已归档。若有人读 CONTEXT.md 找 kb_* 实现，需顺手看
  archive README。在 handoff / 023 README 指引了 resurrection path。
