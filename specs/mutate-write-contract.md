# Spec: 可写合同与 hard-wall 层退休

> 假设门：2026-09-08 操作员确认方案 A（层退休，不是放宽换行补丁）。本文件只覆盖 **本 session 要修的闸与写根合同**。范围外方向见文末「后续（本 spec 不做）」。无 GitHub tracker。

## Glossary（exact copy from docs/CONTEXT.md）

- **闭世界围栏（closed-world fence）**: bash 围栏的默认姿态——deny-by-default:home 下非白名单不可见，可写集 = taskRoot + /tmp，其余按 ADR-0037 §9.2 读白名单按需 ro-bind；白名单 miss 分配置故障（spawn 前 typed fail-loud）与工具链断链（运行时可观察）两型。OFF 档同样生效（全档位反转）。
- **taskRoot**（活值）: 会话当前生效的 task worktree 根——**写与工具 cwd 只问它**（写工具 / 会改工作区的 bash / git / LSP 目录 / 子代理工作目录）。
- **projectIdentityRoot**: 用户此刻在做的那个项目的身份根……项目身份只问它……
- **子代理根归属**: 子代理是**父会话的执行臂**，继承父会话当前生效根；不是独立隔离单元。父会话已 rebind 时与父共享同一棵 task worktree……ADR-0040。
- **沙箱纪律**: 同一 `bash` 调用输入下，前台执行与 `background:true` spawn 共用同一套 bwrap 围栏参数……

（上文 `taskRoot` / `projectIdentityRoot` 完整句以 `docs/CONTEXT.md` 为准，本 spec 不重定义。）

## Architectural Constraints

- **ADR-0037 §9**：闭世界围栏是 bash **物理**可写边界；`/tmp` 是可写 tmpfs（进程临时面）。
- **ADR-0004**：bash 安全边界以 OS 沙箱为准；allowlist/硬墙不得再充当第二套沙箱。
- **ADR-0040**：子代理共享父 `taskRoot`，不各自建树、不另开写根。
- **docs/guides/prompt-development.md**：说明书不是闸；能用代码/schema/轨迹判定的不要只写进 prompt。

## Objective

**What:** 把「能不能写、写到哪、失败是哪一类」收成一份合同：闭世界围栏继续当唯一物理沙箱；`write_file` / `edit_file` 的耐久写只落 `taskRoot`；hard-wall 只拦围栏看不见的意图；spawn `sandboxRoot` 把「不存在」和「越界」分开。父会话与子代理同一合同。

**Why:** 2026-09-08 会话（写一份自包含 HTML）失败：`write_file` 拒 `/tmp`、bash 围栏允许 `/tmp`、hard-wall 把换行/`format` 子串当危险、未创建的父根下目录被说成 outside，模型耗尽 maxTurns。根因是层职责错配，不是模型不会写文件。

**Who:** CLI/TUI 操作员；下游实施 = 本 worktree 上的 harness 改动。

## Boundaries

- **Does:**
  - 耐久 mutate（`write_file` / `edit_file` 及面向模型的写根文案）只认活 `taskRoot`。
  - bash 的 `/tmp` 保持闭世界 tmpfs：进程临时、跨调用不持久；**不得**作为产品交付落点，也不得引导模型把交付物写到 `/tmp`。
  - hard-wall：换行只作分段符；禁止 `"format"` 子串误伤；危险模式按段扫描（`rm -rf` 等仍 deny）；deny 文案带命中 pattern id。
  - `spawn_subagent` `sandboxRoot`：父根下词法包含且尚未存在 → 不得报 outside；省略字段则继承父写根。
  - 子代理验收面：在父 `taskRoot` 上 `write_file` 能完成简单落盘（与父同一闸）。
- **Confirms with human:** （本 session 已确认，不再开口）方案 A；不做每子代理持久 scratch；不做语义 shell AST。
- **Out of this spec:** 见文末「后续（本 spec 不做）」。

## Success Criteria

1. `isDangerousCommand` / hard-wall：含换行的白名单段命令（例如 `mkdir -p ./a` 换行 `ls`）**不**因换行本身 deny；同一套危险子串在换行后的段上仍能命中 `rm -rf`。对应现有 permission 单测扩展，`npm test` 中该文件绿。
2. 命令正文含 CSS `text-transform`（或其它含 `format` 子串的合法内容）且无真正 `format` 词法命中时，**不** hard-wall deny。
3. hard-wall deny 的 `reason` 含可机读的命中 id（至少区分：毁灭性 rm 类 / 命令替换 / 敏感路径），不再只有一句笼统 `shell-metachar`。
4. `write_file` 指向 `/tmp/...` 仍拒绝耐久写；文案写明当前写根 = 活 `taskRoot`，并说明 `/tmp` 不是交付落点（不是只说 outside workspace）。
5. `write_file` 相对当前 `taskRoot` 的合法路径（含尚未存在的子目录，若实现选择 mkdir 或不存在则 typed 可执行错误、**禁止** outside）可完成写入；子代理 worker 与父会话同一规则。
6. `spawn_subagent`：`sandboxRoot` = `join(parentSandboxRoot, "<new-dir>")` 且该目录尚不存在时，错误 **不是** `outside the parent sandbox root`；要么词法放行（worker 侧再处理存在性），要么独立 typed 文案（does not exist / mkdir first / omit to inherit）。
7. `sandboxRoot` 落在父根之外（含 `/tmp` 作为子代理根）仍拒绝。
8. 既有危险样例回归：`rm -rf`、`$(...)`、fork-bomb、敏感路径重定向仍 hard-wall deny（`tests/harness/aci/permission.test.ts` 危险表不回退）。
9. `npm test` 与 `npm run typecheck` 在本改动范围内绿。

