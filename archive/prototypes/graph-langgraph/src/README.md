# graph-langgraph-prototypes —— langgraph 流程编排原型（throwaway prototype. NOT production. NOT in lockfile.）

> **throwaway prototype. NOT production. NOT in lockfile.**
> 加法式装饰层，不碰冻结的 `src/harness/index.ts` 与 4-tool 协议，
> 不接产品流量，不 import `src/tools/`。验证通过的决策可折入真代码，
> 本体留档后删除。约定源：`docs/drafts/aci-prototype-contract.md`。

> 这是 PR #110 的 v2 在另一个 worktree 的二次"重宿主"——目的是把
> `@langchain/langgraph@^1.4.9` 流程编排原型搬到 `worktree-graph-vs-langgraph-prototype`
> 这个 base（master `69c07edf`）上端到端跑通，作为给 issue #549（T-V2-R3）的
> 反馈证据。原版 commit `03105cb3`（worktree `worktree-graph-langgraph-prototypes`）。
> 之所以重宿主而不是直接引用原 worktree：见 #549 中"原型代码 Aug 12 已存在
> 但 #549 Aug 19 关闭时未引用"的隐式时序问题。

## 本机目录名澄清

本目录（原 `graph-langgraph-prototypes`）已迁到 `archive/prototypes/graph-langgraph/`——
既符合既有 `archive/tests-real-llm/` 的隔离模式（`archive/**` 已
自然排除于 `tsconfig.json` + `vitest.config.ts`），又让 `npm test` / `npm run typecheck`
默认不会跨入 throwaway 区域，避免 clean clone 上锁文件无 `@langchain/*` 还能跑通的 hidden bool 假设。

## 安装（必须 --no-save，因为 LangGraph 不进 lockfile）

```bash
npm install --no-save @langchain/core@^1.2.5 @langchain/langgraph@^1.4.9
```

`@langchain/langgraph` **不会**出现在 `package.json` 或 `package-lock.json` 中。
这是 by design——保护主仓 lockfile 不被抛瓦原型污染。

## 跑通 demo

```bash
cd archive/prototypes/graph-langgraph/src && npx tsx demo.ts
```

会依次跑两条 pipeline（今日 AI 新闻 digest + 研究-写作 supervisor），
逐节点打印 state 增量。

## 跑 vitest e2e（archive 隔离，需显式 override）

主仓 `vitest.config.ts` 已 exclude `archive/**`，故默认 `npm test` / `npm run test:changed`
不会跑本目录的 e2e——这是隔离保护的一部分，让 clean clone 不必先 `npm install --no-save`
就能跑通基线。

要验证本原型 e2e，复制主仓 vitest 配置 + 改 include：

```bash
# 一次性 helper（写到 /tmp，不入主仓）
cat > /tmp/langgraph-vitest.config.ts <<'CFG'
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["archive/prototypes/graph-langgraph/tests/**/*.test.ts"],
    pool: "forks",
    poolOptions: { forks: { maxForks: 3, minForks: 1 } },
    exclude: ["**/node_modules/**"],
  },
});
CFG
npx vitest run --config /tmp/langgraph-vitest.config.ts
```

或直接跑脚本验证两个 pipeline（不需要 vitest）：

```bash
npx tsx demo.ts
```

原版 6/6 green，本 worktree 同样应当 6/6 green。

## 验证历史（原版）

- 原 commit：`03105cb3 feat(harness): langgraph 流程编排原型 v2`（worktree `worktree-graph-langgraph-prototypes`）
- 6/6 e2e green
- 2086/2086 全量零回归
- typecheck 0 错误

## 被验证的问题

