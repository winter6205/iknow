# Plan: #141 工具层重写（6 工具集 + executor 加固 + 封顶 20000）

**Issue**: winter6205/iknow#141（wayfinder:task，纯执行票）
**设计真值**: #140 Resolution + `docs/adr/0004-tool-layer-six-tool-set.md` / `0005-executor-hardening-stop-signal-json-whitelist.md` / `0006-tool-output-capping-hard-truncate-20000.md` + `docs/CONTEXT.md` 契约 X / Y1 术语
**Tracker**: GitHub issue #141 为 umbrella ticket（gh CLI 可用）；本票同 session 连续执行，不另建子 issue，逐 bullet 进度以 plan 文件 + commit 追踪（记录在案的偏离：一次性执行票，子 issue 无收益）。
**执行分支**: `worktree-141-tool-layer-rewrite`（自 master）；1 bullet = 1 commit。

## 摸底结论（explorer 汇总，2026-08-04）

- executor 基础层在 `src/harness/tools/executor.ts`（155 行）；"只等不杀"在 `executor.ts:88-104`（`Promise.race` 后 handler 后台继续跑）；`isJsonCompatible`/`safeContent` 为模块私有（`executor.ts:27-48`），宽松递归检查、无截断。
- loop-engine `runToolPhase`（`loop-engine.ts:431-435`）把外层 signal 原样透传 executor；停止判定依赖结果 message 恰为 `"timeout"` / `"cancelled"`（`computeToolStopFlags`，`loop-engine.ts:395-408`）——字符串契约不可破坏。
- CLI 装配 `src/cli/runtime.ts:87-93` 列举 5 个 PROTOTYPE 工具；装饰链 `createAciRegistry → createExecutor → createAciExecutor(policy)`。
- 旧工具 5 件：`fs_search` / `fs_view` / `fs_edit` / `shell_exec` / `context_manager`（`src/harness/aci/tools/`，共 717 行）。引用面 ~200+ 处：`runtime.ts`、`aci/demo.ts`、`aci/permission.ts` 注释、7 个 `tests/harness/aci/*.test.ts`、`docs/architecture.md`、`docs/drafts/aci-prototype-contract.md`。`.evals/`、`scripts/i*.ts` 零工具名引用（已验证）。
- 共享辅助缺失：`isWithinRoot` 被复制 3 份、截断 2 种风格；`lintPatch`（poka-yoke 状态机）仅 `fs-edit.ts:38-128` 一份且已 export。
- `npm test` = `vitest run`（tests/**，forks 池）；typecheck = `tsc --noEmit`。

## 编译耦合分层（子代理拆分依据）

```
L0  executor 基础层（T2 → T3，串行，同一文件）
L0' 共享 helpers 层（T4，与 L0 文件不相交，可并行）
L1  6 工具（T5..T10，仅依赖 L0'，文件两两不相交 → 全并行）
L2  装配切换（T11，依赖 L1 全部；expand 完成点）
L3  旧工具删除 + 引用收口（T12，依赖 L2；contract 完成点）
```

---

## Tracer bullets

#### T1. `[decision]` ADR 未决实施项裁定

- **Affects**: 本 plan 文件（无代码）
- **Acceptance**: 以下 7 条裁定全部落档于本节，后续 bullet 只能引用不得再发明：
  1. **executor 截断标记格式**（ADR-0006 只规定要件，未给模板）：统一 marker 追加于截断文本尾部，格式
     `…[executor: 输出超长已截断，原长 {originalLength} 字符，保留 {keptLength} 字符；如需更多信息，用更精确的输入重新调用]`。
     marker 计入 20000 预算：`keptLength = 20000 - marker.length`（保证"经 executor 后不超过 20000"，ADR-0006 L34）。
     截断作用于 executor 自行序列化后的文本（契约 X：自序列化→自测量→自截断→自合成标记）。
  2. **JSON 白名单拒绝文案**：沿用现有 `[executor: payload not JSON-compatible]`（`executor.ts:35`），最小爆炸半径；被拒 ≠ 调用失败（提示替换，ADR-0005 L22）。
  3. **null 裁定**：允许 null（JSON 原生值；不在 ADR-0005 拒绝清单；现状即允许）。白名单 = string / boolean / 有限 number / null / Array / 纯对象（原型 === Object.prototype）。
  4. **edit_file 错误策略**：old_str 未找到 → 失败消息 `[edit_file] old_str not found: <path>`；replace_all=false 且多处匹配 → 失败消息 `[edit_file] old_str matched N times, provide more context or set replace_all`。写入前 linter 不配对 → 拒绝且不得落盘。
  5. **read_file 边界文案**：NUL/二进制 → `[read_file] binary file rejected: <path>`；>1MB → `[read_file] file exceeds 1MB limit, locate with grep then read precisely with offset/limit`。
  6. **bash 过渡形态**：permission 双层保留（ACI decorator policy + 工具内 allowlist/dangerous 检查，与旧 shell-exec 同构），policy `byName` 键 `shell_exec` → `bash`；沙箱接口预留注释指向 #123。timeout 参数不暴露给模型（schema 无 timeout 字段）。
  7. **行号/输出格式**：read_file 每行 `行号.padStart(6) + "\t" + line`；grep 每行 `相对路径:行号:内容`；glob 每行一个字母序相对路径。

#### T2. `[implementation]` executor 加固 A：统一停止信号（推翻"只等不杀"）

- **Affects**: `src/harness/tools/executor.ts`、`tests/harness/tools/executor.test.ts`
- **Acceptance**:
  - `runOne` 为每次调用构造统一 signal（`AbortSignal.any([外层 signal, 超时 child])`），超时到点触发 `child.abort()` 并返回 message 恰为 `"timeout"`；外层 abort 返回恰为 `"cancelled"`（保持 loop-engine 字符串契约）。
  - 新增测试：超时触发后 handler 收到的 `ctx.signal.aborted === true`（signal 递达证明，不再只等不杀）；取消路径同样递达；无 timeoutMs 时仅透传外层 signal。
  - `npx vitest run tests/harness/tools/executor.test.ts tests/harness/loop-engine.test.ts` 绿 + `npm run typecheck` 绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T3. `[implementation]` executor 加固 B：JSON 白名单收紧 + 20000 兜底截断（契约 X）

- **Affects**: `src/harness/tools/executor.ts`、`tests/harness/tools/executor.test.ts`
- **Acceptance**:
  - `isJsonCompatible` 收紧为递归白名单：拒 NaN/±Infinity（不依赖 JSON.stringify 静默 null 化）、Date（不走 toJSON）/Map/Set/类实例（原型 !== Object.prototype）、循环引用（WeakSet 防环不栈溢出）；null/有限数字/string/boolean/Array/纯对象放行（T1-3）。
  - 被拒 → 提示文字替换（`kind: "ok"`，不判失败）。
  - 序列化后 >20000 字符 → 硬截断 + T1-1 marker，总长 ≤ 20000；不落盘。
  - 契约 X 测试：handler 返回 payload 内塞 `{truncated: true, total: 999}` → executor 忽略声称字段、按实际序列化长度重新测量并照常兜底。
  - `npx vitest run tests/harness/tools/executor.test.ts` 绿 + `npm run typecheck` 绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T4. `[implementation]` 共享 helpers 层 `[parallel]`（与 T2/T3 文件不相交）

- **Affects**: 新增 `src/harness/aci/tools/helpers.ts`、`tests/harness/aci/tools/helpers.test.ts`；`src/harness/aci/tools/fs-edit.ts`（lintPatch 迁移后 re-export，保持旧测试绿）
- **Acceptance**:
  - `resolveWithinRoot(root, path)`：resolve + realpath + containment（symlink 逃逸拒绝），单一实现替换 3 份复制。
  - `truncateByCodePoint(s, max)`：按 code point 截断（`Array.from`/codePointAt，不拆 surrogate）。
  - `spawnTreeKill` 语义封装：detached spawn + 监听 AbortSignal → SIGTERM 进程组（负 pid）→ 2s 未退 → SIGKILL；供 bash/grep 复用。
  - `lintPatch` 从 fs-edit.ts 迁入 helpers（原处 re-export，`tests/harness/aci/tools-mutating.test.ts` import 不变）。
  - 各 helper 单测覆盖：正常/失败/边界（symlink 越界、surrogate 边界字符、进程树杀死——可用 `sh -c "sleep 30 & wait"` 类子进程树验证）。
  - `npx vitest run tests/harness/aci/tools/helpers.test.ts tests/harness/aci/tools-mutating.test.ts` 绿 + typecheck 绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T5. `[implementation]` read_file `[parallel]` `[blocks: T11]`

- **Affects**: 新增 `src/harness/aci/tools/read-file.ts`、`tests/harness/aci/tools/read-file.test.ts`
- **Acceptance**: 无状态工厂（无闭包共享 cursor）；schema `{path, offset?(默认0，0基), limit?(默认200，上限2000)}`；读前 stat >1MB 拒绝（T1-5 文案）；NUL 检测拒绝；resolve+containment；返回纯字符串带行号（T1-7）；offset 越界返回空串而非报错；测试覆盖 正常/失败/边界/二进制拒绝/symlink 越界。`npx vitest run tests/harness/aci/tools/read-file.test.ts` 绿 + typecheck 绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T6. `[implementation]` write_file `[parallel]` `[blocks: T11]`

- **Affects**: 新增 `src/harness/aci/tools/write-file.ts`、`tests/harness/aci/tools/write-file.test.ts`
- **Acceptance**: schema `{path, content, create_directories?(默认 true)}`；创建或整体覆写；写入前 lintPatch 不配对即拒绝且不落盘；resolve+containment；测试覆盖 正常新建/覆写/目录自动创建/目录缺失+create_directories=false 失败/linter 拒绝后文件未变/symlink 越界。`npx vitest run tests/harness/aci/tools/write-file.test.ts` 绿 + typecheck 绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T7. `[implementation]` glob `[parallel]` `[blocks: T11]`

- **Affects**: 新增 `src/harness/aci/tools/glob.ts`、`tests/harness/aci/tools/glob.test.ts`
- **Acceptance**: schema `{pattern, path?, limit?(默认200，上限5000)}`；真 glob 模式（非子串匹配）；`rg --files` 可用则子进程、否则 Node fallback（两条路径均有测试，rg 用 mock/spy 或环境探测）；空 pattern 不退化为"匹配所有"（T1-7、ADR-0004 L30）；返回字母序相对路径纯字符串；signal 递达（纯本地工具，无可杀对象）；测试覆盖 正常/无匹配/limit 截断/rg 缺失 fallback/空 pattern 拒绝。`npx vitest run tests/harness/aci/tools/glob.test.ts` 绿 + typecheck 绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T8. `[implementation]` grep `[parallel]` `[blocks: T11]`

- **Affects**: 新增 `src/harness/aci/tools/grep.ts`、`tests/harness/aci/tools/grep.test.ts`
- **Acceptance**: schema `{pattern(正则), path?, ignoreCase?(默认 false), limit?(默认200，上限2000)}`；ripgrep 子进程 + Node fallback（双路径测试）；返回 `路径:行号:内容` 纯字符串（相对路径）；监听 ctx.signal → 杀 rg 子进程（T4 spawn 语义：SIGTERM→2s→SIGKILL，测试用慢速 rg 参数或 stub 子进程验证 abort 后子进程不存活）；测试覆盖 正常/大小写敏感默认/ignoreCase/正则/无匹配/limit/取消杀进程/rg 缺失 fallback。`npx vitest run tests/harness/aci/tools/grep.test.ts` 绿 + typecheck 绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T9. `[implementation]` edit_file `[parallel]` `[blocks: T11]`

- **Affects**: 新增 `src/harness/aci/tools/edit-file.ts`、`tests/harness/aci/tools/edit-file.test.ts`
- **Acceptance**: schema `{path, old_str, new_str, replace_all?(默认 false)}`；替换用 split().join()（测试断言 `$&` 不被特殊化）；replace_all=false 多匹配 → T1-4 拒绝文案；未找到 → T1-4 文案；写入前 lintPatch（对 new_str 替换后的全文），不配对不落盘；resolve+containment；测试覆盖 正常单处/replace_all/未找到/多匹配拒绝/`$&` 安全/linter 拒绝/symlink 越界。`npx vitest run tests/harness/aci/tools/edit-file.test.ts` 绿 + typecheck 绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T10. `[implementation]` bash `[parallel]` `[blocks: T11]`

- **Affects**: 新增 `src/harness/aci/tools/bash.ts`、`tests/harness/aci/tools/bash.test.ts`
- **Acceptance**: schema `{command}`（无 timeout 字段，T1-6）；detached spawn + 负 pid 进程树；监听 ctx.signal → SIGTERM→2s→SIGKILL（测试：`sh -c 'sleep 30'` 类命令在 abort 后子进程树不存活）；stdout/stderr 各按 code point 截断 12000（T4 helper）；返回唯一结构化例外 `{code, stdout, stderr}`（Y1b）；工具内 allowlist/dangerous 双层保留（复用 permission.ts，T1-6）；沙箱 hook 接口预留注释指向 #123；测试覆盖 正常/非零退出码/allowlist 拒绝/危险命令拒绝/截断边界/取消杀进程树/超时经 executor。`npx vitest run tests/harness/aci/tools/bash.test.ts` 绿 + typecheck 绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T11. `[implementation]` 装配切换：6 工具注册进 CLI（expand 完成点）`[blocks: T12]`

- **Affects**: `src/cli/runtime.ts`、`src/harness/aci/demo.ts`、`src/harness/aci/permission.ts`（byName 键与注释）、`tests/harness/aci/permission.test.ts`、`tests/harness/aci/security-bypass-replay.test.ts`（policy 键同步）、`tests/cli/_fixtures.ts`（若含工具装配）
- **Acceptance**:
  - `runtime.ts` 装配恰为 6 新工具（bash/read_file/grep/glob/edit_file/write_file），旧 5 工具不再被产品路径 import（本 bullet 暂留旧文件，T12 删）。
  - `permission.ts` policy `byName.shell_exec` → `byName.bash`；permission/security-bypass 测试同步且绿。
  - `aci/demo.ts` 迁移到 6 工具场景（demo.test.ts 同步）。
  - `npx vitest run tests/harness/aci tests/cli tests/cli-session.test.ts` 绿 + typecheck 绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T12. `[implementation]` 旧 5 工具删除 + 引用收口（contract 完成点）

- **Affects**: 删除 `src/harness/aci/tools/{fs-search,fs-view,fs-edit,shell-exec,context-manager}.ts`；删除/重写 `tests/harness/aci/{tools-readonly,tools-mutating}.test.ts`（行为覆盖已由 T5-T10 新测试承接，保留 lintPatch 相关断言迁移至 helpers 测试）；`tests/harness/aci/aci-registry.test.ts`、`aci-executor.test.ts` 中旧工具名 fixture 换新名；`docs/architecture.md` 工具表更新；`docs/drafts/aci-prototype-contract.md` 标注已毕业（历史原名保留）
- **Acceptance**:
  - `grep -rn "fs_search\|fs_view\|fs_edit\|shell_exec\|context_manager\|createFsSearchTool\|createFsViewTool\|createFsEditTool\|createShellExecTool\|createContextManagerTool" src/ tests/ --include="*.ts"` 输出为空（docs/archive 与 docs/adr 历史叙述除外，ADR 是设计真值不改写历史）。
  - `npm test` 全绿（32+ 测试文件，unit + harness + session-api + web）。
  - `npm run typecheck` 绿；`bash .evals/run.sh`（fast tier）绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## 执行编排（leader 视角）

| 波次 | 内容                                                                             | 并行性                                                               |
| ---- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 0    | ACR 预检（architecture-change-reviewer 5 判决）                                  | 实施前置门                                                           |
| A    | T2→T3（同一 executor 子代理，2 commits） ∥ T4（helpers 子代理）                  | 2 并行                                                               |
| B    | T5/T6/T7/T8/T9/T10 六个工具子代理                                                | 6 并行（文件两两不相交；commit 由 leader 顺序执行避免 index 锁竞争） |
| C    | T11 装配子代理                                                                   | 1                                                                    |
| D    | T12 收口子代理                                                                   | 1                                                                    |
| E    | 最终 code-review（spec + standards 双轴）+ verification-before-completion + push | leader 编排                                                          |

## 验证（计划完备性）

1. tracer bullets 12 条，编号齐全（见上）
2. 每条 1 个二元验收 + 1 个 tag（T1 decision，其余 implementation）
3. 依赖排序：T2→T3（同文件串行）；T4 ∥ {T2,T3}；T5..T10 依赖 T4；T11 依赖 T5..T10；T12 依赖 T11
4. 并行标记：T4/T5/T6/T7/T8/T9/T10 均 `[parallel]`
5. 每个 `[implementation]` bullet 均带 Per-ticket loop 行

成功 = plan has 12 tracer bullets, each with binary acceptance + one [decision]|[implementation] tag

---

## Serve-path extension（#141 后续记录，code-review 裁决 2026-08-05）

T11 装配只覆盖 CLI（`src/cli/runtime.ts`）；serve 路径 `src/session-api/hub.ts::ensureDeps`
原停在 echo/get_time stub（022 时 serve 切 harness 的遗留）。本扩展把装配提取到
`src/harness/build-engine.ts`（SSOT）：CLI `buildHarnessEngine` 与 serve `ensureDeps`
共享同一份 8 件 ACI 工具集，serve 由此获得 bash/read_file 等文件系统与网络工具。

决策：SSOT 提取 + serve 接入（code-review 记录，非 T11 原声明范围；避免 CLI/serve
工具集漂移）。sandboxRoot 默认 `process.cwd()` 对 serve 是长驻进程假设——见 ticket
（serve sandboxRoot 显式化，与 Web 工具清单端点同 backlog）。
