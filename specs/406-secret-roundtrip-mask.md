# Spec: 统一 Secret 处理层 — Roundtrip Mask（#406）

> **来源**：plan `.claude/worktrees/126-hook-system/plans/406-secret-roundtrip-mask.md`（grill 票 #406 直接出 plan，gh-22 skip 路径）。本 spec 为 retroactive 落地档（plan §2 ACR 自审 5/5 yes → spec-driven-development 跳写同因），自 plan §1-§9 拼装，非另行 grilling。
> **Supersedes**: #126 hook-system（PR #405）— deny-only 拦截被 roundtrip 完全替代。
> **状态**：T1-T5 全部 landing，端到端矩阵验收通过。

## 1. 上下文与现状（Context & status quo）

当前 secret 处理是**补丁式**的，三个独立层互不感知：

| 层                 | 文件                                      | 作用时机                     | 开关                       | 覆盖形态                                                |
| ------------------ | ----------------------------------------- | ---------------------------- | -------------------------- | ------------------------------------------------------- |
| ① input guard      | `src/harness/permission/secrets-guard.ts` | 工具 input 进 sandbox **前** | `settings.secrets.enabled` | 占位形态（`sk-`/`AKIA`/`ghp_`/`xox`/私钥块/`id_` 外传） |
| ② sandbox env 隔离 | `src/harness/sandbox/env-isolation.ts`    | bash 进 bwrap 时             | 无独立开关                 | 密钥 env 白名单                                         |
| ③ output mask      | `src/harness/sandbox/output-mask.ts`      | 输出回灌模型 / 落盘 / UI     | 无独立开关                 | 仅按已知值（env + settings 字面 key）                   |

每一层补的是「用户贴 key 后可能引发的事故」——但没有从根上解决「用户贴 key 后系统整体怎么对待它」这件事，所以是补丁而非设计。

### 关键卡点

| #   | 卡点                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | 用户贴 key 进对话 → 模型拿明文 → 模型在 bash 里 `curl -H "Bearer sk-xxx"` → guard 拦下 → **key 跑不通**（反人类）          |
| 2   | 即使用户改用 env 引用绕过 guard，模型上下文 / 回显 / trace 仍可能暴露 key（output-mask 只遮 env 值，不遮用户贴的明文 key） |
| 3   | #126 的 deny-only 设计天然冲突于「key 要真跑 API」诉求 —— 任何 deny 都阻断执行                                             |

## 2. 关键阻塞项（Key blockers）

- **无硬阻塞**。env-isolation 完全独立，与本计划无依赖关系。
- #126 PR #405 状态：draft，未 merge。本计划完成后，#126 PR 关闭 superseded by #406；#406 PR 合并到 master。
- session 重启 limitation：registry 是 in-memory 不落盘 → 历史 messages 里占位符无法还原（占位符原样透传 bash 不抛，用户重新贴 key 即可）。

## 3. Roundtrip mask 设计（Design）

核心差异：**用占位符 + 还原表替代破坏性 mask**（Hermes 思路，但可还原）：

```
用户贴 key："这是 sk-xxx，帮我测 API"
   ↓ 识别层：扫形态 → 入映射表 {value: sk-xxx} → 注册占位符 SECRET_N
   ↓ 替换：对话文本里 sk-xxx → <<<SECRET_N>>>
模型看到："这是 <<<SECRET_N>>>，帮我测 API"
   ↓ 模型发起 bash 调用：curl -H "Authorization: Bearer <<<SECRET_N>>>"
   ↓ guard 自然放行（无 sk- 形态）
   ↓ bash 还原层：执行前把 <<<SECRET_N>>> 替换回 sk-xxx
   ↓ bash 真发请求 → API 拿到真值 → curl 200
   ↓ 模型上下文/回显只见占位符；trace 层 currentSecretValues 兜底 mask 真值
```

**发请求那一刻 key 真值必然存在（物理不可避免）**——差异只在真值暴露范围：Hermes 用破坏性 mask 让 curl 必然 401（key 不可用），我们用占位符让真值仅在 bash 进程内构造 HTTP 请求那一瞬间短暂存在。

### 模块布局

