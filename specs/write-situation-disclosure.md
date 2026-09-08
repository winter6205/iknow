# Spec: 写处境告知与建树失败出口

> 承接 PR #947（`specs/mutate-write-contract.md` / ADR-0068，Closes #946）的**后续面**。#947 修的是「模型伸手要写的那一刻，拒绝理由错不错」；本 spec 修的是「模型伸手**之前**告知真不真」与「伸手注定失败时**有没有出路**」。两者 Changes 不重叠（#947 落 `hard-walls.ts` / `helpers.ts` / `manager.ts`；本 spec 落 `skill/body.ts` / `worktree-gate.ts` / `worktree-rebind.ts` / `bash.ts`）。

## Glossary（exact copy from docs/CONTEXT.md）

- **taskRoot**（活值）: 会话当前生效的 task worktree 根——**写与工具 cwd 只问它**（写工具 / 会改工作区的 bash / git / LSP 目录 / 子代理工作目录）。……装配初值 = `SessionRoots.taskRoot`（未改绑时等于主仓）……改绑后模型经 worker prior messages / path-outside 回执看见当前写根；消费 skill 时（slash 信封 / `skill()` tool_result / Web `getSkillBody`）正文末尾带当前写根，文案与 worker prior 同一份（`specs/skill-load-write-root.md`）；改绑后主会话另给一次（用户消息缝，非每轮、不进 system）；system `## Project path` 仍是身份根（`projectIdentityRoot`）。
- **hard-wall**: spawn 前意图过滤器——拦围栏看不见或拦不住的命令意图（毁灭性 rm、命令替换、敏感路径、fork-bomb），不可被 session grant 覆盖。不是第二套沙箱；换行只作分段符。耐久写只问 `taskRoot`。ADR-0068。
- **闭世界围栏（closed-world fence）**: bash 围栏的默认姿态——deny-by-default:home 下非白名单不可见，可写集 = taskRoot + /tmp……OFF 档同样生效（全档位反转）。
- **session worktree rebind**: worktree isolation mode ON 下 `create-task-worktree`（或 enter / exit）ACI 工具成功后，把**当前会话**生效的根锚切到本会话 task worktree 的动作……**生效边界：同一轮（run）内对下一波 tool calls 生效**。
- **task worktree label**: 给人/模型认树的 kebab 目录名。有合法 label 时叶子就是 `<slug>`，conversationId 不进文件夹（写在 gitdir sidecar；历史 `<slug>--<conversationId>` 仍可反演）。非法或缺席则叶子仍是纯 conversationId。**同名已存在 → 建树失败不覆盖。**

（完整句以 `docs/CONTEXT.md` 为准，本 spec 不重定义。）

## Architectural Constraints

- **ADR-0068**：hard-wall 只做 spawn 前意图过滤；耐久 mutate 只落活 `taskRoot`；bash `/tmp` 是围栏 tmpfs 进程临时面，不是产品交付落点。
- **ADR-0037 §1 / §3 / §6**：门禁**从不** auto-provision；建树失败 fail-closed，typed、非空、可见；同名树/分支已存在不静默覆盖、不复用归属不明的树。
- **ADR-0037 §7.1 / §7.2**：活 `taskRoot` 唯一 writer = 装配层对 host `provision`/`enter`/`exit` 缝的包装点；一波一快照，波内逐 call 重读被禁。
- **ADR-0037 §9.2**：写白名单 = `taskRoot` + `/tmp`，**无第三者**。本 spec 不动围栏。
- **ADR-0037 T9 红线**：活写根**不进 system**、不进 `env_snapshot`。
- **ADR-0004**：bash 安全边界以 OS 沙箱为准；allowlist / 硬墙不得充当第二套沙箱。
- **ADR-0040**：子代理是父会话执行臂，继承父写根，不另开产物目录。
- **Amendment 2026-09-04 / `casual-ask-context-hygiene` SC7**：门禁回执**不按用户问句分型**。
- **`skill-load-write-root` 合同 1**：写根文案**只有一份**，worker 源内不得留第二份长句。
- **`docs/guides/prompt-development.md`**：说明书不是闸；能用代码 / schema / 轨迹判定的不要只写进 prompt。

