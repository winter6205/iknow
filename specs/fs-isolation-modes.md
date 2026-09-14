# Spec: 文件系统隔离两档（默认全局）

> 假设门：2026-09-13 操作员确认（本会话）。对照材料不落盘。编号 ADR-0092 避开同日另一 worktree 的 ADR-0091。

## Glossary（exact copy from docs/CONTEXT.md）

- **文件系统隔离档（fs isolation mode）**: bash 物理围栏上「能看见 / 能写哪些路径」的档位，与 **PermissionMode** 和 **worktree isolation mode** 正交。默认 **全局档**。ADR-0092。
- **全局档**: 文件系统隔离关——宿主真路径可读可写；拦写靠权限三层 + **hard-wall**。home 不藏。ADR-0092。
- **工作区档**: 读偏宽（home 可见）；写 = 活 **taskRoot** + **会话 tmp**；home 其余默认不能写。ADR-0092。
- **闭世界围栏（closed-world fence）**: 已退役的默认 bash FS 姿态（ADR-0037 §9）：home 下非白名单**不可见**，可写集 = taskRoot + `/tmp`。默认改为 **全局档**（ADR-0092）。**工作区档不是闭世界**（home 仍可见）。
- **会话 tmp**: 每个身份（主会话或一个 worker）在会话文件夹里的宿主目录；模型与 `$TMPDIR` 用这条真路径；不 bind 成 Linux `/tmp`。寿命跟会话文件夹；不是交付落点。ADR-0092（修订 ADR-0074）。
- **hard-wall**: spawn 前意图过滤器——拦围栏看不见或拦不住的命令意图（毁灭性 rm、命令替换、敏感路径、fork-bomb），不可被 session grant 覆盖。不是第二套沙箱；换行只作分段符。耐久写只问 `taskRoot`。ADR-0068。
- **沙箱纪律**: 同一 `bash` 调用输入下，前台执行与 `background:true` spawn 共用同一套 bwrap 围栏参数（FS / 网络 / env 隔离 / rlimit / cwdReadonly）；产品路径不得提供无围栏的后台裸跑。#653 G3。
- **自动模式**: 权限轴 `PermissionMode` 的 `full_auto`：不逐次征求批准、对 mutating 工具直接放行的会话级权限模式；本轮不问人，跑完仍把键盘还给用户。hard-wall 仍先拦。Shift+Tab / 徽标上的 Auto 就是它。项目 settings 不得写入该值（`defaultMode: "full_auto"` 加载 fail-loud，仓库不得自授自动模式）。ADR-0032 / ADR-0090。
- **worktree isolation mode**（`settings.isolation.worktreeOnMutate`，默认 OFF）: **用户层**写门禁开关——ON 时未绑树的 mutate 被拦（门禁从不自动建树）；OFF 时无门禁、主仓可写。工作树 ACI（create/enter/exit/list/remove）在 host 缝在场时**常注册**，不跟本开关捆死。`create-worktree` / enter / exit 成功才 **session worktree rebind**；bash `git worktree add` 不是 rebind。只在启动加载点读取一次。ADR-0037（amended `specs/agent-control-surface.md`）。
- **taskRoot**（活值）: 会话当前生效的 task worktree 根——**写与工具 cwd 只问它**（写工具 / 会改工作区的 bash / git / LSP 目录 / 子代理工作目录）。

## Objective

**What:** 把「权限问不问人」和「进程真能碰哪些路径」拆成两层。默认 **全局档**：home 与仓库按宿主真路径读写，权限三层照常拦截，hard-wall 仍在。会话草稿走 **会话 tmp** 真路径，去掉「把垫底 bind 成 `/tmp`」 dual name。 **工作区档** 与 TUI `/config` 开关属 Round 2，合同写死、本轮不交付开关面。

**Why:** 现行闭世界把 home 整棵藏掉，可写只剩 `taskRoot` + 围栏 `/tmp`，才逼出宿主垫底与 Linux `/tmp` 两套名字；模型写不到 `~/.iknow/…` 真路径。操作员要的默认是本机路径 + 权限拦截。