### 输入五类（S2，实施必须覆盖）

两类函数面分别覆盖 empty / negative / overflow / concurrent / exception。`concurrent` 对纯函数标 `// N/A: pure` 即可。

**A. `findDangerousPattern` / `isDangerousCommand`**

| 类         | 输入                                          | 期望                                                   |
| ---------- | --------------------------------------------- | ------------------------------------------------------ |
| empty      | `""` / 仅空白                                 | 不放行执行（既有空命令语义）；不得误标为 `format` 子串 |
| negative   | 合法多行白名单段；含 `text-transform` 的 echo | 不 hard-wall                                           |
| overflow   | 很长命令 / 很多换行但仍为白名单段             | 不因长度/换行 deny；段内 `rm -rf` 仍命中               |
| concurrent | `// N/A: pure`                                | —                                                      |
| exception  | 真危险（`rm -rf`、`$(...)`）                  | deny 且 reason 带 pattern id                           |

**B. 写根 + `buildWorkerPayload` sandboxRoot**（钉 `tests/subagent/sandbox-root.test.ts` 与 write 工具测试）

| 类         | 输入                                      | 期望                                                       |
| ---------- | ----------------------------------------- | ---------------------------------------------------------- |
| empty      | 省略 `sandboxRoot`                        | 继承父根，spawn 不因缺字段报 outside                       |
| negative   | `sandboxRoot` = 父根下尚未存在的子路径    | **不是** outside（SC6）；`/tmp` 当 sandboxRoot 仍拒（SC7） |
| overflow   | 极长相对路径仍在父根下                    | 词法仍按 prefix 裁决，不炸成笼统 outside                   |
| concurrent | `// N/A: pure`（同步校验）                | —                                                          |
| exception  | 父根外绝对路径；realpath 非 ENOENT 的 I/O | outside 或原样 rethrow；ENOENT 不得再与 outside 同文案     |

## Open Questions

(none) — 假设门已在本 session 关闭。

## Inherits / Changes

**Inherits:** ADR-0037 §9 闭世界可写集（bash：`taskRoot` + tmpfs `/tmp`）；ADR-0040 子代理执行臂；permission 五步链 + `hard-walls.ts`；`SubAgentSandboxRootError`；vitest `npm test`。

**Changes:**

- ADR-0068：hard-wall 相对闭世界的职责边界；换行/`format` 子串补丁标 superseded。
- `docs/CONTEXT.md`：补 **hard-wall** 词条（spawn 前意图过滤，不是第二套沙箱）；与「闭世界围栏」互不重叠。
- `specs/README.md` 活跃表加本文件一行。
- 代码：`hard-walls.ts` + 单测；`write_file` 越界文案；`manager.ts` sandboxRoot 分类。不改 prompt 正文当主修复。

## ACR

```
bounded-context-guardian: yes — stays in existing harness seams (`hard-walls.ts`, `aci/tools/helpers.ts`, `subagent/manager.ts`, `errors.ts`) plus ADR/CONTEXT persist; no new layer dirs; ADR-0040 same write root.
defensive-contract-validator: yes — spec 「输入五类（S2）」tables A+B allocate empty/negative/overflow/concurrent (`// N/A: pure`) /exception; B pins `tests/subagent/sandbox-root.test.ts` for SC6/7.
error-handling-enforcer: yes — SC3 pattern-id deny; SC4 `/tmp` durable reject; SC5 missing subdir ≠ outside; table B exception splits ENOENT copy vs outside vs non-ENOENT rethrow.
complexity-anti-drift: yes — declared as per-segment scan + write-root copy + lexical prefix taxonomy in those existing functions, not one god-flow.
minimal-change-verifier: yes — one session 方案 A write-contract (spec Changes); persist is the same decision, not a second feature.
```

## 待写入

（已 flush：ADR-0068、CONTEXT `hard-wall`。）

## Assumptions（本 session 已确认，不再当作 Open Questions）

1. 修法是层退休，不是只允许换行。
2. 产品交付物只落 `taskRoot`；bash `/tmp` 保持临时、不持久。
3. 子代理不新增独立产物目录；跟父写根。
4. 本 spec 不修隔离建树认仓、也不做宿主草稿纸。

## 后续（本 spec 不做）

可写合同落地之后再做。不在本轮实施，也不开 GitHub issue。

1. **隔离写路径** — 改工作区应先创建或进入本会话 task worktree，再在那棵树上写。写根必须说清楚，避免把交付物写到进程临时面，或把「身份根只读」理解成整个项目都不能写。
2. **建树/认仓失败要可执行** — 隔离 ON 时，创建工作树失败必须是明确 typed 错误（有没有可用 gitdir、为何建不成），不能在错误类型之间空转。
3. **进程临时面 ≠ 交付目录** — 围栏 `/tmp` 是每次调用的临时文件系统。不要把它升级成正式落盘点。
4. **子代理** — 继续当父会话执行臂，共享父写根。若以后要工具输出草稿（抓取原文、大段检索），应是宿主侧 gitignore 草稿纸，带会话寿命和给父代理的路径指针；不能代替 `taskRoot`，也不能绕过隔离改身份根。
5. **明确不做** — 用加长说明书代替闸；用语义级 shell 解析器当本问题的解；把临时面当子代理交接区。
