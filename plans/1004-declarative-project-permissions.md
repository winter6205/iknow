# Plan: #1004 声明式项目权限规则

**Goal:** 项目 `settings.permissions` 改为 `allow`/`ask`/`deny` 字符串列表，匹配合同见 spec；旧谓词 DSL fail-loud。
**Approach:** 先钉形态与评估序（ADR 已 flush）；再换加载/编译；Bash 与路径两族 matcher 分窗；最后迁本仓 JSON 与门禁形状。不改 hard-wall 层序，不合 hooks。
**Spec link:** `specs/declarative-project-permissions.md`
**ACR:** all-yes（本回合）

```
bounded-context-guardian: yes — 编译与匹配留在 harness permission；config 只做 permissions 段形状门禁；不把规则语言写进 session-api / hooks router。
defensive-contract-validator: yes — 空列表、旧 rule[]、残缺括号、未知工具 deny/ask、复合命令、路径逃逸/隐藏文件、项目 full_auto；加载失败 typed。并发不适用于构造期读文件。
error-handling-enforcer: yes — 旧形态与非法 defaultMode fail-loud 带示例；Write(path) 警告且不静默当 Edit；禁止空 catch 吞掉 deny。
complexity-anti-drift: yes — Bash 族与路径族分 matcher；加载只负责 schema+编译顺序，不把 policy 五步链扩成新轴。
minimal-change-verifier: yes — 单任务 #1004；不含 hooks 合并、不含用户层 permissions、不含新 PermissionMode 枚举值。
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion

**Out of scope:** 用户层 permissions；hooks 形态统一；新 mode 名；自动改写旧 JSON 的脚本。

**待写入:** flushed 2026-09-13（ADR-0090；CONTEXT **声明式权限规则**；ADR-0084 形态句；相关 spec/guide/wayfinder 指针）。

## Harvest

**Settled（inherits spec / ADR-0090）**

- 三档字符串；`Tool` / `Tool(specifier)`；deny → ask → allow。
- 模式名映射 ACI（Bash/Read/Edit/WebFetch + 字面工具名）。
- Bash：`*`、`:*`、词边界、复合命令分段、固定 wrapper 剥离。
- 路径：gitignore 风格；Read 覆盖读工具并挡同路径写；Edit 覆盖写工具。
- `defaultMode` 仅 `default`|`plan`；项目禁 `full_auto`。
- 旧 `rule[]` fail-loud；不双读。
- 层序、hard-wall、session、hooks、用户层不接 permissions：不变。

**Open for implementer**

- glob/gitignore 用自写还是已有依赖（无新 lockfile 则不必开依赖票）。
- `NormalRuleSpec.id` 的具体编码。
- Write(path) 警告走 `onWarn` 还是 stderr，只要可测。

> Contradicts ADR-0084「谓词语义不换成字符串列表」— worth reopening because 入库后 DSL 不可维护；已由 ADR-0090 取代该句。
> Contradicts `specs/agent-control-surface.md` Slice B Out of spec「不另做 allow 字符串列表」— 该句已被本 spec amend。

## Tasks (ordered by dependency)

1. **合同：声明式列表取代谓词 DSL** — tag: `[decision]`
   - **Inherits:** spec Does；ADR-0090。
   - **Surface:** `docs/adr/`、`docs/CONTEXT.md`
   - **Acceptance:** ADR-0090 accepted；CONTEXT 有 **声明式权限规则**；ADR-0084 不再把谓词 DSL 当现行形态。
   - Status: [x] done（本回合 persist）

2. **加载：新 schema + 旧形态 fail-loud + 编译三档** — tag: `[implementation]`
   - **Inherits:** 空数组合法；`rule`/`schema_version` typed fail 带示例；编译序 deny→ask→allow；无 id/reason 字段。
   - **Surface:** harness permission 加载、`src/config` 项目 permissions 形状门禁
   - **Acceptance:** 新形态能加载成 project 层规则；旧形态抛 typed 错；config 门禁不再只认 `schema_version`+`rule`。`npx vitest run tests/harness/permission/project-settings.test.ts tests/config/settings.test.ts` 退出 0。
   - Status: [ ] pending
   - [blocks: T1]

3. **Bash specifier 匹配** — tag: `[implementation]`
   - **Inherits:** spec Bash 条（`*`、`:*`、词边界、复合分段、wrapper 列表）。
   - **Surface:** harness permission
   - **Acceptance:** spec SC4 可测；`timeout 30 git status` 能命中 `Bash(git status:*)`。相关 vitest 退出 0。
   - Status: [ ] pending
   - [blocks: T2]

4. **Read/Edit 路径与工具族** — tag: `[implementation]`
   - **Inherits:** spec 路径条 + Read/Edit 映射 + Read deny 挡写 + Write(path) 不参与路径检查。
   - **Surface:** harness permission
   - **Acceptance:** spec SC5；`Read(.env)` ≡ `Read(**/.env)`；deny `secrets/**` 命中嵌套目录，allow `src/**` 不命中 `vendor/pkg/src`。相关 vitest 退出 0。
   - Status: [ ] pending
   - [blocks: T2]
   - [parallel] 可与 T3 同窗

5. **defaultMode 启动种子** — tag: `[implementation]`
   - **Inherits:** 仅 `default`|`plan`；`full_auto` fail-loud；CLI/env/会话切换覆盖文件。
   - **Surface:** 权限 mode 装配（cli / serve 启动种子）
   - **Acceptance:** spec SC6；无该字段时启动 mode 与今日默认一致。
   - Status: [ ] pending
   - [blocks: T2]

6. **迁本仓项目 settings** — tag: `[implementation]`
   - **Inherits:** 能表达 echo allow 与 `.ssh` deny；可加 pem glob。
   - **Surface:** 仓库 `.iknow/settings.json`
   - **Acceptance:** 文件无 `rule`；加载走新路径；spec SC1 中与本仓文件相关的断言绿。
   - Status: [ ] pending
   - [blocks: T3, T4]

## Code review phase

全部 implementation bullets 落地后跑一轮 `code-review`；`GATE: BLOCKED` 则下一槽 `review-report-repair`，再 `verification-before-completion`。
