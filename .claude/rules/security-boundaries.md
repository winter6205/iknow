# 安全边界（iknow 特有细则）

红线在 `AGENTS.md`「硬边界」，这里只写细则。

## 读取与环境变量

- 确认环境变量是否存在用 `[ -n "${VAR:-}" ] && echo set || echo unset`，不用 `echo "$VAR"`、`env`、`printenv`、`set -x`。
- 不用 `python3 -c`、`node -e`、`grep -r`、`source .env` 等写法绕开 `.env` 读取限制；settings 的 deny 拦不住这些写法，靠本条约束。

## 测试数据与凭据

- 测试、fixture、快照、示例里的凭据用明显的占位值，或运行时从环境变量读取；不用真实用户数据。
- 新增或修改的 fixture、快照里不放真实凭据。
- `npm run test:real-llm` 用 iknow settings 里配置的模型 key（不是固定环境变量），会产生费用并把输入发给外部提供方：输入只用可公开或已脱敏的内容。

## trace 打码（本仓事实）

- trace writer（`src/harness/trace/jsonl.ts:19,148,177`）写入前按密钥登记表把已知密钥值替换为 `<<<SECRET_N>>>`；开关是 settings 的 `secrets.enabled`，默认开启（`src/config/settings.ts:20,333`）。
- 不得提交关闭 `secrets.enabled` 的配置或测试改动；打码只覆盖已登记的值。

## 公开镜像

- iknow 有公开镜像，发布工作区在 `${RELEASES_DIR:?}` 下；`.claude/`、`CLAUDE.md`、`AGENTS.md` 都会进镜像。规则、代码、文档里不写内部名称、私有 owner 和本机路径；内部名称清单只在 `${RELEASES_DIR:?}/internal-patterns.txt`，不进仓库，汇报命中时只报文件和行号。
- 自检（仓库根目录，只读，输出为空才通过）：

```bash
test -r "${RELEASES_DIR:?}/internal-patterns.txt" && git grep -n -I -i -E -f "${RELEASES_DIR:?}/internal-patterns.txt" -- . ':!*.lock'
rg -n -uu -P --glob '!.git/' 'projects/release[s]|/home/[A-Za-z0-9._-]+/|/Users/[A-Za-z0-9._-]+/|/mnt/[a-z]/|\b[A-Z]:\\' .
```

- **发布前密钥扫描（只此一处）**。发布工作区里对公开镜像全树跑下面两条，任一有输出即停止发布，只报文件名、不报匹配值，并把结果附在批准请求里：

```bash
git -C "${RELEASES_DIR:?}/iknow" ls-files -z | xargs -0 -r rg -l -I --pcre2 \
  -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' -e 'AKIA[0-9A-Z]{16}' -e '\bsk-[A-Za-z0-9_-]{20,}' \
  -e '\bgh[pousr]_[A-Za-z0-9]{36,}' -e '[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@' \
  -e '(?i)(api[_-]?key|secret|token|passw(or)?d)\s*[:=]\s*["'"'"']?[A-Za-z0-9_\-/+=]{16,}'
git -C "${RELEASES_DIR:?}/iknow" ls-files | rg -e '(^|/)\.env(\.|$)' -e '\.(pem|key|p12|pfx|jks)$' \
  -e '(^|/)(id_rsa|id_ed25519)$' -e '(^|/)(secrets|credentials)\.' \
  | rg -v '\.env\.(example|sample)$'
```

- 发布前在发布工作区再跑：上面「自检」第一条、`git rev-list --all | xargs -r -n 100 git grep -l -I -E -f "${RELEASES_DIR:?}/internal-patterns.txt"`（历史）、`ls -a | rg '^\.env' | rg -v '\.env\.(example|sample)$'`，任一有输出即停止发布，把结果附在批准请求里。
- 镜像工作区目前仍有内部名称残留，发布前逐条复核。
- 提交（普通进仓库）不做密钥扫描；扫描只在公开镜像发布前做。
