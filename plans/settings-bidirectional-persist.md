# settings.json 双向持久化 — plan（反向通道：运行时 /thinking /effort → 写回 settings.json）

> **Tracker**: local markdown（fallback）—— 无 GitHub remote 操作授权；tracer bullets 以本文件 + 独立分支 / 串行 commit 呈现。
> **来源**: 用户在 PR #413 合并后追问「打开了思考为什么 settings.json 没变化」→ 已澄清现有热更新是**单向**（文件 → 运行时），面板是 in-memory override 不落盘 → 用户明确要求**双向更新**（运行时面板改动 → 写回 settings.json）。SSOT = `docs/llm-config-quickstart.md` §3.1 + `src/config/settings.ts`（merge 优先级）+ PR #413 的 `settings-watch` / `env-loader`。
> **目标**: `/thinking`（开关）与 `/effort`（档位）面板在 **Esc 保存退出**时把改动写回 settings.json（user 级或 project 级），写回后**自身 fs.watch 不回环**（self-write 哨兵跳过 reload），外部改动热更新行为不变（PR #413 单向通道保持）。失败以 notice 呈现，不 crash TUI。

## 边界 / 范围

### In scope

- **写回触发点**：仅 `Esc` 保存退出（app.tsx thinking/effort 两个 `case "commit"`）。Enter 固定 / 面板内预览不落盘（与 PR #413 面板语义一致）。
- **写回字段**：仅 `llm.thinking`（`"off" | "adaptive"`）+ `llm.thinkingEffort`（五档，auto 时删除该字段）。**不触碰** apiKey / model / fallback / maxTurns / compress / secrets 等其它字段（parse → merge → write，绝不整文件覆盖）。
- **目标文件选择**：project 级 `<cwd>/.iknow/settings.json` 存在 → 写 project（它本就覆盖 user，写 user 等于无效）；不存在 → 写 user 级 `~/.iknow/settings.json`。与 settings.ts 的「project over user」merge 优先级一致。
- **self-write 哨兵**：写回后向 watcher 登记「该路径 + 写入内容哈希」；watcher onChange 时若命中 → 跳过 reload（不回环）；未命中（外部改动）→ 照常 reload。一次性消费（LRU 容量 8）。
- **原子写**：tmp 同目录 + rename；chmod 600（settings 含 apiKey）；父目录缺失 mkdir -p。
- **失败呈现**：写回失败（EACCES / 磁盘满 / JSON 序列化失败）→ TUI notice 提示，不 crash，不阻塞已有 state 更新。

### Out of scope（不动）

- **PR #413 单向通道**：settings-watch / env-loader / hub 热重建 / run.tsx envVersion 刷新全部保留原行为。
- **serve / ask 入口**：本次只接 TUI chat 路径（用户当前问的主路径）；persist-settings 是纯函数模块，后续 serve / ask 可复用（不在本 plan 接线）。
- **其它字段持久化**：未来若要把 model / maxTurns 等面板写回，复用 writeSettingsMerge 原语（本 plan 只暴露 thinking 面）。
- **settings-watch 契约**：仍是「纯文件事件 → 节流回调」，不解析文件内容（self-write 判定放 env-loader / persist-settings 侧）。

### 关键设计决策（已固化，implementer 不再纠结）

