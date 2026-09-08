# Spec: skill-load-write-root — skill 正文装配收口 + 写根 trailer

> 输入 = `plans/skill-load-write-root.md`（ACR PASS 2026-09-07）+ 审计背景 `docs/audits/2026-09-07-skill-dir-pollution.md`（只读病因，不构成本 spec 合同）。
> 范围 = 消费 skill 时模型在同一份正文末尾看见与子代理 prior 相同的「当前写根」；slash / `skill()` / Web 共用一个正文装配口。
> 不做 = skill 包路径写拒绝、`.gitignore` 收白名单、改名/删除 `Base directory` 行、把活 `taskRoot` 写进 system `## Project path`（T9 红线）、每回合用户句重复 trailer、Web 前端复制 trailer。

## 合同

1. **写根文案 SSOT**：「当前写根」段文案只有一份，落点在 `src/harness/skill/body.ts` 旁的装配模块（helper 与 `src/harness/subagent/worker.ts` prior 共用同一函数，worker 源内不得留第二份长句）。
2. **trailer 追加位置**：`createSkillBody` 在 `<skill_files>` 闭合之后追加写根段；trailer 存在时它永远是正文末段。
3. **expand 形态（字节兼容）**：`taskRoot` 缺席 / 空白 → 无 trailer，输出与 337 SC6 现形态逐字节一致；同输入二次调用字符串相等（KV 缓存契约不变）。
4. **生产消费方必须传活根（migrate）**：TUI slash、session-api `loadSkillBody`（Web `getSkillBody` 后端）、ACI `skill()` 工具三处生产调用读活 `taskRoot` cell 传入。三处不得绕过 `createSkillBody` 自拼 `Base directory` 或写根文案；Web 前端不拼 trailer（信封本地前缀维持现状）。
5. **未知 skill 名**：仍是既有引导句，无 trailer。
6. **子代理 prior（contract）**：`priorMessagesFromEnvelope` 写根段改用同一 helper，入参为**处境枚举**（`WriteSituation`，定义见 `src/harness/session-roots.ts`，承载「隔离态 + 根形」组合 = 三态 `writable_main` / `writable_tree` / `no_writable_root`）而非裸 `sandboxRoot`；顺序契约 `[host dialogue?, evidence?, write root]` 不变；`sandboxRoot` 空 → 不注入；处境枚举为 `no_writable_root` 时同样**不注入**写根段（沿用「宁可不说，不可说错」立意，typed skip 不静默插一段）。（2026-09-08 amendment，承接 `specs/write-situation-disclosure.md` OQ1 采纳 (b)：envelope 旧版本（无处境字段）走 typed skip，不回落 legacy 文案。）worker prior 之后 body 再带一次相同 trailer 属可接受双份（同文案同语义）。
7. **改绑后主会话再给一次**：仅当活写根 ≠ system `## Project path` 所钉身份根时，经既有 session worktree rebind / loop 用户消息缝注入一次与 helper 相同的写根段；不进 system、不进 `env_snapshot`；空白 taskRoot 走 typed skip（不静默插一段）；改绑失败不插入；未改绑不多段；非每条用户消息。
8. **skill-load 长度豁免不变**：`SKILL_LOAD_PREFIX` / `isSkillLoadText` / `exceedsUserInputCap` 语义不动——超长 SKILL.md + trailer 仍可装配。

## Inherited decisions（不改写，仅锚定）

- ADR-0037 T9 / `docs/CONTEXT.md` `taskRoot`：活写根不进 system；写与工具 cwd 只问 `taskRoot`。
- 337 SC6 现形态：frontmatter 剥离 + `Base directory: <abs dir>` + `<skill_files>` 采样 ≤10。
- 子代理 prior 现句：`current write root (for write_file / edit_file / bash cwd): <root>` + 「Project path 只读、突变写该根、用相对路径」——trailer 字节与该句一致。
- **合同 1「文案只有一份」不变**（2026-09-08 amendment 显式重申）：本次合同 6 / SC6 amend 只改 helper 入参（裸根 → 处境枚举），不改 SSOT 落点。worker 源内仍只许调 helper，不得自拼写根文案。

## Success Criteria

- [ ] SC1 `taskRoot` 空 / 缺 → `createSkillBody` 输出与改造前逐字节一致（无 trailer）。
- [ ] SC2 非空 `taskRoot` → trailer 段位于 `</skill_files>` 之后、含 `current write root`，且与 worker prior 写根段字节相同（同一 helper）。
- [ ] SC3 TUI slash、hub `loadSkillBody`、ACI `skill()` 三条生产路径传入活 `taskRoot`；同一 skill 在三处进模型的正文末尾都带当前写根。
- [ ] SC4 未知 skill 名返回既有引导句且无 trailer。
- [ ] SC5 超长 SKILL.md 仍可装配且 trailer 保持在末尾；skill-load 豁免判定不变。
- [ ] SC6 worker prior 源内无第二份写根长句；prior 测试对 `current write root` 与身份根只读句的断言不变或更强。（2026-09-08 amendment，承接 `specs/write-situation-disclosure.md` T5：原断言「worker 源内无第二份写根长句」强度保留——helper 入参由裸 `sandboxRoot` 改为处境枚举后，源内长句仍只许出现在 helper 一处，worker 侧只允许构造处境枚举并调 helper，不得自拼写根文案；`writable_main` / `writable_tree` 两态输出**逐字节与改造前相等**，`no_writable_root` 态**不注入**写根段。）
- [ ] SC7 改绑成功且写根 ≠ 身份根 → 主会话 messages 出现一次 helper 文案写根段；未改绑 / 改绑失败 / 空白 taskRoot → 不出现。
- [ ] SC8 `npm test` + `npm run typecheck` exit 0。

## ACR

见 `plans/skill-load-write-root.md` ACR 段（PASS，2026-09-07）。
