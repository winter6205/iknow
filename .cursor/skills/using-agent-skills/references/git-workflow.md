# Git Workflow — Generic Reference

> 通用 Git 工作流参考。从 `arthurpower` 项目 `docs/rules/git.md` 提取的通用部分。
> 项目特定的 hooks 集成表 / 项目路径引用未搬入此文件；项目内部用 `docs/rules/git.md`。

## 分支规范

- 默认分支为 `main` 或项目实际默认分支。不得直接在默认分支上开发或提交，除非用户明确授权且当前仓库规范允许。
- 分支命名格式：
  - `feat/<ticket-or-short-desc>`
  - `fix/<ticket-or-short-desc>`
  - `docs/<ticket-or-short-desc>`
  - `refactor/<ticket-or-short-desc>`
  - `test/<ticket-or-short-desc>`
  - `chore/<ticket-or-short-desc>`
- 分支名必须使用小写字母、数字和短横线。避免空格、中文、特殊符号。

## 开始修改前必须检查

```bash
git status --short
git branch --show-current
git diff --stat
```

如果工作区存在用户未提交的改动，必须先区分哪些是用户已有改动、哪些是本次任务改动。不得覆盖、格式化、删除、重排用户已有改动。

## 提交频率

落地口径只在操作者全局「提交」段，此处不另定粒度。

- 开发期 checkpoint / `wip:` 可以。
- 合入默认分支前 squash 成一条 Conventional Commit；测试与改动同一份 landing。
- 不要在一份 landing 里混合两件可独立 revert 的功能，或夹带无关的大规模格式化。

## 禁止的 Git 行为

除非用户明确授权且已说明风险，否则不得执行：

```bash
git push --force
git push --force-with-lease
git reset --hard
git clean -fd
git clean -fdx
git rebase
git rebase -i
git checkout -- .
git restore .
git commit --amend
git stash
```

任何情况下都不得使用：

```bash
git commit --no-verify
git push --no-verify
```

不得通过 alias / 脚本 / 环境变量 / 临时移动 hooks / 修改 hooks 文件 / 修改权限 / 绕过 lint-staged / husky / pre-commit 等方式规避质量门禁。

如果 pre-commit 或测试失败，必须报告失败原因，提出修复方案，不得绕过。

## 提交信息规范 — Conventional Commits

格式：`<type>(<scope>): <subject>`

允许的 type：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `build` / `ci` / `chore` / `revert`

scope 使用项目模块名（`api` / `web` / `auth` / `billing` / `db` / `deps` / `ci` / `docs` 等）。

subject 规则：

1. 使用祈使句或简洁动宾结构。
2. 不超过 72 个字符。
3. 不以句号结尾。
4. 准确说明"为什么变更"，而不仅是"改了什么"。

示例：

```text
feat(auth): add refresh token rotation
fix(api): handle empty search query
test(billing): cover invoice retry edge cases
docs(setup): clarify local database bootstrap
refactor(web): split dashboard data loader
```

### 提交正文

当变更包含以下情况时必须写正文：行为变化 / 数据结构变化 / 兼容性影响 / 迁移步骤 / 安全影响 / 性能权衡 / 测试覆盖说明 / 回滚方式。

正文模板：

```text
Why:
- ...

What:
- ...

Validation:
- ...

Risk:
- ...

Rollback:
- ...
```

### Breaking Change

破坏性变更必须使用：

```text
BREAKING CHANGE: <description>
```

并说明迁移方式。

### 禁止的提交信息

不得使用：`update` / `fix` / `misc` / `changes` / `bugfix` / `final` / `temp`。

`wip:` 仅用于 feature 分支 checkpoint；squash / PR 标题必须是 Conventional Commits。

不得生成夸大、不准确或与 diff 不一致的提交信息。

## 提交前检查

每次提交前必须完成：

```bash
git status --short
git diff --stat
git diff --check
```

然后根据项目技术栈运行对应检查（`npm run lint` / `npm run typecheck` / `npm test` / `npm run build` 或 `pnpm` / 项目实际命令）。优先使用项目文档或 `package.json` scripts 中已有命令，不要臆造命令。