| 问题                               | v1（PR #110 手写）     | v2（langgraph 内建）              | 结论             |
| ---------------------------------- | ---------------------- | --------------------------------- | ---------------- |
| 带依赖任务能否被调度、结果沿边流动 | `topo.ts`（Kahn 分层） | `StateGraph` 自带拓扑执行         | ✔ langgraph 原生 |
| 并行 fan-out                       | 手写 wave 调度器       | `Send` + append reducer           | ✔ 原生           |
| 条件分支 / 写后评审回环            | 手写 `skillCheckGate`  | `addConditionalEdges` + `Command` | ✔ 原生           |
| 子任务只派发一次、前景同步汇聚     | 手写 drain 队列        | `sent` 标记 + reducer 汇聚        | ✔ 原生           |

**结论：langgraph 完全满足 iknow 的 graph 流程概念，无需自写。** v1 里所有自研
原语（topo/scheduler/skillCheckGate）在 langgraph 里都是内建能力，且表达更简。

## 两个原型

### Proto A：今日 AI 新闻 digest（多节点 pipeline）

节点链：`fetch_feeds → filter_articles → summarize_articles(并行 Send) → rank_articles → compose_digest → editor_review`

- **并行 fan-out**：`filter_articles` 后 `addConditionalEdges` path 返回 `Send[]`，
  每条文章并行跑 `summarize_articles`，结果用 **append reducer** 汇聚
  （LastValue 覆盖会只留一条——原型实测的关键陷阱）。
- **条件回环**：`editor_review` 发现 digest 缺条目 → `Command({ goto: "rank_articles" })`
  回环重跑，`editorRevision` 用 lastValue reducer 累加，上限 3 次强接受。
- 代码：`news-digest/graph.ts`（节点）、`news-digest/logic.ts`（纯函数）。

### Proto B：研究-写作 supervisor（条件分支 + 写后评审）

节点链：`supervisor → research(并行 Send) → gather → writer → critic → [rewrite|finalize]`

- **supervisor 只派发一次**：用 `sent` 标记（由"是否已汇聚"派生）挡住回环重复派发。
- **foreground-sync（ADR-0014）**：writer 必须拿到全部研究结论才开工——`Send` fan-out
  - append reducer 让"派发 → 并行执行 → 汇聚"成为原生表达，无需手写 drain 队列。
- **写后评审回环**：`critic` 判 revise → 条件边回 `writer`，`revisionCount` 有上限（2 次）。
- 代码：`research-writer/graph.ts`（节点）、`research-writer/logic.ts`（纯函数）。

## langgraph 1.x 实测心得（踩坑记录）

1. **并行 fan-out 的汇点字段必须是 append reducer**：`Annotation<T[]>({ reducer: (l,r)=>[...(l??[]),...(r??[])] })`。LastValue 会互相覆盖。
2. **条件边 path 返回 Send[] 是标准派发**：节点返回普通对象，path 函数返回
   `Send[]`（`new Send("node", args)`），`Send` 自带目标，无需静态边。
3. **`Command` 用于节点内 goto/update 混合**：`new Command({ update, goto })`。
4. **gather 汇聚节点不能透传 state**：`(s)=>s` 会让 append reducer 二次累加
   （翻倍），应返回空对象 `{}`。
5. **`addEdge("sup","work")` 静态边 + `Command.goto` 会重复派发**（work 多收
   一次 sup 返回值），用 `Send` 隐式可达边替代。
6. **`@langchain/core/utils/testing` 有官方 `FakeListChatModel`**（本次未用，
   后续接真 LLM 节点时可用）。

## 可折入真代码的纯逻辑

`news-digest/logic.ts`（summarizeArticle / rankByRelevance / composeDigest /
reviewDigest）、`research-writer/logic.ts`（draftFromNotes / critiqueDraft /
routeAfterCritique）——均有直接 e2e 断言。`graph.ts` / `demo.ts` 是 throwaway 外壳。

## 给 issue #549 的反馈

详见 verification JSON 的 `open_questions_for_549` 字段——核心是时序：
langgraph 原型代码 Aug 12 commit `03105cb3` 早已存在，但 #549（T-V2-R3）Aug 19
关闭时没引用这个原型。"v2 完成"结论可能隐式采信了自写原型，未把 langgraph 原型
作为对照证据。请 #549 维护者澄清。
