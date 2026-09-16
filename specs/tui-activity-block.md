# Spec: tui-activity-block — TUI 过程块（思考与安静工具共用正文槽）

> 输入 = `plans/tui-activity-block.md`（ACR 5/5 yes；访谈锁句 8 条；本 worktree 随 plan persist flush 落 `docs/CONTEXT.md`）。
> 范围 = TUI 过程 chrome 按 assistant 消息切成**过程块**；纯派生模块产出块列表，ChatView 只消费；不改 Ctrl+O、不改 `thinkingMs` 落盘、不改 harness 工具形状、不改 web。
> 落地 = T1 本 spec → T3–T7 实施（TDD）→ code-review → verification-before-completion。

## Objective

把 TUI 里「一轮一次收敛」的过程 chrome 换成**按 assistant 消息切块**的时态模型：一条消息至多一块过程块，块内只有一行标题 + 一个正文槽，槽在「思考流」与「一行 dim 安静工具预览」之间交接；块按时间追加，中间正文把焊接切开。

**用户**：iknow 单用户单项目本机产品；TUI 是主验收面（`npm run dev:tui`）。

**要建什么**：

1. **纯派生模块**（无 React）：`messages + live runs → activity blocks`，块列表是唯一过程 chrome 事实源。
2. **消费面收敛**：ChatView 消费块列表；旧的双摘要器（live activity group 现在时行 与 unit fold 结束态行）不再对同一批 retract 同时作画。
3. **槽位交接**：思考仍在流 → 槽归思考；安静工具接手 → 槽归一行 dim 当前预览；安静工具全部结束 → 预览收掉、标题转 `called`。

**成功形态**：一次真实会话里，思考→安静工具→正文→安静工具的序列在屏上表现为「块标题逐段演化 + 槽位交接」，没有第二套现在时摘要行并行，没有整轮一行 stub。

## Locked sentences

八句锁句（本切片冻结合同；实施与 review 均以此为准）：

1. 一条 assistant 消息至多一块过程块；块按时间追加；禁止把整轮收成一行 stub。
2. 过程块 = 一行标题 + 一个正文槽；槽同一时刻只归思考流或一行 dim 工具预览。
3. 仅相邻的「思考 + 安静工具」（中间无正文 / keep / accent / 失败）才把时长与 calling/called 焊在同一标题。
4. 安静工具仍在跑 → 标题用 `calling`；该块安静工具都结束 → `called`，预览槽收掉。
5. 思考阶段结束的切点 = 该消息出现 `text_delta` 或 `tool_call_start`（与既有 `thinkingMs` 测量边界一致）；此后思考正文让出槽位，时长留在标题。
6. keep / accent / 失败仍是块外实卡；安静工具不刷独立标题。
7. 下一次思考只开新块；已 `called`（或已被正文切开）的块不再改计数。
8. Ctrl+O 本切片不做。

## Superseded

本合同取代以下三条现行行为（实施时须一并拆除，不留并行路径）：

| 被取代行为                                                | 现行落点                                         | 取代后                                                                  |
| --------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| 整轮 `unit fold` 焊计数                                   | `src/tui/turn-fold-lines.ts`                     | 块标题 = 该消息 `thinkingMs` 的 `Thought for …`，相邻才接 `called` 计数 |
| `live activity group` 与 `unit fold` 同时画同一批 retract | `src/tui/live-activity-group.ts`                 | 安静工具 live 只进过程块正文槽，settled 只进该块 `called` 计数          |
| 工具 running 即关思考 panel，且思考行仍可提前出现         | ChatView 互斥闸（`hideThinking` / 整轮 running） | `hideThinking` 只跟**过程块槽位主人**走；已冻 stub 不关下一块的思考槽   |

**不授权**（本切片明确排除）：Ctrl+O 展开、改 `thinkingMs` 落盘算法、改 keep / accent / 失败分类表、改 CLI 非 TUI 面、改 web。

## Tech Stack

| 项     | 取值                                                   | 备注                            |
| ------ | ------------------------------------------------------ | ------------------------------- |
| 语言   | TypeScript（与 harness 一致，5.x ESM）                 | —                               |
| 渲染   | `@opentui/react` 0.5.1                                 | 既有；本切片不加渲染依赖        |
| 测试   | vitest（纯派生）+ `$HOME/.bun/bin/bun test tests/tui/` | 既有双跑（`npm test`）          |
| 新依赖 | 无                                                     | 纯派生 + 消费面收敛，不引第三方 |

## Commands

```bash
npm test                                    # vitest 全套 + bun test tests/tui/
npm run typecheck                           # tsc --noEmit
npm run lint:s5                             # complexity 硬门（改动集）
npm run dev:tui                             # 真实 TUI（MCP pty 实测面）
```