## Objective

**What:** 把「此刻能不能写、写哪」收成**一个纯函数判定的三态处境**，所有告知面从它渲染；把「建树失败了下一步做什么」收成**一张按 kind 穷尽的可恢复性分类表**。分工钉死：**告知面说「此刻能不能写」，回执说「下一步做什么」**。

**Why:** 三处实测/代码可证的缺陷，同一根因——harness 给模型的信息不可信或没有出口：

1. **告知面说谎**：`writeRootSegment`（`src/harness/skill/body.ts:139-146`）只吃一个路径字符串，无条件输出 `the write root above is where file mutations should land`。而装配初值 `taskRoot: sandboxRoot`（`build-engine.ts:486`）= 主仓，`liveTaskRoot` 无条件创建（`:506`），三个生产调用方无条件 `read()`（`skill.ts:73-75`、`hub.ts:2273-2275`、`chat-session.ts:457`）。于是**隔离 ON + 未绑树**时，文案宣告「写主仓」，而门禁同一时刻以 `unboundMutateNotice` 拒绝一切写主仓的 mutate（`classifyCall` 把 `write_file`/`edit_file` 判 `mutate`，`worktree-gate.ts:479-490`）。两句真值相反的话**同时在场**。
2. **回执语义空心化**：`casual-ask-context-hygiene.md:21` 的锁定语义是「**若要写，调 `create-task-worktree` 再重试这一次调用**」；实现（`worktree-gate.ts:84-91`）只剩「该工具**存在**，供需要可写根的会话使用」——**「再重试这一次调用」这半句丢了**，唯一可行动的部分消失。SC7 验收（`:33`）只断言三个子串，实现满足子串、语义已空，测试全绿无人察觉。
3. **失败没有出口**：`worktree_exists` / `branch_exists` 的 detail 指向 `resolve the leftover tree/branch **manually**`（`:292`、`:299`），而模型手里有 `enter-task-worktree` / `list-task-worktrees`；`not_a_git_repo` / `git_unavailable` 是**结构性死路**（本会话不可能取得可写根），detail 只诊断不给出口，模型会重试至回合耗尽。

**Who:** CLI / TUI / serve 操作员；下游实施 = 本 worktree 上的 harness 改动。

## Boundaries

- **Does:**
  - 新增三态写处境纯函数，**复用** `isTaskWorktreePath`（不得重写形状判断）。
  - `writeRootSegment` 改为按处境渲染；①② 两态**逐字节不变**；③ 态只陈述事实、**不点名工具**。
  - 三个生产调用方与子代理 worker prior 改为消费**处境枚举**而非裸根。
  - `unboundMutateNotice` 恢复 spec 锁定语义（条件式 + 重发指引）；SC7 验收从纯子串升级为**语义 + 子串**。
  - `WorktreeIsolationErrorKind` 的**可恢复性穷尽表**；`operator_required` 类自带停止指令。
  - `worktree_exists` 按 sidecar 归属给**唯一**指引；`branch_exists` 分「目标目录在 / 不在」两子况。
  - `enter-task-worktree` 成功回执告知该树的创建者会话（**恒定开**，零成本一次文件读）。
  - bash 工具描述补 `/tmp` 进程临时事实，**沿用 ADR-0068 / `helpers.ts` T3 已定词汇**。
- **Confirms with human:**（本 session 已确认，不再开口）不恢复 auto-provision；不做宿主草稿纸 / 第 5 个根；不做 `web_fetch` `save_to`；不做装配期 git 预检；不做 `force` / `release` / 活性检测 / 锁文件；网络两条移出本 spec 且**不开 issue**；锁另立 `specs/worktree-exclusive-lock.md`。
- **Out of this spec:** 见文末「后续（本 spec 不做）」。

## Success Criteria

