# Plan: skill 正文装配收口 + 写根 trailer

**Goal:** 消费 skill 时，模型在同一段正文末尾看见与子代理 prior 相同的「当前写根」，不再把 `Base directory`（技能包）当成落盘目录；slash / `skill()` / Web 共用一个正文装配口。
**Approach:** 不把活 `taskRoot` 写入 system（T9）。不写 skill 目录硬闸、不改 gitignore。先把写根文案收成一处 helper、`createSkillBody` 在技能包路径之后追加 trailer（expand），再让生产调用方传入活 `taskRoot`（migrate），子代理 prior 与改绑后的主会话改用同一 helper（contract）。运输层（`[skill-load]` 信封 vs tool_result）只包一层，不各自拼写根。
**Spec link:** T1 落地 `specs/skill-load-write-root.md`（amends `specs/337-skill-mcp-extension.md` SC6）；审计背景 `docs/audits/2026-09-07-skill-dir-pollution.md`（只读病因，本计划不把审计当合同）。
**ACR:** **PASS**（2026-09-07，`architecture-change-reviewer-agent`）。五维块见下。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch。全部 bullet 落地后再跑一轮 end-of-round `code-review`。

> **Tracker 路径：本地 markdown（fallback）。** 理由：操作员明确不要开 GitHub issue tracker。切片与依赖以本文件 Tasks 为准。误开的 #924–#928 已关闭。

---

## 病因（已定，不是开放题）

host 装配 skill 正文时给出 `Base directory: <skillDir>`，这是该轮里被点名的技能包绝对路径。`## Project path` 是稳定 `projectIdentityRoot`，活 `taskRoot` 不进 system（T9），只进人读 `env_snapshot`。子代理 spawn prior 已有写根段，但随后 `skill()` 的 tool_result 更新、更具体，会盖过开场 prior。TUI slash 与 hub `loadSkillBody` 都走 `createSkillBody`，Web 信封本地拼前缀、正文来自 API——trailer 必须进 body SSOT，不能只改 `app.tsx`。

## ACR

```
bounded-context-guardian: yes — trailer SSOT stays in src/harness/skill/body.ts (createSkillBody); consumers already import it (skill.ts, hub.ts, app.tsx); Web keeps api.getSkillBody; worker already depends on skill so helper reuse is same direction; T5 uses existing rebind/user-message seams, not env_snapshot (UI-only, T9).
defensive-contract-validator: yes — five classes on createSkillBody + T3/T5: empty = omit/blank taskRoot → no trailer (expand) vs live cell after T3; negative = skill-not-found unchanged and empty-string trailer absent; overflow = huge SKILL.md + trailer, skill-load length-cap exemption unchanged; concurrent = one assembler for skill() and slash; exception = missing SKILL.md existing + rebind inject typed skip if blank.
error-handling-enforcer: yes — expand keeps optional taskRoot; T3 production callers must pass live cell; T5 blank taskRoot typed skip not silent inject; skill-not-found stays guidance string; T9 forbids system/env_snapshot for live root.
complexity-anti-drift: yes — one helper for the existing worker prior copy; createSkillBody only appends after skill_files; callers thread a field rather than duplicate assembly; Web must not reimplement trailer.
minimal-change-verifier: yes — one logical theme (skill-body write-root trailer SSOT); out of scope is skill-dir deny / gitignore / Base-directory rename; T1–T5 are sequenced 1-commit slices — sequence, do not merge.
```

**affects（实施时不得超出；T1 另含 spec / CONTEXT / 337 SC6 指针）：**

- `src/harness/skill/body.ts`（装配 SSOT + 写根文案 helper 落点由实施方决定，须与 worker 共用）
- `src/harness/aci/tools/skill.ts`
- `src/session-api/hub.ts`（`loadSkillBody`）
- `src/tui/app.tsx`（slash 调用 `createSkillBody`）
- `src/harness/subagent/worker.ts`（prior 改用 helper）
- `web/src/hooks/use-slash-commands.ts`（禁止在 Web 再拼 trailer；信封可仍本地前缀）
- 改绑后主会话注入：既有 session/loop 用户消息缝（实施方选现缝，不新 BC）
- `tests/skill/body.test.ts`、`tests/subagent/worker-write-root-prior.test.ts`（可增不可改契约语义）
- `specs/337-skill-mcp-extension.md` SC6、`specs/README.md`、`docs/CONTEXT.md` `taskRoot`

---

## 待写入（T1 落地；本规划会话不 flush `domain-modeling`）

- 新 spec `specs/skill-load-write-root.md`：合同见 T1 Inherits；活跃索引加一行。
- 337 SC6 增补：正文末尾在传入写根时追加与 worker prior 相同的写根段。
- `docs/CONTEXT.md` `taskRoot`：补「消费 skill 时（slash 信封 / `skill()` tool_result）正文末尾带当前写根，文案与 worker prior 同一份；改绑后主会话另给一次，不进 system」。