1. **不引入新 npm 依赖**（避免 lockfile 变更）。哈希用 Node 内置 `node:crypto`（sha256）；写盘用 `node:fs/promises`。
2. **self-write 用「内容哈希精确匹配」而非「时间 cooldown」**：cooldown 会吞掉写回后 100ms 内的真实外部改动（竞态），哈希匹配只吞「内容 = 我刚写的」这一条。一次性消费：命中即从 LRU 移除。
3. **写回不重建 adapter**：写回 → 哨兵吞掉 reload → 当前 env / adapter 不动。用户体感 = 面板 Esc 后下一条消息继续用面板里的 override（per-turn），settings 文件已持久化供下次启动。**不触发** env reload（与「外部改文件才 reload」语义区分）。
4. **merge 是原始 JSON 对象，不是解析后的 IknowSettings**：IknowSettings 是深 frozen 且丢弃非法字段；写回必须基于原始 raw JSON（保留用户所有字段，只改 thinking 两键）。
5. **/thinking 面板只写 `llm.thinking`**（不动 thinkingEffort，档位保留记忆）；**/effort 面板写 `llm.thinking="adaptive"` + `llm.thinkingEffort`（auto → 删除字段）**。最小改动：只持久化用户实际改的那个面板的字段。
6. **thinkingEffort auto（""）在 settings 中无意义**（schema 只接受五档）→ 写 `thinking:"adaptive"` 且删除 `thinkingEffort` 键（缺省 = 自适应，与 env.ts 的 defaultEffort="" 语义一致）。
7. **并发写类边界 + 覆盖率门槛（ACR blocker fix）**：
   - **5 类边界全覆盖（per defensive-contract-validator）**：
     - empty → T1 §"新文件起步"；
     - negative / illegal → T1 §"merge 对非法 patch 值防御"；
     - overflow → T2 §"LRU 容量 8"；
     - concurrent → **新增 T1 并发用例：串行 await 两次 persistThinkingChanges，断言最终内容 = 第二次 patch + 第一次的其它字段全保留**（fs 事件循环天然串行 fire-and-forget，但读-改-写窗口在同文件同进程下被 Node fs 操作序列化）；真并行（多进程 / 多 iknow 实例同时写）→ lost-update 窗口存在，**plan 决策：不加文件锁，文档化限制**（用户场景：单 iknow 进程，TUI Esc 串行触发；multi-instance 写同一 settings.json 不在产品路径内）；
     - exception → T4 §"失败呈现" + T1 §"EACCES / 磁盘满" 模拟。
   - **覆盖率门槛**：persist-settings.ts / env-loader.ts self-write 段 / committedThinkingPatch 这三个新模块要求 **100% line + 100% branch**（纯函数 + 路径枚举有限，可强约束）；app.tsx / run.tsx 改动按既有 ≥80% line / ≥70% branch 项目基线（沿用 ACR 默认）。`vitest --coverage` 在最终验收跑一次确认。

## Tracer bullets（顺序严格，1 bullet = 1 commit）

### T1. `[implementation]` persist-settings 纯函数模块

- **Affects**: `src/config/persist-settings.ts`（新建）、`tests/config/persist-settings.test.ts`（新建）
- **接受**: 导出：
  - `resolveThinkingSettingsPath(opts: { cwd?, home? }) → string`：project 级文件存在 → 其路径；否则 user 级路径。（对齐 settings.ts 用 `os.homedir()` + `process.cwd()`。）
  - `persistThinkingChanges(filePath, patch: { thinking?: "off" | "adaptive"; thinkingEffort?: ThinkingLevel | null }) → Promise<{ path: string; bytes: string }>`：读 raw JSON（文件不存在 / 坏 JSON → 按空对象起步），在 `llm` 层合并 patch（`thinkingEffort: null` → 删除该键；`llm` 缺失 → 创建；其它字段一律原样保留），原子写（同目录 tmp + rename，tmp chmod 600，父目录 mkdir -p），返回写入的完整 bytes 字符串供 self-write 登记。
  - `hashSettingsContent(bytes: string) → string`：sha256 hex（供 env-loader 哨兵比对）。
  - 内部 `mergeThinkingPatch(raw, patch)` 独立导出（纯函数，单测友好）。