提交前必须确认：

1. 只包含本次任务相关文件。
2. 没有临时日志、调试断点、测试专用 hack。
3. 没有 `.env` / 密钥 / token / cookie / 私钥 / 证书 / 生产数据。
4. 没有绕过测试、跳过 hooks、禁用 lint 的行为。
5. 新逻辑有对应测试，或明确说明无法补测的原因。
6. 文档与代码行为一致。
7. 错误处理、边界条件、回滚方式已考虑。

## 推送流程 (push workflow)

**何时推**:

- 完成 1 个垂直切片 (vertical slice, 非 mega commit)
- 跑过项目级 eval baseline（如 `.evals/run.sh`）或项目等价门禁
- task-end ritual 3 问已答 (Q1 CONTEXT / Q2 CLAUDE.md / Q3 CHANGELOG+handoff)
- **非默认 / 非受保护** feature 分支，agent 可主动 push；默认分支 / force / tag / release / production 仍需用户显式授权
- 不跨项目敏感信息 (凭据 / token / 生产数据) — 永远不推

**怎么推**:

```bash
# 1. 推到同分支 (默认)
git push origin <branch-name>

# 2. 推前确认目标分支正确 (避免推到 main)
git branch --show-current
```

**post-push ritual**: push 成功后，在主会话内走 session-skill ritual（verification-before-completion / session-handoff）触发 Q1/Q2/Q3。

## PR / Merge 流程

**什么时候需要 PR**:

- 多人协作项目: 必须 PR review, 不得直推 main
- 单人项目 + 默认分支: 可直推 (已授权)
- 关键模块 (auth/payment/migrations): 必须 PR, 即便单人

**PR 内容要求**:

1. 标题 = squash 标题 (Conventional Commits)
2. 描述含: Why / What / Validation (同 commit 正文模板)
3. 关联 issue / ticket (如有)
4. CI 全绿

**合并策略**:

- Squash merge（与全局「提交」段一致）
- Rebase merge / merge commit：仅在操作者明确要求时
- Force push to main (禁)

## 冲突解决 / 回滚

**冲突解决**:

```bash
# 1. 不要在冲突时强行 commit (会让历史脏)
git status           # 看冲突文件
git diff --name-only --diff-filter=U   # 列出 unmerged

# 2. 手动解决冲突后:
git add <resolved-files>
git commit           # 提交解决 (不要 --no-verify)

# 3. 如果冲突太多, 考虑:
git merge --abort    # 放弃本地合并, 回到干净状态
```

**回滚已推 commit**:

```bash
# 1. 单 commit 回滚 (生成新 commit "Revert X")
git revert <commit-hash>
git push origin <branch>

# 2. 多个 commit 回滚到某点
git revert --no-commit <commit-hash>..<commit-hash>
git commit -m "revert: <reason>"
git push origin <branch>

# 不要 git reset --hard + git push --force (禁)
```

**找回丢失的 commit (reflog)**:

```bash
git reflog                    # 找丢失的 SHA
git checkout -b recovery <SHA>
git cherry-pick <SHA>         # 把丢失的 commit 接到新分支
```

## Tag / Release

**何时打 tag**:

- 正式发布版本 (v1.0.0 / v0.2.4)
- 关键里程碑 (M1 / MVP / GA)
- 紧急 hotfix (v0.2.4-hotfix.1)

**SemVer 规范**: `<major>.<minor>.<patch>` (e.g. `v0.2.4`)

**打 tag 步骤**:

```bash
# 1. 确认当前 commit 是 release point
git log --oneline -1

# 2. 创 tag (annotated, 推荐)
git tag -a v0.2.4 -m "release: <summary>"

# 3. 推 tag (独立 push)
git push origin v0.2.4

# 4. 不要 force-push tag (历史追溯)
```

**删除 tag (撤回错误发布)**:

```bash
git tag -d v0.2.4           # 本地删
git push origin :v0.2.4    # 远端删 (注意: 是 :refs/tags/v0.2.4 简写)
```
