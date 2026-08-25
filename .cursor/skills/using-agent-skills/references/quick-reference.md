# Quick Reference Table (router-reachable skills)

User-invoked (`disable-model-invocation: true`) — the description matcher will not fire these. The router may still invoke them as the **current sequence slot**. Only `skill-authoring` and `self-evolving-rules` require the operator to type the name first.

| Phase        | Skill                   | Trigger                                          |
| ------------ | ----------------------- | ------------------------------------------------ |
| Meta         | skill-authoring         | "creating SKILL.md", "edit router skill"         |
| Meta         | self-evolving-rules     | "记住 X", "以后 X", "规则是 X"                   |
| Plan         | writing-plans           | After ACR verdict: yes                           |
| Defining     | spec-driven-development | "new project", "no spec yet", "multi-file scope" |
| Setup        | setup-arthurpower       | "bootstrap project", "first-time setup"          |
| Defining     | wayfinder               | "rough concept", "too big for one session"       |
| Productivity | session-handoff         | "handoff", "multi-session persist"               |

Model-invoked — description may match:

| Phase    | Skill                          | Trigger                                                    |
| -------- | ------------------------------ | ---------------------------------------------------------- |
| Meta     | dispatching-parallel-agents    | "parallel subagent", "fan out", "concurrent dispatch"      |
| Plan     | architecture-change-reviewer   | "multi-file change", "new module", "cross-module refactor" |
| Build    | bounded-context-guardian       | "拆模块", "circular import"                                |
| Build    | defensive-contract-validator   | "加接口", "修个 bug", "补验证"                             |
| Build    | error-handling-enforcer        | "改错误处理", "加 try-catch"                               |
| Build    | complexity-anti-drift          | "重构", "减复杂度", "拆函数"                               |
| Build    | minimal-change-verifier        | "提交前", "准备 commit", "1 commit"                        |
| Build    | test-driven-development        | "write failing test first", "TDD"                          |
| Verify   | systematic-debugging           | "修 bug", "系统调试"                                       |
| Verify   | verification-before-completion | 完成 / 对照计划 / 对照 spec / this run's basis + 实测      |
| Review   | code-review                    | "review", "PR", "审代码", "dual-axis"                      |
| Review   | boundary-testing               | "边界测试", "boundary test", "跨文件改动"                  |
| Defining | logicsync                      | "vague request", "长访谈", "盘问"                          |
| SSOT     | domain-modeling                | "glossary", "ADR", "CONTEXT.md"                            |