- **验收**: `bun test tests/config/persist-settings.test.ts` 全绿（≥10 用例）。覆盖：
  - 新文件起步：llm 缺失 → 写入 `{llm:{thinking:"adaptive",thinkingEffort:"high"}}`。
  - 已有文件：保留 apiKey / model / fallback / secrets 等全部原字段，只改 thinking 两键。
  - `thinkingEffort: null` → 删除键（auto 语义），不残留 ""。
  - 坏 JSON 起步（不覆盖用户文件，从空对象合并后写回）。
  - 原子性：写回后文件是完整 JSON，可 parse，无 `.tmp` 残留。
  - 权限：tmp 文件 mode 0600（rename 前断言）。
  - 父目录缺失（tmp HOME 无 .iknow）→ mkdir -p 后成功写。
  - merge 对非法 patch 值防御（thinking 非 off/adaptive → throw / thinkingEffort 非五档且非 null → throw）。
  - resolveThinkingSettingsPath：project 存在 → project；不存在 → user。
  - hashSettingsContent：同串同哈希，异串异哈希。
  - **并发类（ACR blocker fix）**：串行 await 两次 persistThinkingChanges（先 thinking=adaptive/effort=high，再 thinking=off）→ 最终文件 = 第二次 patch（thinking:"off"）+ 第一次写入的 effort 字段按第二次 merge 语义保留（second 不传 effort → 保留 first 的 effort），且 apiKey/model/secrets 全程原样。断言无 `.tmp` 残留、可 parse。
  - **异常类补充**：写入目标路径不可写（chmod 0555 目录 + EACCES）→ persistThinkingChanges reject，错误消息含路径（供 TUI notice）。
- **commit**: `feat(config): settings.json 反向持久化 — persist-settings 纯函数模块 (T1)`
- **依赖**: 无。

### T2. `[implementation]` env-loader self-write 哨兵

- **Affects**: `src/config/env-loader.ts`（修改）、`tests/config/env-loader.test.ts`（修改）
- **接受**: `createEnvLoader` 返回值新增 `markSelfWrite(path: string, bytes: string): void`。onChange 处理器在 reload 前先判定：读当前文件 bytes → 与 self-write LRU（容量 8，`Map<path, Set<sha256>>`）比对 → 命中则**移除该条并 skip reload**；未命中照常 reload。外部改动（内容 ≠ 任何登记过的自写）→ 正常 reload，行为与 PR #413 完全一致。
- **注意**：onChange 触发时文件可能仍在 rename 中（同目录 tmp rename）；读文件失败（ENOENT）→ 按未命中走 reload（保守，不吞外部事件）。
- **验收**: `bun test tests/config/env-loader.test.ts` 全绿（既有 + ≥4 新用例）。覆盖：
  - markSelfWrite 后模拟自写 → onChange 触发但**不 reload**（subscriber 不被调，reload 计数不变）。
  - 外部写（内容不同）→ 照常 reload。
  - 一次性消费：两次相同自写 → 只吞第一次（第二次按外部处理）。
  - LRU 容量 8：第 9 条挤掉最旧，旧条不再命中。
  - 兼容：不调用 markSelfWrite 时行为与 PR #413 完全一致（既有用例回归）。
- **commit**: `feat(config): EnvLoader self-write 哨兵 — 写回不回环 (T2)`
- **依赖**: T1。

### T3. `[implementation]` thinking-picker commit payload 上提

- **Affects**: `src/tui/thinking-picker.tsx`（修改）、`tests/tui/thinking-picker.test.tsx`（修改）
- **接受**: 新增纯函数（或扩展 reducer 返回）把面板 commit 结果投影成**可持久化 payload**：
  - `committedThinkingPatch(state: ThinkingPickerState) → { thinking: "off" | "adaptive"; thinkingEffort?: level | null } | null`：thinking 面板 commit → `{ thinking: enabled ? "adaptive" : "off" }`（不动 effort）；effort 面板 commit → `{ thinking: "adaptive", thinkingEffort: autoOn ? null : indexToEffort(currentIndex) }`。null = 无持久化需要（当前无此分支，防御）。
  - 纯函数无 React 依赖，可独立单测。**不动** computeThinkingOverride / reduceThinkingSwitchKey / reduceThinkingEffortKey / 渲染。
- **验收**: `bun test tests/tui/thinking-picker.test.tsx` 全绿（既有 + ≥3 新用例）。覆盖：
  - thinking 面板 enabled=true → `{thinking:"adaptive"}` 无 effort 键。
  - thinking 面板 enabled=false → `{thinking:"off"}`。
  - effort 面板 autoOn=true → `{thinking:"adaptive", thinkingEffort:null}`。
  - effort 面板 concrete 档 → `{thinking:"adaptive", thinkingEffort:"high"}`（对 5 档各一或抽样）。
  - 既有 commit 语义（Esc 写 state）测试回归全绿。