## Project Structure

| 路径                                         | 形态    | 说明                                                           |
| -------------------------------------------- | ------- | -------------------------------------------------------------- |
| `src/tui/<activity-block 派生>.ts`           | **新**  | 纯派生：`messages + live runs → 块列表`（无 React、无 IO）     |
| `src/tui/turn-fold-lines.ts`                 | 改      | 块标题构造收敛到新合同（`Thought for` / `calling` / `called`） |
| `src/tui/live-activity-group.ts`             | 改      | 退役现在时摘要行；或收薄为槽预览取用                           |
| `src/tui/turn-activity.ts`                   | 改      | live 工具聚合改喂块列表                                        |
| `src/tui/chat-view.tsx`                      | 改      | 消费块列表；互斥闸改跟槽位主人                                 |
| `src/tui/message-blocks.tsx`                 | 改      | 行装配对齐块两态                                               |
| `src/tui/think-fold.ts` / `thinking-gate.ts` | 改/不动 | 思考折叠判定沿用；`hideThinking` 语义改接槽位主人              |
| `src/tui/tool-settled.ts`                    | 不动    | keep / accent / retract 分类表本切片不改                       |
| `tests/tui/*`                                | 改/新   | 旧双摘要器测试改钉新合同；新增派生夹具用例                     |

## Testing Strategy

| 等级 | 范围                                                                                                 | 工具                                     |
| ---- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Unit | 纯派生块列表：焊 / 切开 / 新消息新块 / `calling` vs `called` / 失败件不进块计数 / keep / accent 块外 | vitest                                   |
| Unit | 槽位交接：思考流→思考正文、安静工具接手→dim 预览、全结束→预览收掉                                    | vitest                                   |
| Unit | 互斥闸：同一批 retract 不同时出现现在时行与结束态行；已冻 stub 不关下一块思考槽                      | vitest                                   |
| Unit | 边界：无思考无工具 / 思考后无工具直接正文 / 思考后直接安静工具（无正文）/ 正文夹在思考与安静工具之间 | vitest                                   |
| TUI  | 真实会话：思考→安静工具→正文→安静工具 的屏上序列                                                     | `mcp__aiterm__pty_*` + `npm run dev:tui` |

**`npm test` = 唯一门**：交付门槛 = `npm test` 退出 0 + `npm run typecheck` 退出 0 + `npm run lint:s5` 退出 0。

## Boundaries

### Always

- 过程块是 TUI 显示面的派生：不改 harness 工具形状、不改 session transcript、不改 `thinkingMs` 落盘、不改 web。
- `docs/CONTEXT.md` 只经 `domain-modeling` 写入（`pre-context-write-guard` hook 守卫）；本 spec 引用词条，不重定义。
- 失败件（failure overlay）横切：不进过程块计数、不占 dim 预览槽。
- `thinkingMs` 仍 per-message；块时长 = 该条消息的 `thinkingMs`，不跨消息求和。

### Ask first

- 删除 `live-activity-group.ts` 文件本体（vs 收薄保留）——影响面超出显示面时先问。
- 旧测试的**归档**（vs 改钉新合同）——按 test.md「先评估认证目标」判据，命中「不变式已永久消失」才归档。

### Never

- 不做 Ctrl+O 展开（本切片）。
- 不改 keep / accent / 失败分类表。
- 不把失败吞成 `called`（静默降级）。
- 不加第二套摘要器（禁止第三套时态）。

## Success Criteria

| #   | Criterion                     | Check                                                                                 |
| --- | ----------------------------- | ------------------------------------------------------------------------------------- |
| S1  | 块列表纯派生可单测            | 无 React import 的派生模块导出块列表函数；vitest 直接调                               |
| S2  | 焊成立（思考 + 相邻安静工具） | 夹具：思考后直接安静工具 → 标题含 `Thought for` + `calling`                           |
| S3  | 切开成立（中间有正文）        | 夹具：思考→正文→安静工具 → `Thought for` / 正文 / `called name × N` 三段分离          |
| S4  | `calling` → `called` 转移     | 夹具：安静工具 running → 标题 `calling`；全结束 → `called` 且预览收掉                 |
| S5  | 新消息开新块                  | 夹具：两条 assistant → 两块；第二条不改第一块计数                                     |
| S6  | 失败件不进块计数              | 夹具：失败安静工具 → 块计数不含它；仍走 failure overlay                               |
| S7  | keep / accent 仍块外实卡      | 夹具：keep 工具 → 不焊进块标题；accent 同理                                           |
| S8  | 双摘要器不再叠画              | 夹具：同一批 retract 不同时产出「现在时行」与「结束态行」                             |
| S9  | 槽位交接：思考让位            | 夹具：思考流中出现 `text_delta` / `tool_call_start` → 思考正文离开槽位、时长留标题    |
| S10 | 边界四类覆盖                  | 夹具：无思考无工具 / 思考后直接正文 / 思考后直接安静工具 / 正文夹在思考与安静工具之间 |
| S11 | `hideThinking` 只跟槽位主人   | 夹具：已冻 stub 不影响下一块思考槽开合                                                |
| S12 | 主路径全绿                    | `npm test` 退出 0；`npm run typecheck` 退出 0；`npm run lint:s5` 退出 0               |
| S13 | 真实 TUI 实测                 | MCP pty 起 `npm run dev:tui`，注入 prompt，读屏验证过程块序列                         |

