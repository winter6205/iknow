# Spec: 围栏 /tmp 垫底与父按 id 读取

> 假设门：2026-09-09 操作员在地图「子代理父可见暂存与空交差补救」上关闭。本文件只记裁定，不记对照材料。
>
> **Amends** `specs/mutate-write-contract.md` SC4（`write_file` 指向 `/tmp` 不再因「非交付」拒绝）；**amends** ADR-0068 / ADR-0037 §9.2 中「`/tmp` = 一次命令一块空 tmpfs」的寿命句。耐久交付仍只认 `taskRoot`。

## Glossary（exact copy from docs/CONTEXT.md）

- **闭世界围栏（closed-world fence）**: bash 围栏的默认姿态——deny-by-default:home 下非白名单不可见，可写集 = taskRoot + /tmp，其余按 ADR-0037 §9.2 读白名单按需 ro-bind；白名单 miss 分配置故障（spawn 前 typed fail-loud）与工具链断链（运行时可观察）两型。OFF 档同样生效（全档位反转）。
- **taskRoot**（活值）: 会话当前生效的 task worktree 根——**写与工具 cwd 只问它**（写工具 / 会改工作区的 bash / git / LSP 目录 / 子代理工作目录）。
- **父可见信封**: 子代理交差给父模型看的那一层——短摘要、改过的路径、成败与停因；不是终稿全文，也不是磁盘上的代码。
- **子代理根归属**: 子代理是**父会话的执行臂**，继承父会话当前生效根；不是独立隔离单元。
- **会话文件夹（session folder）**: harness 拥有的按会话记录面——`~/.iknow/projects/<项目 slug>/<conversationId>/`……装 session transcript / todos / trace / **内容寻址正文池** / subagents。
- **围栏 /tmp 垫底**: 每个身份（主会话或一个 worker）在会话文件夹里的宿主目录，bind 成该身份围栏的 `/tmp`；寿命跟会话文件夹；不是交付落点。

（未写入 CONTEXT 的词不得当定义用。本条「围栏 /tmp 垫底」在 persist 后与 CONTEXT 逐字对齐。）

## Architectural Constraints

- **ADR-0037 §9 / ADR-0068**：闭世界围栏仍是 bash 唯一物理沙箱；可写集仍是 `taskRoot` + `/tmp`。本 spec 只改 `/tmp` **后端与寿命**，不另开第三可写根、不另开 worktree。
- **ADR-0040**：子代理与父同一 `taskRoot`，不各自建树。
- **ADR-0069**：写处境 / 写根段只说交付根，不把 `/tmp` 揉进写根段。
- **ADR-0071**：新 worker 记录落在父会话文件夹 `subagents/` 下；旧平铺 `agent-*.jsonl` 不迁。
- **ADR-0014**：前景 / 后景只是等待契约；本 spec 交差字段与按 id 读取对两臂同一套。

## Objective

**What:** 把围栏 `/tmp` 从「一次 bash 一块空 tmpfs」改成「每个身份一块宿主垫底、跟会话同寿命」。`bash` / `write_file` / `edit_file` 都能写 `taskRoot` 与这块 `/tmp`。交差每次带 `task_id` 与该 `/tmp` 根。父用 `subagent_result` 按 `task_id`（可选相对路径）列顶层或读一份。空交差时 host 可补短名单。不自动把 `/tmp` 拷进仓库。不定体积产品闸。

**Why:** 中间物不必进仓；子代理没交差或只回了分析时，盘上还在，父能按 id 找到。交付仍只认 `taskRoot`。

**Who:** chat / tui / serve 上的父模型与子代理；实施面 = harness 围栏、写工具、子代理信封与会话文件夹布局。

## Boundaries

- **Does:**
  - 主会话一块垫底；每个 worker 一块；互不共用。围栏里路径仍叫 `/tmp`。
  - `$TMPDIR` 与 `mktemp` 落到同一块垫底。
  - 新 worker：`subagents/<taskId>/` 内放记录、垫底、stderr。旧平铺不迁。
  - 交差（前景 tool_result 与后景 drain）每次带 `task_id` + `/tmp` 根。默认不带产物名单。
  - `subagent_result`：只 `task_id` → 列该垫底顶层名字；再给相对路径 → 读这一份（截断同现有 `read_file`）。
  - 空 / 失败 / 截断 / crash 时 host 可额外附带短名单。不灌文件正文进父 context。
  - bash 与写工具描述：进项目写 `taskRoot`；不必进仓写 `/tmp`（跟当前身份同寿命，不是交付）。
- **Confirms with human:** （已关）无。
- **Out of this spec:**
  - 主进程读自己项目根以外的其它项目（另开 issue；不改闭世界读白名单）。
  - 跨会话事实库 / 抽取 / 召回。
  - 每个子代理独立 worktree。
  - 在不改寿命的前提下读已灭的当次命令 tmpfs。
  - 把 `/tmp` 自动提升为仓库文件。
  - 独立体积产品闸（字节上限）。

## Success Criteria

