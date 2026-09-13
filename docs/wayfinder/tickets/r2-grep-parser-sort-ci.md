# R2 grep 现行 parser / 排序 / CI 盲区

- Map: [ACI 文件/搜索工具面（整体升级决策）](../aci-file-tool-surface-map.md)
- Type: `wayfinder:research` (AFK)
- Status: resolved
- Blocked by: —

## Question

现行 `grep` 从 rg stdout 走到模型可见行，经过哪些假设？默认输出顺序稳不稳？`-C` / 裸 `--` 分隔行会不会被现有切分打碎？`limit` 是在什么顺序上取前 N？CI 是否跑 `grep` 测试与 description guard？

只陈述本仓代码 + 可复现命令事实。不写产品代码，不具名外部产品。

## Resolution

### 从 rg stdout 到模型可见行的链路（代码假设）

1. **spawn 形态**（`grep.ts:292-295,303-304`）：固定 `rg --line-number --no-heading --color never --max-columns=2000 --max-columns-preview [--ignore-case] -- <pattern> <searchRoot>`；`cwd = searchRoot`。未传 `-C` / `-A` / `-B` / `--sort`。
2. **stdout 切行**（`grep.ts:407-416`）：按 `\n` 拆行、去空行，每行进 `normalizeRipgrepLine`。
3. **行归一化契约**（`grep.ts:419-438`）：注释假定 rg 行为 `path:lineno:content`；实现用**第一个** `:` 切 path / rest，再在 rest 里找**第一个** `:` 切 lineno / content；path 相对 `searchRoot` 拼绝对路径再 `relative(workspaceRoot)`；行内容超 2000 字符截断（`truncateMatchContent`，`grep.ts:464-466`）。
4. **limit**（`grep.ts:141`）：`parseRipgrepOutput` 得到 `string[]` 后 **`slice(0, compiled.limit)`**，再 `join("\n")`。默认 200，硬顶 2000（`grep.ts:32-33,260-265`）。
5. **Node fallback**（`grep.ts:441-461,509-523`）：rg ENOENT 时递归 `readdir` 遍历（跳过 `node_modules`/`.git`），逐行 `RegExp.test`，输出同样拼成 `rel:lineno:content`。

### parser 按第一个 `:` 切的后果

| 情形                                                    | 后果                                                            | 证据                                                                                                                                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 行内多个 `:`（匹配行内容含冒号）                        | **安全**：只在 rest 的**第一个** `:` 后切 content，后续冒号保留 | `rg … foo colon.txt` → `colon.txt:1:foo:bar:extra colon in line`（exit 0）；parser 模拟 → `colon.txt:1:foo:bar:extra colon in line`                                                             |
| 路径段含 `:`                                            | **会错切**：第一个 `:` 被当 path/content 界                     | 代码 `grep.ts:425-428`；本仓正常走目录 `searchRoot`，rg 输出均带相对路径前缀（探针 `dir: "solo.ts:1:export const x = 1;"`）                                                                     |
| rg **单文件** CLI 输出 `lineno:content`（无 path 前缀） | **会错切**：`pathPart` 变成行号数字                             | `rg --line-number --no-heading --color never -- export src/harness/aci/tools/grep.ts` → `41:export type SpawnFn = (`（exit 0）；现行 handler 对目录搜索时 rg 始终带 `solo.ts:` 前缀（同上探针） |
| **无冒号行**                                            | **原样透传**，不走 `path:lineno:content` 契约                   | `grep.ts:426`：`colonIdx === -1` → `return line`                                                                                                                                                |
| 若将来加 `-C` 未改 parser                               | **上下文行/组分隔行会脏进输出**                                 | `rg -C1 needle` 多样本 → `./a.txt-2-context before`、`./a.txt:3:needle here`、裸行 `--`（exit 0）；上下文行无 `:`，parser 透传；`--` 亦透传                                                     |
| 裸 `--` 作为**匹配行内容**                              | **可解析**（三段的第三段）                                      | `rg … '^--$' dash.txt` → `2:--`（exit 0）；parser 模拟 `./a.txt:2:--` → `a.txt:2:--`                                                                                                            |

