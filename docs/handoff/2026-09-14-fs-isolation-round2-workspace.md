# Handoff: fs 隔离工作区档（Round 2，T6–T8）

日期：2026-09-14
分支：`worktree-fs-isolation-workspace`（base `ad338a4d`）
契约：`specs/fs-isolation-modes.md` SC11–SC13；`docs/adr/0092-fs-isolation-modes.md`（含 Amendment 2026-09-13）
计划：`plans/fs-isolation-modes.md` T6/T7/T8

## 交付内容

| Task                  | 内容                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T6 `[decision]`       | ADR-0092 Amendment 2026-09-13：开关字段名 `isolation.fsMode`（**用户层**，项目文件不得自授）、围栏 argv 序、写工具两档同根的理由。`900f042a`                                            |
| T7 `[implementation]` | 工作区档围栏：`src/harness/sandbox/fs-mode.ts`（值域 + holder）、`bwrap.ts` 挂载序 `--bind / /` → 系统前缀 `--ro-bind` → `--ro-bind <home>` → `--bind <taskRoot>` → `--bind <会话 tmp>` |
| T8 `[implementation]` | 开关面：settings `isolation.fsMode` + TUI/chat/serve `/config [status\|fs global\|fs workspace]`；holder 就地翻转                                                                       |

## 四入口同档（本次 review 的 High 修复面）

工作区档的「home 其余不能写」必须在**每一条执行面**上都成立，否则可被绕开：

- **TUI**：`buildTuiDeps` → bash 工厂（holder 同一实例）；`hub-bridge.ts` 把 holder 交 `SessionHub`，verify 面 per-call 现读。
- **chat REPL**：`src/cli/chat-session.ts` 的 `chatVerifyFenceOpts` 把档位喂给 `runVerifyLoop`。
- **serve**：`src/session-api/serve.ts` 同款接线。
- **subagent worker**：父进程经 env `IKNOW_FS_MODE`（`src/config/workspace-root.ts:43`）过进程边界；写侧 `spawn.ts:213-215`（holder 缺席则不写键）、读侧 `worker.ts:315-320` + 生产调用点 `:1117`。

## 实测证据（MCP 真实 TUI 交互）

隔离 HOME `/home/winner/.claude/jobs/6068698e/tmp/fsmode-home`，`isolation.fsMode: "workspace"` 起步，`mcp__aiterm__pty_*` 驱动真 TUI。

| 步骤             | 输入                                           | 观测                                                                   | 判定                  |
| ---------------- | ---------------------------------------------- | ---------------------------------------------------------------------- | --------------------- |
| SC13 读口        | `/config status`                               | `文件系统隔离档: workspace（home 可见只读；写 = taskRoot + 会话 tmp）` | ✅ settings → holder  |
| SC11 读          | `cat $HOME/read-target.txt`                    | `probe-read-ok`                                                        | ✅ home 可见          |
| SC11 写          | `touch $HOME/iknow-fs-probe-write.txt`         | `touch: cannot touch '...': Read-only file system`；宿主 `ls` 无该文件 | ✅ 拒写且不落盘       |
| SC12             | `echo x > $TMPDIR/probe.txt`                   | 落到 `<sessionFolder>/fence-tmp/probe.txt`（非 host `/tmp`）           | ✅ 会话 tmp           |
| SC13 翻转        | `/config fs global` → 同一条 `touch $HOME/...` | `TOUCH_OK`；宿主 `ls` 该文件存在                                       | ✅ 同会话内围栏真翻转 |
| SC13 fail-closed | `/config fs bogus`                             | `Usage: /config [status\|fs global\|fs workspace]`，档位不动           | ✅                    |
| 正交性           | Shift+Tab                                      | `mode: Default → Auto`，档位保持                                       | ✅ 权限轴独立         |
| SC13 持久化      | `/config fs global` / `fs workspace`           | settings.json 双向回写 `isolation.fsMode`                              | ✅                    |

判别力最强的两条：**同会话同命令**在两档下结果相反；**宿主落盘**（全局档真写出文件）与**宿主不落盘**（工作区档 EROFS）互为对照。

## 自动化验收

| 命令                                        | 结果                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `npx tsc --noEmit -p tsconfig.json`         | exit 0                                                                    |
| `npx vitest run`                            | 509 files / **7585 passed**, 0 failed（2 skipped）                        |
| `$HOME/.bun/bin/bun test tests/tui/`        | 1597 pass / 2 fail（**并发 flake**，见下）                                |
| `npm run lint:s5`                           | exit 0，`93 touched function(s) within baseline`，零 ✖                    |
| `npx tsx scripts/sandbox-probe.ts`          | all green（global 17/17, worktree 20/20, workspace 15/15, node-side 2/2） |
| `npx tsx scripts/ci-check-test-excludes.ts` | OK（61 个 bwrap 依赖文件全覆盖）                                          |

### 2 个 bun 失败为既有并发 flake（已对照基线排除）

`deps-tools.test.ts` 与 `app.test.tsx` 在整目录并发跑时 5s 超时；单独跑分别 6/6、18/18 全绿。基线对照：HEAD `900f042a` 的独立 worktree 上跑同一 `app.test.tsx` 耗时 33.55s、工作树 36.93s（差异在噪声内）——**无性能回归**，是测试自身 5s 预算 vs 装配耗时的既有矛盾，与本次改动无关。

## 未验证 / 风险

- `fs-mode-propagation-entry.test.ts` 用 **bwrap 替身**，只断言 fence argv；真 bwrap 的物理行为由 `bash-workspace-mode-fence.test.ts`（`it.skipIf(!hasBwrap())`）认证，两者互补。
- 工作区档下 `homeRoot` 缺失/为空 → **typed fail-loud**（不静默降级到可写 home）；该路径有单测覆盖，但真机未构造（真实入口 `homeRoot` 恒存在）。
- 子代理经 env 传档：父进程若为旧版本（不写该 env），子进程回落全局档 —— 这是既定的兼容语义（键缺席 = 同旧行为），非缺陷。