1. 同一主会话连续两次 `bash`：第一次写入 `/tmp/x`，第二次 `cat /tmp/x` 读到同一内容。`npm test` 中覆盖该行为的测试绿。
2. 同一主会话 `write_file` 路径 `/tmp/y` 成功，内容出现在该主会话垫底上，且**不**出现在 `taskRoot`。
3. worker 写入的 `/tmp/z`：父会话 `bash` `cat /tmp/z` **读不到**该内容；`subagent_result` 带该 `task_id` 能列出 `z` 并读到内容。
4. 前景与后景终态信封均含非空 `task_id` 与该 worker `/tmp` 根字段（字段名实施自定，验收认「能用来按 id 读」）。成功路径默认**无**产物名单数组（或空）。
5. 空摘要且空 result（或 crash/timeout/截断）的终态：信封含短产物名单（顶层），仍不灌文件正文。
6. `subagent_result`：未知 `task_id` → typed 失败（与今日 `not_found` 同类）；`tmp_path` 含 `..` 或试图跳出该垫底 → typed 拒绝，不读垫底外文件。
7. 新 spawn 的 worker：会话文件夹下存在 `subagents/<taskId>/` 且含记录文件、垫底目录；stderr 在该目录内，不在旧的会话级 `stderr/<taskId>.log`（旧文件仍可读）。
8. 既有平铺 `subagents/agent-<id>.jsonl` 的查询 / 列表路径不因新布局失败。
9. 围栏内 `echo $TMPDIR` 落在该身份垫底（或为其子路径）；`mktemp` 创建的文件出现在该垫底上。
10. 无代码路径在成功交差后把垫底文件复制进 `taskRoot`。
11. 本改动范围内 `npm test` 与 `npm run typecheck` 退出 0。

### 输入五类（S2）

**A. 写解析（`write_file` / `edit_file` / bash 写 `/tmp`）**

| 类         | 输入                             | 期望                                              |
| ---------- | -------------------------------- | ------------------------------------------------- |
| empty      | 路径 `/tmp/` 或空文件名          | typed 拒绝或与今日空路径语义一致；不写到 taskRoot |
| negative   | `/tmp/ok.txt`                    | 写入当前身份垫底                                  |
| overflow   | 极长文件名仍在 `/tmp` 下         | 不误落到 taskRoot；超限走既有写失败               |
| concurrent | 两 worker 同时写 `/tmp/same.txt` | 各写各垫底，不互相覆盖                            |
| exception  | 垫底目录不可写                   | typed 失败，不静默丢                              |

**B. `subagent_result` 按 id 读垫底**

| 类         | 输入                        | 期望                         |
| ---------- | --------------------------- | ---------------------------- |
| empty      | `task_id` 合法、垫底空      | 名单为空列表，不是错误       |
| negative   | 未知 id                     | `not_found`（或等价 typed）  |
| overflow   | 单文件超过 `read_file` 截断 | 截断，不把全文灌进父 context |
| concurrent | `// N/A: 同步查询`          | —                            |
| exception  | `tmp_path` 逃逸垫底         | 拒绝；不读会话文件夹其它文件 |

## Open Questions

(none)

## Inherits / Changes

**Inherits**

- 可写集字面仍是 `taskRoot` + `/tmp`（ADR-0037 §9.2）。
- 子代理不另开 worktree（ADR-0040）。
- 写根告知三态不提 `/tmp`（ADR-0069）。
- 会话文件夹分组键与叶子（ADR-0071）。
- 前景默认 `wait:true`（ADR-0014）；`subagent_result` 已存在，本 spec 只加按 id 读垫底。
- 测试命令：`npm test`、`npm run typecheck`。

**Changes**

- `/tmp` 后端：宿主目录 bind，不再是一次命令空 tmpfs。
- `write_file` / `edit_file` 可写当前身份的 `/tmp`（推翻 mutate-write-contract SC4 的拒绝）。
- 父可见信封增加 `task_id` 与 `/tmp` 根（成败都有）。
- 新 worker 目录形态：`subagents/<taskId>/`（记录 + 垫底 + stderr）。
- ADR-0074 记录本寿命与可见性决策；ADR-0068 寿命句 amended。

## 待写入

- CONTEXT：`围栏 /tmp 垫底`；修订 `父可见信封`（交差含 `task_id` 与 `/tmp` 根）；对子「父可见信封 vs 磁盘产物」补一句根路径。
- ADR-0074（本决策）；ADR-0068 amendment（寿命句）。

## architecture-change-reviewer

Planned files（≥3）：`src/harness/sandbox/bwrap.ts`（及 fs-policy / bash 装配）、写工具路径解析、`src/harness/subagent/envelope.ts`、`src/harness/subagent/subagent-result-tool.ts`、worker/manager 垫底分配、会话文件夹 `subagents/` 布局、对应 tests、bash/写工具描述。

```
bounded-context-guardian: yes — 仍在 harness 围栏、写工具、子代理信封与会话文件夹；不新开 bounded context，不把垫底当模型交付仓
defensive-contract-validator: yes — Success Criteria 含写解析与按 id 读两类五边界表
error-handling-enforcer: yes — 未知 id / 路径逃逸 / 垫底不可写均为 typed 非空失败；禁止静默丢写
complexity-anti-drift: yes — 垫底分配、信封字段、按 id 读取分缝；不把 bind / 信封 / 读垫底揉成一个函数
minimal-change-verifier: yes — 一项能力；实施按 plan 一 tracer 一 commit，不与读根外 issue 混交
```
