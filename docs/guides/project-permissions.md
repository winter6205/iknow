# 项目权限规则（`settings.permissions`）

操作员指南。合同 SSOT = `specs/declarative-project-permissions.md` + ADR-0090。加载实现 = `src/harness/permission/`（勿以本页为 schema 权威）。

---

## 一句话

在共享项目 `<仓>/.iknow/settings.json` 里用 `allow` / `ask` / `deny` 字符串声明工具政策。只写项目层；`~/.iknow/settings.json` 里的 `permissions` 会被忽略。

---

## 模板

```json
{
  "permissions": {
    "defaultMode": "default",
    "allow": [
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(rg:*)",
      "Bash(npm run test:*)"
    ],
    "ask": ["Bash(pnpm:*)", "Bash(yarn:*)"],
    "deny": [
      "Bash(git push --force:*)",
      "Bash(rm -rf:*)",
      "Read(.env)",
      "Read(.env.*)",
      "Read(**/*.pem)",
      "Read(**/*.key)",
      "Edit(.env)",
      "Edit(**/*.pem)"
    ]
  }
}
```

`defaultMode` 可省略。合法值只有 `default` 与 `plan`。不要在仓库里写自动模式。

---

## 语法

- `Bash` / `Read` / `Edit`：族名，映射到 ACI 工具（`bash` / 读文件一族 / 写文件一族）。
- 也可以写 ACI 字面名（`web_fetch`、`mcp__…`）。
- 无括号 = 该工具全部调用。`Bash(*)` 等同 `Bash`。
- Bash：`*` 通配；`:*` 只当**尾缀**（`Bash(git status:*)` ≡ `Bash(git status *)`）。
- 路径：gitignore 风格。`Read(.env)` 挡住工作根下任意深度的 `.env`。
- 同文件里 **deny 先于 ask 先于 allow**。

硬墙（`.ssh` 等）仍不可被 allow 放行。`Bash` 整工具 allow 也会盖住 code 层对 `network:true` 的 ask——需要保留出网询问时，不要写裸 `Bash` allow，改写命令前缀。

---

## 与 hooks

`permissions` 是默认生效的团队政策。`hooks` 是可关总闸的额外拦截（正则 / PreWrite / PreCommit），见 `docs/guides/user-hooks.md`。不要把路径 deny 只写在 hooks 里指望替代本段。