---

## Tasks (ordered by dependency)

1. **记下 skill 正文 SSOT 与写根 trailer 合同** — tag: `[decision]`
   - **Inherits:** ADR-0037 T9 / CONTEXT `taskRoot`：活写根不进 system `## Project path`；337 SC6 现形态 = 去 frontmatter + `Base directory` + `<skill_files>` 采样 ≤10；子代理 prior 文案（`current write root (for write_file / edit_file / bash cwd):` + Project path 只读、突变写该根）；本轮不做 skill 目录写拒绝、不做 gitignore 白名单、不改名 `Base directory`。
   - **Surface:** `specs/` 新 spec + `specs/337-skill-mcp-extension.md` SC6 一句 amend + `specs/README.md` 活跃表 + CONTEXT `taskRoot` 一句。
   - **Acceptance:** spec 写明：唯一正文装配函数在技能包路径段之后追加写根 trailer；slash 与 `skill()` 与 Web `getSkillBody` 不得各写一套；`taskRoot` 空/缺席 → 无 trailer（expand 形态）；生产消费方必须传入活 cell（T3）；改绑后主会话在写根 ≠ Project path 时用同一文案再给一次、非每轮用户句；commit 无产品代码。
   - Status: [ ] pending

2. **expand：写根文案一处 + 正文装配可追加 trailer** — tag: `[implementation]`
   - **Inherits:** T1：trailer 字节与 worker prior 现句一致；追加位置在 `<skill_files>` 闭合之后；`createSkillBody` 缺席/空白 `taskRoot` → 与今日 SC6 字节兼容（无 trailer）；二次相同输入字符串相等。
   - **Surface:** harness skill 装配（`src/harness/skill`）+ 现有 `tests/skill/body.test.ts`。
   - **Acceptance:** 空/缺写根 → 无 trailer；非空写根 → 段在 `</skill_files>` 之后且含 `current write root`；overflow：超长 SKILL.md 仍可装配且 trailer 仍在末尾；skill-load 超长豁免（`exceedsUserInputCap` / `isSkillLoadText`）语义不变。生产调用方本 commit 可不改（expand）。复杂度闸见 `complexity-anti-drift` thresholds，本栏不抄行数。
   - [blocks: T1]
   - Status: [ ] pending

3. **migrate：slash / hub / `skill()` 传入活 taskRoot** — tag: `[implementation]`
   - **Inherits:** T1：生产路径必须传活 cell；T2：装配函数已接受写根。CONTEXT：写工具 cwd 只问 `taskRoot`，handler 调用时读 cell。
   - **Surface:** ACI `skill` 工具、session-api `loadSkillBody`、TUI slash 装配；Web 继续 `getSkillBody`，不在前端拼 trailer。
   - **Acceptance:** `skill({name})` 与 slash skill-load 与 Web 加载同一 skill 时，进模型的正文末尾都有当前写根；未知 skill 名仍是今日引导句、无 trailer；TUI 与 hub 不得绕过装配函数自己拼 `Base directory` 或写根。
   - [blocks: T2]
   - Status: [ ] pending

4. **[parallel] contract：子代理 prior 改用同一 helper** — tag: `[implementation]`
   - **Inherits:** T1 文案同一份；ADR-0037 §4 (e) worker 看见当前写根；顺序仍是 `[host dialogue?, evidence?, write root]`；`sandboxRoot` 空 → 不注入写根段。
   - **Surface:** `src/harness/subagent` worker prior + `tests/subagent/worker-write-root-prior.test.ts`。
   - **Acceptance:** prior 测试仍断言 `current write root` 与身份根只读句；worker 源内不再第二份写根长句；load skill 后 body 再带一次相同 trailer 可接受（双份同文案）。
   - [blocks: T2]
   - Status: [ ] pending

5. **[parallel] 改绑后主会话再给一次写根（无 skill 也要）** — tag: `[implementation]`
   - **Inherits:** T1：仅当活写根 ≠ `## Project path` 所钉身份根；不进 system、不进 `env_snapshot`；空白 taskRoot typed skip、不静默插一段；非每条用户消息。
   - **Surface:** 既有 session worktree rebind / loop 用户消息缝（与 #891 主会话缺口同一问题，本 bullet 只补「给模型看的一次」）。
   - **Acceptance:** 未改绑 → 不因本 bullet 多一段写根；改绑成功且两根不同 → 模型 messages 出现一次与 helper 相同的写根段；改绑失败不插入。
   - [blocks: T2]
   - Status: [ ] pending

---

## 明确不做

- skill 包路径写拒绝 / author 例外闸
- `.gitignore` `!.iknow/skills/**` 收白名单
- 把活 `taskRoot` 写入 `projectPathSegment`
- 每回合用户句重复 trailer
- 本轮改名或删除 `Base directory` 行
- 在 Web 包复制 trailer 或复制 `createSkillBody`