**Who:** chat / tui / serve 上的模型与操作员；实施面 = sandbox fs-policy / bwrap、bash `$TMPDIR`、写工具可写集、会话文件夹布局。

## Boundaries

- **Does:**
  - 钉两层：PermissionMode ≠ 文件系统隔离档 ≠ worktree isolation。
  - 默认全局档：bash 看见并（在权限 + hard-wall 放行后）可写 home 真路径；会话 tmp 用宿主绝对路径；`$TMPDIR` 指向该目录；不把该目录 bind 成 `/tmp`。
  - 写工具：`taskRoot` 仍是耐久交付；会话 tmp 真路径可写（修订 `parent-visible-tmp` / ADR-0074 的「路径仍叫 `/tmp`」）。
  - 前台/后台 bash 仍共用同一围栏 token（沙箱纪律）。网络 / env / rlimit 不借本 spec 放开。
  - 闭世界不再是默认姿态；ADR-0037 §9 默认条款 reopen。
  - Round 2 合同（不实现本轮）：工作区档读 home、写 = taskRoot + 会话 tmp、home 其余不能写；开关走 TUI `/config`（或等价 settings），默认仍全局。
- **Confirms with human:** （已确认）默认全局；工作区档 home **默认不能写**（会话 tmp 除外）；不把对照产品名写入仓库文件。
- **Out of this spec:**
  - grep 一波超时 / `output` 别名（另一 worktree）。
  - 改 PermissionMode 集合、hard-wall 规则表、网络默认 deny（ADR-0022）。
  - 卸掉 bwrap 整进程（无围栏后台裸跑仍禁止）。
  - 工作区档防「写 `~/其他仓`」——工作区档只收紧 home 写，不另做邻仓身份墙。
  - Round 2 的 `/config` 面板像素与信息架构。

## Success Criteria

### Round 1（默认全局 + 会话 tmp 真路径）

1. **SC1（home 可见）**：全局档下 `bash` `ls` 操作员 home 下既有目录成功（非「路径不存在 / 不可见」）。覆盖该行为的 harness 或探针测试绿。
2. **SC2（真路径草稿）**：全局档下 `bash` 把文件写到当前身份 **会话 tmp 的宿主绝对路径**；同一路径在围栏外 `stat` 得到同一内容。不要求（也不允许验收依赖）该文件出现在 Linux `/tmp`。
3. **SC3（无 `/tmp` bind）**：全局档围栏 argv **没有**「会话垫底 bind 到 `/tmp`」。`echo $TMPDIR` 等于该身份会话 tmp 宿主路径（或其规范路径）。
4. **SC4（写工具）**：`write_file`（及对称的 `edit_file` 若适用）指向会话 tmp 宿主绝对路径成功；内容在垫底上，**不**出现在 `taskRoot`。指向 Linux `/tmp/…` 的产品语义：不作为会话垫底别名（与今日 SC「`/tmp` = 垫底」脱钩；具体拒绝或落到 OS `/tmp` 由实施选一种并测死，须可观测、非静默双写）。
5. **SC5（权限仍在）**：PermissionMode `default` 下 mutating `bash` 仍走既有 ask/allow/deny 链；本改动不得变成「全局档 = bypass」。既有 permission 测试仍绿或按等价不变式改写。
6. **SC6（hard-wall）**：既有毁灭性 argv 夹具仍拦；不因全局档绕过 hard-wall。
7. **SC7（沙箱纪律）**：同一 `bash` 输入前台与 `background:true` 共用同一 FS 档 token；无产品路径后台裸跑。
8. **SC8（正交）**：`worktreeOnMutate` ON + 未绑树写主仓仍门禁拦；本 spec 不改 isolation 门禁语义。
9. **SC9（探针/单测）**：闭世界「home 不可见」断言改为仅工作区档（Round 2）或删除默认档断言；Round 1 范围内 `npm test` 与 `npm run typecheck` 退出 0。
10. **SC10（父子垫底）**：主会话与 worker 各一块会话 tmp；父 `bash` 读 worker 垫底仍读不到；`subagent_result` 按 `task_id` 仍能列/读该 worker 垫底（`parent-visible-tmp` SC3/SC6 路径字段从 `/tmp` 改为宿主根）。