1. **三态判定**：`writeSituation(false, <任意非空根>)` → `writable_main`；`writeSituation(true, <树形根>)` → `writable_tree`；`writeSituation(true, <非树形根>)` → `no_writable_root`。**含「隔离 OFF + 树形路径」组合必须 → `writable_main`**（防形状判断被单独误用，对齐 ADR-0037 §4「`taskWorktreeOwnerOf` 只是路径形状判断，单靠它会…拿到沙箱外的读放行」的同类教训）。空 / 空白根 → typed 结果，不 throw 不静默。
2. **字节不变**：`writeRootSegment` 在 `writable_main` / `writable_tree` 两态的输出与改造前**逐字节相等**（断言锁死）。这是前缀缓存（prompt cache）与 `skill-load-write-root` SC2 / SC6 的硬约束。
3. **③ 态不引导**：`no_writable_root` 态输出含「无可写根 / 主仓对文件改动只读」语义，且**不含** `create-task-worktree` 字面（子串断言）。理由：trailer 在 skill 装配时进上下文，**早于任何写意图**；点名工具等于对每个未绑会话推一次建树，比 SC7 已禁止的更激进。
4. **依赖方向**：三条生产路径（TUI slash / hub `loadSkillBody` / ACI `skill()`）与 worker prior 均消费处境枚举；`src/harness/skill/body.ts` **不 import** `src/harness/isolation/`（判定住 isolation，渲染住 skill，枚举类型住 `session-roots.ts`，无环）。
5. **回执语义恢复**：`unboundMutateNotice()` 同时满足——(a) 含条件式（`To write` / `若要写` 等价）；(b) 含「重发这次调用」语义（`re-issue` 等价）；(c) 仍含 `create-task-worktree`；(d) 仍**不含** `this conversation's task worktree`；(e) 仍含 `This call would write`。(a)(b) 是本次新增的**语义**断言，(c)(d)(e) 是 SC7 既有子串断言，全部保留。
6. **可恢复性穷尽**：`Record<WorktreeIsolationErrorKind, Recoverability>` 覆盖**全部 16 个成员**；由 TypeScript 穷尽性保证——新增 kind 未分类则 `npm run typecheck` **失败**，不靠测试兜。
7. **停止指令**：`operator_required` 类（至少 `not_a_git_repo` / `git_unavailable`）的门禁回执含停止指令语义（「重试无用 / 报给操作员」等价），并含机读 `kind`（沿用 PR #947 `HardRuleSpec.reasonFor` 建立的「机读 id 进 reason」惯例）。
8. **`worktree_exists` 指引唯一**：按 `taskWorktreeOwnerOf(worktreePath)` 分三种，各有测试——owner === 本会话 → 点名 `enter-task-worktree`；owner !== 本会话 → 点名 `enter-task-worktree`（显式接手）**或**换 label；owner 读不出（无 sidecar / 历史树）→ 点名 `list-task-worktrees`。sidecar 读取失败不得 throw，退化到第三种。
9. **`branch_exists` 分子况**：目标目录**存在** → 与 SC8 同形；目标目录**不存在**（`remove-task-worktree` 默认不删分支造成的遗留分支）→ 指引换 label 或请操作员删分支，且**不含** `enter-task-worktree`（此时 enter 必撞 `worktree_not_found`，照抄会造第二次空转）。
10. **归属告知恒定开**：`enter-task-worktree` 成功回执含该树 sidecar 记录的创建者会话 id；读不出则**省略该句**（不崩、不占位）。此告知**不受任何设置控制**——零成本、永不阻塞，与 `specs/worktree-exclusive-lock.md` 的拦截档位是两件事。
11. **bash `/tmp` 事实**：bash 工具描述含「`/tmp` 内文件仅在本命令期间存在、命令结束即无」语义，词汇与 `helpers.ts` T3 文案一致（`process-temporary` / `not a delivery destination`）。**静态**，不进三态函数（该事实与隔离态、绑定态无关）。
12. **绿线**：`npm test` 与 `npm run typecheck` exit 0。

### 输入五类（S2，实施必须覆盖）

**A. `writeSituation` / `writeRootSegment`**

| 类         | 输入                                    | 期望                                                            |
| ---------- | --------------------------------------- | --------------------------------------------------------------- |
| empty      | 根为空串 / 仅空白                       | typed 结果，不 throw；不渲染出「写根 = 」这种半句               |
| negative   | 隔离 OFF + 树形路径；隔离 ON + 树形路径 | 分别 → `writable_main` / `writable_tree`；①② 输出**逐字节不变** |
| overflow   | 极长绝对路径 / 深层嵌套 / 尾随分隔符    | 形状判定仍按 `isTaskWorktreePath` 裁决，不自造第二套            |
| concurrent | `// N/A: pure`                          | —                                                               |
| exception  | 隔离 ON + 非树形根                      | → `no_writable_root`；输出不含 `create-task-worktree`           |

