# Plan: skill 正文加载契约 — 三路同源、不经通用输出闸

**Goal:** 内建 `skill` 工具的装配正文不再经 executor 的 20000 字符兜底闸，使 slash / hub `loadSkillBody` / ACI `skill()` 三路交付同一份完整正文；其余工具与 MCP 工具的输出闸行为一字不变。

**Approach:** 先在 Foundation `ToolDef` 上开出豁免声明的家（T1，纯类型 + 读路径），再让 `createSkillTool` 装配期落值（T2），最后用测试把三路同源与「MCP 拿不到」两面钉死（T3）。不改 `createSkillBody` 装配形态、不改短路判据、不新增任何截断 / 预览 / 回退机制。

**Spec link:** `specs/skill-body-load-contract.md`

**ACR:** all-yes（首轮 BLOCKED 的 bounded-context-guardian 已按 spec 修：豁免 home 选 Foundation `ToolDef` 可选字段，executor 读它，不走 cast、不反向 import；基线声明与 MCP 加固已补）。

```
bounded-context-guardian: yes — 豁免声明落 Foundation ToolDef 可选字段（src/harness/tools/types.ts），createSkillTool 落值，executor 经 safeContent/applyOutputCap 读；tools/ 不进 aci/ import，无影子契约 cast。
defensive-contract-validator: yes — S2 表五类齐全；SC1/SC3/SC4/SC6 钉死「>20000 完整交付」「其他工具仍截断」「MCP 结构+行为断言」「失败面不变」。
error-handling-enforcer: yes — 不新增 catch/fallback；未知名 / catalog miss / 读失败走既有 typed 路径；豁免只绕截断，不绕错误处理。
complexity-anti-drift: yes — 唯一改动点 = 既有 cap 处加一个布尔读（executor.ts）；禁新增截断/预览/回退机制。
minimal-change-verifier: yes — 单一主题；基线声明已补（叠 feat/skill-body-short-circuit）。
```

**基线：** 本计划叠在 `feat/skill-body-short-circuit`（ADR-0079 短路实现：`48f172a9` / `63b9bbe7` / `0d47d3a8` / `8d65bd50`）之上。该分支未合并前，T3 的短路前提不成立——先把基线合入或 rebase，再跑 T3；不降断言强度。

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion（landing grain：操作员全局 commit 节）

## Tasks (ordered by dependency)

1. **豁免声明落 Foundation `ToolDef` + executor 读它** — tag: `[implementation]`
   - **Inherits:** spec Boundaries「豁免是装配期静态声明，落在 Foundation `ToolDef` 的可选字段上」（`specs/skill-body-load-contract.md`）；契约 X「工具不声称截断字段」不变（`docs/CONTEXT.md` `executor truncation authority`）。
   - **Surface:** `src/harness/tools`（`types.ts` 声明、`executor.ts` 读路径 `safeContent` / `applyOutputCap`）。
   - **Acceptance:** 名字未定的可选布尔字段存在于 `ToolDef`；`applyOutputCap` 在该字段为真时原样返回文本、不追加截断标记；为假 / 缺席时行为与今日逐字节相同（既有 executor 截断测试全绿，无需改断言）。`src/harness/tools/` 仍对 `src/harness/aci/` 零 import。
   - Status: [x] done
   - [blocks: T2]

2. **`createSkillTool` 装配期落值** — tag: `[implementation]`
   - **Inherits:** T1 的字段；spec Boundaries「`createSkillTool` 落值」；`skill-load-write-root.md` 合同 4「三处只经 `createSkillBody` 取正文」不变。
   - **Surface:** `src/harness/aci/tools/skill.ts`（工厂返回值）。
   - **Acceptance:** `createSkillTool(...)` 产出的 def 带该声明；其他内建 ACI 工厂不带（结构断言）。`skill({name})` 在 >20000 字符 SKILL.md 上返回完整装配正文、末段 `</skill_files>`、不含 `executor: 输出超长已截断`。
   - Status: [x] done
   - [blocks: T3]

3. **三路同源 + 闸不泄漏 + MCP 不可取得** — tag: `[implementation]`
   - **Inherits:** spec SC2 / SC3 / SC4；`skill-load-write-root.md` 合同 4 与 SC3（三路同一装配口）。
   - **Surface:** `src/harness/aci`（`aci-registry.ts` 的 `registerExternal` 加固）、`src/harness/mcp`（`adapter.ts` 不设声明）、`src/session-api`（`loadSkillBody`）、`tests/`。
   - **Acceptance:** 同一 skill 经 slash 信封 / `hub.loadSkillBody` / `skill()` 三路得到的正文与 `createSkillBody` 产物逐字节相等；内建非豁免工具与 MCP 工具的超长输出仍 ≤20000 且带既有标记；`registerExternal` 对 `mcp__` def 剥离 / 拒绝该声明（结构断言）；未知名仍返回既有引导句、读失败仍走既有失败路径。
   - Status: [x] done
   - [blocks: T4]
   - 备注：短路相关断言（首次灌全文 / 二次短回执 / compact 后重灌）依赖基线分支，基线未合入前只跑非短路部分。

4. **文档面：skill 作者契约** — tag: `[decision]`
   - **Inherits:** spec Assumptions 5「正文大小纪律是作者契约，不由运行时强制」；spec Changes「skill 作者契约进文档」。
   - **Surface:** 既有 skill 相关文档（作者可见面）。
   - **Acceptance:** 文档写明「正文精简、细则进 `references/`；运行时不对正文大小设限」；不新增运行时校验。
   - Status: [x] done

## 待写入（persist 清单）

- ADR-0083：skill 正文不经通用输出闸（理由 = 非可再生查询 + 三路一致性 + 半份程序不可交付；边界 = 仅内建装配期静态声明、MCP 结构性不可取得）。编号避开主 checkout 在途的 0075–0082。
- `docs/CONTEXT.md`：`executor truncation authority` 词条补 scope 例外（skill 正文）；补一对 disambiguation（「skill 正文豁免 vs 契约 X」）。—— 该文件有写主权守卫，走 `domain-modeling`。

## Notes

- 本计划不做：自动重挂、重挂配额、skill 专属上限、预览 / 回退 / 落盘机制、运行期正文大小强制。
- commit 粒度由操作员全局 commit 节决定，不按 bullet 一刀切。