## Open Questions

本期不答（范围外，仅声明不静默）：

- **Ctrl+O 展开过程块**：本切片不做；触发时机 = 过程块时态稳定后（下一票）。
- **`live-activity-group.ts` 的去留形态**：文件删除 or 收薄为槽预览取用，实施时按依赖面决定（见 Boundaries Ask first）。
- **块与块的视觉间距 / 折叠符**：属设计细节，本切片只钉时态与文本合同。

## Glossary

> 来自 `docs/CONTEXT.md`（spec 引用，不重定义）。

- **activity block**：TUI 对齐一条 assistant 消息的过程 chrome——一行标题加一个 **body slot**，live 与 settled 两态。块按消息追加，不把整轮收成一行。
- **body slot**：过程块里唯一给正文的位置。思考仍在流时归思考；安静工具接手后归一行 dim `⎿` 当前预览。二者不同时占槽。
- **adjacent weld**：仅当思考与安静工具之间没有正文、keep、accent、失败时，标题才写成 `Thought for …, calling/called …`。
- **retract class（收 / 安静工具）**：不占脚印卡的工具类（读取 / 搜索 / 查询）。live 只进过程块正文槽；settled 只进该块 `called` 计数。
- **keep class / accent class / failure overlay**：分别为落定留标题的工作类、点名着色类、失败横切（三者本切片都不改）。
- **thinking duration**：assistant 消息的落盘属性 `thinkingMs`（adapter 流式路径测量）；过程块时长 = 该条消息的 `thinkingMs`，不跨消息求和。
- **unit fold / live activity group / open unit / live tool line**：本切片改写的词条（见 `docs/CONTEXT.md` 现行定义）。

## Architectural Constraints

| ADR / 规则                                | 引用形式                                            |
| ----------------------------------------- | --------------------------------------------------- |
| `.claude/rules/code-quality.md`（SSOT）   | 块列表单一权威来源；ChatView 只消费不重算           |
| `.claude/rules/test.md`（TUI 实测地面）   | 进会话的改动必须 `npm test` + MCP pty 真实 TUI 读屏 |
| S5 complexity 硬门（cyc ≤ 10 / nest ≤ 4） | 派生模块纯函数化，失败分类不膨胀；`lint:s5` 退出 0  |

## ACR Verdict（architecture-change-reviewer · 5-verdict gate）

> 来自 `plans/tui-activity-block.md`（该 plan 已含 ACR 段；此处照录）。

```text
bounded-context-guardian: yes — chrome 只留在 tui 显示面；不改 harness 工具形状、不改 session transcript / thinkingMs 落盘、不改 web。
input-contract-tests: yes — 无思考无工具；思考后无工具直接正文；思考后直接安静工具（无正文）；正文夹在思考与安静工具之间；失败安静工具走 failure overlay 不进 stub；下一条 assistant 新块（并发 live 与已冻 stub 并存）。
error-handling-enforcer: yes — failure overlay 横切不进过程块计数；派生拒绝画块时 `// EXIT:`；不把失败吞成 `called`。
complexity-anti-drift: yes — 一块两态由纯派生模块产出，ChatView 只消费；禁止再叠第三套摘要器；不把 Listing/Reading/Searching 与 Thought for 并行保留。
minimal-change-verifier: yes — 一任务 = 过程块时态；不改 Ctrl+O、不改 CLI 非 TUI 面、不改 TOOL_SETTLED_CLASS 的 keep/accent 名单（安静 = 现 retract）。
```

**Gate 结果：5/5 yes，hand to implementation。**

- affects: docs/CONTEXT.md
- affects: specs/tui-activity-block.md (新)
- affects: src/tui/<activity-block 派生>.ts (新)
- affects: src/tui/turn-fold-lines.ts
- affects: src/tui/live-activity-group.ts
- affects: src/tui/turn-activity.ts
- affects: src/tui/chat-view.tsx
- affects: src/tui/message-blocks.tsx
- affects: tests/tui/*