- **commit**: `feat(tui/thinking-picker): commit payload 上提 — 可持久化投影 (T3)`
- **依赖**: 无（纯函数，与 T1/T2 无共享状态；但写回接线依赖 T1/T2 的 API，payload 本身独立）。

### T4. `[implementation]` app.tsx 接入持久化 + run.tsx 装配

- **Affects**: `src/tui/app.tsx`（修改）、`src/tui/run.tsx`（修改）、`tests/tui/app.test.tsx`（修改）
- **接受**:
  - **app.tsx**: `TuiAppProps` 新增可选 `onPersistThinking?: (patch: { thinking: "off" | "adaptive"; thinkingEffort?: level | null }) => Promise<{ ok: true } | { ok: false; reason: string }>`。thinking/effort 两个 `case "commit"` 里：照旧 `setThinkingEnabled` / `setThinkingEffort` + 关闭面板，随后 `void props.onPersistThinking?.(committedThinkingPatch(state))` —— fire-and-forget，`.then`/`.catch` 里失败 → `setNotice({ lines: ["思考设置已生效（本次会话），但写回 settings.json 失败：..."] })`；成功可不发 notice（或轻提示，由 implementer 按现网 notice 习惯定）。**用 committedThinkingPatch 从当前 panel state 投影，不在 handler 里手拼**（SSOT）。
  - **run.tsx**: 装配 `persistThinking = async (patch) => { const path = resolveThinkingSettingsPath({ cwd, home }); const { bytes } = await persistThinkingChanges(path, patch); envLoader.markSelfWrite(path, bytes); return { ok: true }; }`，失败 catch → `{ ok: false, reason }`。作为 `onPersistThinking` prop 传给 TuiApp。
  - **校验**：`bun test tests/tui/app.test.tsx` 全绿（既有 + ≥2 集成用例：mock onPersistThinking 断言 Esc commit 后被调 + 失败时 notice 出现）。`bun test tests/config/` + `tests/tui/` 全绿。
- **commit**: `feat(tui): /thinking /effort Esc 写回 settings.json — app/run 接线 (T4)`
- **依赖**: T1 + T2 + T3。

### T5. `[implementation]` 文档 + CLAUDE.md

- **Affects**: `docs/llm-config-quickstart.md`、`CLAUDE.md`、`CHANGELOG.md`
- **接受**:
  - `docs/llm-config-quickstart.md`：§3.1 热更新语义澄清处补「双向」段落：面板 Esc → 写回 settings.json（project 存在写 project，否则 user）；写回不回环（self-write 哨兵）；失败保留 in-memory override + notice。
  - `CLAUDE.md`：「Settings 热更新」那行把「不写回 settings」改为「面板 Esc 会写回 settings.json（project 优先），self-write 哨兵防止回环」。
  - `CHANGELOG.md` 增一条（feat / 行为变更）。
- **commit**: `docs(settings): 双向持久化语义落地 — quickstart + CLAUDE.md + CHANGELOG (T5)`
- **依赖**: T4。

### T6. `[implementation]` smoke 真值端到端验证

- **Affects**: 新建 `scripts/i413-bidirectional-settings-smoke.ts`、`package.json`（`probe:settings-bidir`）
- **接受**: 端到端真值（临时 HOME / cwd，不碰真实 `~/.iknow/settings.json`）：
  - A 组：写回正确性 —— 构造含 apiKey+model 的 settings.json → persistThinkingChanges(thinking=adaptive, effort=high) → 读盘断言 thinking/thinkingEffort 在 + 其它字段原样保留 + mode 0600 + 无 .tmp 残留。
  - B 组：self-write 不回环 —— 起 EnvLoader（注入 tmp home/cwd）→ markSelfWrite(自写 bytes) → 手动触发 watcher onChange 等价路径 → 断言 subscriber 不被调（env 引用不变）。
  - C 组：外部改动仍热更新 —— 外部写不同内容 → subscriber 被调（env 引用变化）。
  - D 组：auto → thinkingEffort 键被删除。
  - 缺 key / 环境异常 → 显式 skip + 退出码 1（对齐 `scripts/i384-settings-hot-reload-smoke.ts` 模式）。