**B. Recoverability 表 + detail 渲染（`worktree_exists` / `branch_exists` / 结构性死路）**

| 类         | 输入                                                        | 期望                                                                |
| ---------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| empty      | sidecar 缺席 / 内容为空 / 不可读                            | 退化到「读不出归属」臂，点名 `list-task-worktrees`；**不 throw**    |
| negative   | `branch_exists` 且目标目录**不存在**                        | 指引换 label 或请操作员删分支；**不含** `enter-task-worktree`       |
| overflow   | 16 个 kind 全表                                             | 每个都有分类；漏一个 → `typecheck` 失败（编译期，不是测试期）       |
| concurrent | `// N/A: pure`（同步校验；sidecar 读在失败路径，单次）      | —                                                                   |
| exception  | `not_a_git_repo` / `git_unavailable`；sidecar 读抛非 ENOENT | 前者 → `operator_required` + 停止指令 + 机读 kind；后者原样 rethrow |

## Open Questions

1. **旧 envelope 的退化行为**：worker envelope 新增处境字段后，遇到**没有该字段的旧 envelope**（跨版本 resume / 旧 worker bootstrap）时，worker 该 (a) 按裸根渲染旧文案（等价 `writable_tree`，保兼容但可能在 ③ 态继续说谎），还是 (b) typed skip 不注入（保真但旧会话丢失写根告知）？倾向 **(b)**——本 spec 的立意就是「宁可不说，不可说错」，且 `skill-load-write-root` 合同 6 已有「`sandboxRoot` 空 → 不注入」的先例。**ACR 已代查的事实**：envelope **无** schema version 字段（`spawn-subagent-tool.ts:305-307` 对 `sandboxRoot` 缺席做条件 spread），且 `worker.ts:177-208` 已有「字段缺席回落 legacy 形态」的先例——所以 (b) 的证据已比较充分，`writing-plans` 可直接采纳 (b) 而无需再开一轮决策。

## Inherits / Changes

**Inherits:** ADR-0068 可写合同与 `/tmp` 词汇；ADR-0037 §1/§3/§6/§7/§9.2 与 T9 红线；ADR-0004；ADR-0040；`isTaskWorktreePath` / `taskWorktreeOwnerOf` / owner sidecar（`worktree-gate.ts:575` / `:674` / `:589-617`）；`writeRootSegment` 文案 SSOT 与三消费方（`skill-load-write-root`）；`HardRuleSpec.reasonFor` 的机读 id 惯例（PR #947）；SC7 子串禁令与「不按问句分型」；vitest `npm test`。

**Changes:**

- **ADR-0069（新）**：告知面 / 回执分工原则（告知面说「此刻能不能写」，回执说「下一步做什么」；共享处境判定、不共享措辞）+ 可恢复性分类轴。
- **ADR-0037**：Amendments 行加 0069 指针；**正文不改**（§9.2 写白名单、§7 活根语义、§1/§3 门禁职责全部原样）。
- **`specs/casual-ask-context-hygiene.md`**：SC7 **amend**（非 supersede）——撤「不把模型下一拍收成去建树」，保留子串禁令与「不按问句分型」，补语义断言；并记录 spec→实现的语义漂移（「再重试这一次调用」丢失）为本次修复对象。
- **`specs/skill-load-write-root.md`**：合同 6 / SC6 **amend**——envelope 多带处境枚举，worker 渲染入参变更；合同 1「文案只有一份」不变。
- **`docs/CONTEXT.md`**：新增 **写处境（write situation）** 词条；**amend** `taskRoot`（活值）词条补「告知面按写处境三态渲染，③ 态不点名工具」。
- **`specs/README.md`**：活跃表加本文件一行。
- **代码**：
  - **新增** `isolation/write-situation.ts`（三态判定纯函数）与 `isolation/recoverability.ts`（`WorktreeIsolationErrorKind` → 可恢复性穷尽表）。**不追加进 `worktree-gate.ts`**——该文件已 1167 行，远超 500 行 soft REVIEW 阈值（ACR note a）。
  - `isolation/worktree-gate.ts`：只承接 `worktree_exists` / `branch_exists` 的 detail 改写、`unboundMutateNotice` 语义恢复、`WorktreeIsolationErrorKind` 加成员（若需要）。
  - `session-roots.ts`（`WriteSituation` 枚举类型）、`skill/body.ts`（渲染）、`build-engine.ts` + `aci/tools/skill.ts` + `session-api/hub.ts` + `cli/chat-session.ts`（接线）、`subagent/worker.ts` + envelope（处境透传）、`session-api/worktree-rebind.ts`（enter 归属告知）、`aci/tools/bash.ts`（描述一句）。
  - **不改** `classifyCall` / `gateMutate` 状态机 / 波快照语义 / 围栏 argv。