### Round 2（工作区档 + 开关面）— 合同在此，实施另轮

11. **SC11**：工作区档 `bash` 读 home 下普通文件成功；写 home 下非（taskRoot ∪ 会话 tmp）路径失败（围栏拒绝，typed / 非零，不落盘）。合同细化见 ADR-0092 Amendment 2026-09-13（argv：`--bind / /` + 系统前缀 ro + `--ro-bind <home> <home>` + `--bind <taskRoot>` + `--bind <会话 tmp>`；home 之外如 `/tmp` 不受本档收紧——本档只收紧 home 写）。
12. **SC12**：工作区档仍能按 **SC2** 写会话 tmp 真路径。
13. **SC13**：settings（`isolation.fsMode`，用户层）或 TUI `/config fs global|workspace` 能把档从全局切到工作区；缺省与新会话为全局档；运行期经 holder（镜像 `GraphModeContext`）就地翻转，权限模式控件不被本开关替换（正交）。

### 输入五类（S2，Round 1 写路径）

| 类         | 输入                         | 期望                                |
| ---------- | ---------------------------- | ----------------------------------- |
| empty      | 空路径 / 会话 tmp 根当文件写 | typed 拒绝；不写到 taskRoot         |
| negative   | 合法会话 tmp 相对名          | 写入当前身份垫底                    |
| overflow   | 极长文件名仍在垫底下         | 不误落到 taskRoot；超限走既有写失败 |
| concurrent | 两 worker 同名文件           | 各写各垫底                          |
| exception  | 垫底不可写                   | typed 失败，不静默丢                |

## Open Questions

（none — 假设门已关。Linux `/tmp` 与会话 tmp 脱钩后的 `write_file("/tmp/…")` 选拒绝或 OS 路径，属实施头room，须在 T3 测死一种。）

## Inherits / Changes

**Inherits:** 权限三层（`security-guardrails.md` / ADR-0090）；hard-wall（ADR-0068）；沙箱纪律；bwrap 仍是 bash spawn 路径；`taskRoot` 耐久交付；会话文件夹在 home 项目树；`parent-visible-tmp` 的「每身份一块、跟会话寿命、父按 id 读、不自动拷进仓」。

**Changes:** 默认 FS 姿态从闭世界改为全局档。会话 tmp 不再 bind 成 `/tmp`。ADR-0037 §9「OFF 档同样闭世界」对 **默认 FS** superseded。ADR-0074「bind 成围栏 `/tmp`」superseded（寿命与每身份一块保留）。

**Amends:** `specs/parent-visible-tmp.md`；`specs/mutate-write-contract.md`（可写集字面含会话 tmp 真路径，不再写死 `/tmp`）；`specs/security-guardrails.md` 零信任沙箱 FS 白名单默认描述。

## architecture-change-reviewer

```
bounded-context-guardian: yes — FS 档落 sandbox；权限仍在 permission/；worktree 门禁不搬家；会话 tmp 仍会话文件夹布局
defensive-contract-validator: yes — Round 1 写路径五类表在上；workspace 越界写留 Round 2
error-handling-enforcer: yes — 垫底不可写 typed；工作区越界写 typed；hard-wall 不吞；无静默降级成裸跑
complexity-anti-drift: yes — 一档一位工厂（全局 vs 工作区），不把权限链折进 bwrap argv
minimal-change-verifier: yes — Round 1 默认全局+去 bind；Round 2 工作区+/config 独立收尾不混 commit
```

affects: `src/harness/sandbox/fs-policy.ts` `src/harness/sandbox/bwrap.ts` `src/harness/aci/tools/bash.ts` 写工具可写集 `specs/parent-visible-tmp.md` `docs/adr/0037-worktree-isolation-on-mutate.md` `docs/adr/0074-fence-tmp-backing.md` `docs/adr/0068-hard-wall-vs-closed-world.md` `docs/adr/0092-fs-isolation-modes.md` `docs/CONTEXT.md` `tests/harness/sandbox/` `verify/sandbox-run.ts`