- **验收**: `npm run probe:settings-bidir` 退出 0，四组全过。`tsc --noEmit` 0 错。`prettier --check` 全绿。
- **commit**: `test(config): 双向持久化 smoke 真值验证 (T6)`
- **依赖**: T4 + T5。

## 验收（最终）

```
npm run typecheck                                     # exit 0
npm test                                              # vitest + bun tests/tui 全绿（不含预存环境失败）
npx prettier --check .                                # 全文件通过
npm run probe:settings-bidir                          # A/B/C/D 四组全过
vitest run --coverage src/config/persist-settings.ts src/config/env-loader.ts src/tui/thinking-picker.tsx   # 新模块 100% line/branch
```

## 完成标准

`grep -c "^\s*#### T" plans/settings-bidirectional-persist.md` = 6；`git log --oneline | grep -i "persist\|bidirectional\|双向" | wc -l` ≥ 6。

## 反向 / 风险

- **self-write 竞态**：onChange 触发时文件可能仍在 rename（tmp → final）中间态，读文件可能短暂 ENOENT 或读到 tmp 残影。决策：读失败/内容不匹配 → 按外部处理走 reload（保守，最坏多 reload 一次，不会吞真实外部事件）。self-write 命中率取决于「写回完成 → watcher debounce 到期读文件」时序，正常 100ms 窗口内 rename 已稳定，实测在 smoke B 组验证。
- **权限**：写 `~/.iknow/settings.json` 若 EACCES（只读 mount / 其它用户所有）→ persistThinkingChanges 抛错 → TUI notice 呈现，in-memory override 保留。不 crash。
- **并发写**：两个面板连续 Esc → 两次写回串行（fire-and-forget 但 Node 事件循环天然串行 fs 调用）；同一文件两次 rename 原子替换，最终内容 = 最后一次 patch（读-改-写有 lost-update 窗口，但 thinking 两键是幂等操作，最坏丢一次旧值，可接受，不为此加锁）。
- **测试稳定性**：persist-settings / env-loader 测试用 `mkdtempSync` + `afterAll rmSync` + 显式 stop()；fs.watch 在 WSL / CI 偶发慢 → 测试超时放宽 3000ms（沿用 settings-hot-reload plan 同款纪律）。
- **不写真实 `~/.iknow/settings.json`**：smoke 全部注入 tmp home/cwd；实现与测试都不读/写真实用户 settings（apiKey 敏感）。

## 调度方 = implementer（main 派，走 arthurpower:dispatching-parallel-agents）

## 架构预检（ACR verdict，commit-only，implementation gated by all-yes）

> 来源：arthurpower:architecture-change-reviewer（main T0 dispatcher）。Pre-implementation gate 5-line verdict, all yes。

```
bounded-context-guardian: yes
defensive-contract-validator: yes
error-handling-enforcer: yes
complexity-anti-drift: yes
minimal-change-verifier: yes
OVERALL: PASS — hand to writing-plans
```

T1 / T2 / T3 三个模块边界独立（config 两个模块 + tui 纯函数），可并行派发；T4 依赖三者、T5 依赖 T4、T6 依赖 T4+T5 串行。main 按「独立模块各 1 个」拆：

- T1 → implementer A（src/config/persist-settings.ts + 测试）
- T2 → implementer B（src/config/env-loader.ts 修改 + 测试）—— 但 T2 依赖 T1 的 `hashSettingsContent`（哨兵比对用）。**决策**：T1、T3 并行先行；T1 完成后 T2 与 T3 并行；T4 收口三者。
- 每个 implementer prompt 7 字段（ROLE/SCOPE/PERMISSION/REFERENCE/CONSTRAINTS/DELIVERABLE/OUTPUT）。
- 全部完成后 main cross-check（git diff --stat 确认无文件冲突、无 scope creep、commit 原子性）再逐 bullet commit。
- 不 push、不开 PR、不 merge（main 收尾时统一处理，等用户 push 授权）。