- **doc 面合并顺序**：本 spec 与 PR #947 都要改 `docs/CONTEXT.md`、`specs/README.md`、`docs/adr/0037`。plan 必须显式排在 #947 之后（ACR note b）。

## ACR

`architecture-change-reviewer` 实跑输出（2026-09-08，SPECIFY → PLAN 边界门禁）：

```
bounded-context-guardian: yes — 依赖方向钉死且与现状一致：判定住 isolation（复用 worktree-gate.ts:575 isTaskWorktreePath，gate 自身 :1013 首查即用它）、渲染住 skill、枚举住 session-roots（SC4 显式断言 body.ts 不 import isolation）；占用判定留 session-api（worktree-rebind.ts 本就 import 并 throw WorktreeIsolationError）、boolean 值域留 config（settings.ts:223-226 / :299-303 同款单读点）；无技术分层切片、无反向依赖。
defensive-contract-validator: yes — 两份五类表全部分配、无造假：A 表 negative 钉「隔离 OFF + 树形 → writable_main」防形状误用（对齐 ADR-0037 §4 教训）；B 表 overflow = 16 kind 穷尽由 typecheck 承担（实测 union 恰 16 成员，worktree-gate.ts:95-123）；concurrent 两处 `// N/A: pure` 合法。
error-handling-enforcer: yes — 全部失败路径 typed、非空、有出口：SC6 编译期穷尽 + SC7 停止指令 + 机读 kind + SC8 sidecar 读失败退化不 throw + B 表非 ENOENT rethrow；「记录缺 workspaceRoot → 放行」不是 fail-open——缺字段的记录语义上确实不构成占用，与 I/O 故障（exception 臂）区分正确。
complexity-anti-drift: yes — 一个纯函数 + 一张静态表 + 文案分支；明令不改 classifyCall / gateMutate 状态机；无 god-function 意图。
minimal-change-verifier: yes — 两 spec = 两个 destination，拆分正确：本份修既有行为可信性（默认档行为改变），lock 份加新策略档位（默认档逐字节零回归），合并会把 bug-fix 与新 feature 混进一个 commit；依赖已声明实施顺序，非环。
OVERALL: PASS — hand to writing-plans
```

**两条非阻塞 note 的处置**：

- **(a) 已采纳并改写 Changes**：`worktree-gate.ts` 已 1167 行、远超 500 行 soft REVIEW 阈值，故 `writeSituation` 与 Recoverability 表**新增独立文件**承载，不追加进该文件。
- **(b) 已采纳并写进 Changes**：doc 面（`docs/CONTEXT.md` / `specs/README.md` / `docs/adr/0037`）与 PR #947 的合并顺序须在 plan 里显式排。

**ACR 代查确认的事实链**（原为起草期推断，现已实证）：缺陷链全部成立；`worktree-rebind.ts:896-944` 四道检查确无归属；`:785-798` restart-safe adoption 通道存在；`unboundMutateNotice` 实测确实只剩 "exists for sessions that need a writable root"，「再重试这一次调用」半句已丢。

## 待写入

- `docs/CONTEXT.md` 新增：**写处境（write situation）**。
- `docs/CONTEXT.md` amend：**taskRoot**（活值）——补三态渲染与 ③ 态不点名工具。
- `docs/adr/0069-write-situation-vs-gate-notice.md`（新）。
- `docs/adr/0037` Amendments 行加 0069 指针。
- `specs/casual-ask-context-hygiene.md` SC7 amend。
- `specs/skill-load-write-root.md` 合同 6 / SC6 amend。

## Assumptions（本 session 已确认，不再当作 Open Questions）

1. 修法是「告知面说真话 + 回执给出路」，不是恢复 auto-provision，也不是加长说明书。
2. 三态而非四态：草稿根不做（触发门未触发），所以处境枚举不含第四态。
3. 归属 sidecar 的职责是**告知**，不是授权、不是拦截——所以僵尸树堵不住任何东西（`enter-task-worktree` 四道检查里没有归属：调用方在主仓 / 目标存在 / 是 linked 检出 / 同仓库）。
4. 僵尸占用的恢复走既有「恢复会话 + 让它自己 exit」，是 restart-safe 的既有设计（`worktree-rebind.ts:790-798`、`worktree-gate.ts:913`），不需要 `release` 命令。
5. 认下的残留：外来树 + 无持久化 enter 记录 → trailer 说可写、门禁给 `foreign_worktree`。不修，因为该错误自带出路（`move this session back to the main repo first`，`worktree-rebind.ts:817`）；乐观告知 + 自洽错误 = 一步可恢复，而两句真值相反 = 不可推理。消掉它要让纯函数读可变门禁状态，不划算。
6. 网络出口两条（模型请求资格前置、批准文案说实话）**移出本 spec 且不开 issue**，记入「后续」留档。

## 后续（本 spec 不做）

1. **宿主草稿纸 / 第 5 个根 / ADR-0037 §9.2 写白名单破例** — 触发门**未触发**：`web_fetch` 已有 `start_chars` 分页且返回 Window 行含 `original_length`（全文可读，不是「超出即丢」）；`bash` + `network:true` 已能把内容存进写根（可写且持久）。重新考虑的条件：出现**第二个**消费者（子代理间交接大段原文、检索 dump 大到不能进上下文）。
2. **`web_fetch` 加 `save_to`** — 能力已存在且有闸（`network:true` 永远走显式批准、`full_auto` 不豁免，`bash.ts:187`/`:269`）；给读工具加写副作用是新职责，只换来省一次批准。
3. **装配期 git 预检** — SC7 的停止指令已够；预检要每会话一次 git 子进程，且瞬时故障会被误分成「配置故障型」，违反 ADR-0037 §9.4 两型分立。重新考虑的条件：实测到模型仍在 `not_a_git_repo` 上烧回合。
4. **网络出口加固** — 现状：`bash` 的 `network:true` 是 per-call 开关，默认 `--unshare-net` 断网，永远走显式批准且 `full_auto` 不豁免。缺口两条：(a) 模型可**无限制地**请求联网（批准疲劳风险）；(b) 放行后全网可达，含内网 / LAN / 云 metadata，**无域名或 IP 过滤**（`bwrap.ts:114` 是 `network ? [] : ["--unshare-net"]`，二值无中间档）。候选做法：settings 级资格前置（默认模型无权请求）+ 批准文案明写「完整宿主网络、含内网与 metadata、无过滤」。**不做**代理 / 域名白名单 / TLS 终结 / netns + nftables——那是独立功能独立 ADR。重新考虑的条件：一次真实的内网 / metadata 访问事故，或操作员明确要按域名放行。
5. **不可信内容经文件系统洗白** — `network-guard` 是 `web_fetch` / `web_search` **共用**的出站防线（`network-guard.ts:2`），**不覆盖 bash**；经 `curl -o` 或 `write_file` 落盘的内容，之后被 `read_file` 读回时不带 untrusted banner（文件系统不记得来源）。属通用注入面，**移交 `specs/security-guardrails.md` 轨**，不进本 spec（否则范围从「告知面」漂到「注入防护」）。
6. **明确不做** — 用加长说明书代替闸；语义级 shell 解析器（ADR-0068 已拒）；把 `/tmp` 升级成持久落点；把临时面当子代理交接区；恢复 auto-provision。