**现行未传 `-C`**（`grep.ts:292-295`），故生产路径不产生上下文行/组 `--`；扩上下文必须同票改 parser（与 G2 B 一致）。

### 默认输出顺序稳不稳

- **ripgrep 路径**：未 `--sort`；同机同 query **5 次 md5 相同**：
  - `for i in 1..5; rg --line-number --no-heading --color never -- export src/harness/aci/tools/grep.ts \| md5sum` → 五次均为 `aa0114eb02118fa537b81af3546bc383`
  - 多文件同理：五次均为 `e1e86a5da9ef9260fce741f7150b27fb`
  - **未证明**跨文件系统/并发 rg 版本下序不变；代码**无**排序步骤。
- **Node fallback**：`walk` 按 `readdir` 顺序（`grep.ts:513-519`），**无稳定序**；测试对 nested 结果 `.sort()` 后再断言（`grep.test.ts:139`）。
- **limit 切在什么顺序上**：rg stdout 行序（或 fallback 收集序）的前 N 条；**不是**路径字典序，除非 rg 恰好如此（`grep.test.ts:248-250` 断言 `flood.txt:1`…`:200` 即 stdout 前 200 行）。

### CI 是否跑 grep 测试与 description guard

| 套件                                                   | CI job                          | 是否执行                                             |
| ------------------------------------------------------ | ------------------------------- | ---------------------------------------------------- |
| `tests/harness/aci/tools/grep.test.ts`                 | `test-fast`                     | **否** — `.github/workflows/test.yml:85` `--exclude` |
| 同上                                                   | `test-full`（nightly / manual） | **否** — `.github/workflows/test.yml:201`            |
| `tests/harness/aci/tools/d9-description-guard.test.ts` | `test-fast`                     | **否** — `.github/workflows/test.yml:91`             |
| 同上                                                   | `test-full`                     | **否** — `.github/workflows/test.yml:207`            |

注释（`.github/workflows/test.yml:52-53,171-172`）把 `grep` 与 bash-sandbox 等一并标为「bwrap 物理执行类」排除；**grep 单测不 spawn bwrap**（本地 `npx vitest run tests/harness/aci/tools/grep.test.ts` → exit 0，27 passed）。`d9-description-guard` 注释（`d9-description-guard.test.ts:26-31`）称装配需 `requireBwrap`，故整文件 CI 排除；其中 **grep 的 description 仍被该 guard 覆盖**（全注册表 `reg.catalog.all()`，`d9-description-guard.test.ts:154-193`），只是 **CI 不跑**。

### rc=2 归因

- **代码**（`grep.ts:385-396`）：`code === 0 \|\| 1` → 解析 stdout；**`code === 2` → 一律** `ToolExecutionError(\`grep: invalid pattern: ${compiled.pattern}\`)`；不读 stderr 区分原因。
- **rg 实测**：非法正则 `rg '(unclosed' .` → exit **2**；不存在路径 `rg foo /nonexistent/path` → exit **2**；非法 flag `--nonexistent-flag` → exit **2**。
- **Node fallback**（`grep.ts:469-474`）：`new RegExp` 抛错 → 同形 `invalid pattern` 消息（与 rc=2 文案一致，非 rg rc）。
- **结论**：现行把 **所有 rg exit 2** 等同「非法 pattern」；对固定 argv 的误报面主要是 rg 内部/IO 类 exit 2，**不是**用户 pattern 语义。

### 本调查执行的只读命令（摘要）

- `rg` md5 稳定性（5×）、`-C1` 输出形态、非法 regex / 坏路径 exit code
- `npx vitest run tests/harness/aci/tools/grep.test.ts` → exit 0
- `/tmp/grep-r2-probe.mts`：`createGrepTool` 目录搜索 → `"solo.ts:1:…"`；`path: 'solo.ts'` → `spawn ENOTDIR`（`grep.ts:303` 把文件路径当 `cwd`）