- `src/harness/secret-roundtrip/patterns.ts` — SSOT 密钥形态集（7 条内置，secrets-guard re-export 同源）
- `src/harness/secret-roundtrip/registry.ts` — per-engine value→placeholder map + `restore()`
- `src/harness/secret-roundtrip/recognize.ts` — per-text 扫描 → 占位符替换
- `src/harness/loop-engine.ts` — `run()` 用户文本进 LLM 前识别（`secretsMode !== "block"` 且 registry 在场）
- `src/harness/aci/tools/bash.ts` — spawn 前 `restore()` 回填真值
- `src/harness/sandbox/env-isolation.ts` — `currentSecretValues(registry.values())` 兜底遮蔽

## 4. 关键设计决策（Key decisions）

### 4.1 占位符格式

- 格式：`<<<SECRET_N>>>`（N 从 1 起单调递增，ID 永不重用）
- 不可与用户文本中可能的合法占位符冲突——`<<<` 三连字符在 prompt 中罕见；如确需冲突，fallback 改用 `${SECRET_N}` 或加 settings 开关 `placeholderFormat`

### 4.2 registry 生命周期

- per-engine 共享（`buildHarnessEngine` 创建，注入到所有 tool + loop-engine deps）——跨 turn 可见
- 不持久化到磁盘：session 重启后历史 messages 里的占位符无法还原（limitation，docs 化）

### 4.3 settings schema

```json
{
  "secrets": {
    "enabled": true,
    "mode": "roundtrip",
    "patterns": ["..."]
  }
}
```

- 迁移：#126 老用户 `mode` 缺省 = `roundtrip`（行为变化 deny-only → 放行+mask）；想保持旧行为显式设 `"mode": "block"`
- 老测试（`secrets-guard.test.ts`）保留并标注 `mode: "block"` 测试路径

### 4.4 向后兼容矩阵

| 调用点               | 现状（#126）               | roundtrip 模式             | block 模式    |
| -------------------- | -------------------------- | -------------------------- | ------------- |
| preToolUse hook      | secrets-guard（deny-only） | **不装**                   | secrets-guard |
| user text → LLM      | 原样                       | **识别 + 替换**            | 原样          |
| bash command → spawn | 原样                       | **还原占位符**             | 原样          |
| output / trace       | 值匹配兜底                 | **值匹配 + registry 兜底** | 值匹配兜底    |

## 5. 风险与阻塞项（Risks & blockers）

| 风险                                                                       | 缓解                                                                                                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户文本含合法 `<<<SECRET_N>>>` 字符串 → 误识别                            | `<<<` 三连字符在 prompt 中罕见；冲突场景低；如遇，error-out 提示用户用替代写法                                                                     |
| session 重启后历史 messages 含占位符 → registry 空 → 还原失败              | 占位符不存在时 restore 原样保留（不抛），bash 命令里 `<<<SECRET_N>>>` 字面传给 bash；命令失败 → 模型回错 → 用户重新贴 key（acceptable limitation） |
| 多 surface registry 同步：chat / tui / serve 各自引擎实例化 → 占位符不互通 | 每个 surface 是独立 session；用户贴的 key 在该 surface 内可恢复；跨 surface 用 env 注入（沿用现方案）                                              |
| 性能：识别层扫 user text 的 7+ 形态正则，每次 turn                         | regex 编译在构造期；运行期只 `.test()`；user text 通常 < 10KB，扫 10KB 7 条 regex < 1ms；可接受                                                    |

## 6. Verification checklist

```bash
# 1. 端到端矩阵（A1：4 surface × 2 mode ≥ 6/8 绿）
npx vitest run tests/harness/secret-roundtrip/e2e.test.ts
# 期望：12 case 全绿（8 装配矩阵 + 4 全流）

# 2. typecheck 零 error（A2）
npm run typecheck

# 3. 全量测试（A2；pre-existing env/TUI/SC8 flaky 豁免）
npm test

# 4. docs 落地（A3/A4/A5）
grep -c "secret-roundtrip" docs/architecture.md          # ≥ 1（Capability modules 表）
grep -n "#406" CHANGELOG.md                              # ≥ 1（含 #126 superseded 标注）
test -f specs/406-secret-roundtrip-mask.md               # 存在
```

> 完成 = 实测过：以上命令真实运行并捕获输出（per `.claude/rules/test.md`）。
