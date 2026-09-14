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
| Build    | input-contract-tests           | "入参契约", "public API tests", "empty input"              |
| Build    | error-handling-enforcer        | "改错误处理", "加 try-catch"                               |
| Build    | complexity-anti-drift          | "max-lines", "拆函数", "eslint complexity"                 |
| Build    | minimal-change-verifier        | "out of scope", "drive-by", "new dependency"               |
| Build    | test-driven-development        | "write failing test first", "TDD"                          |
| Verify   | systematic-debugging           | "修 bug", "系统调试"                                       |
| Verify   | boundary-testing               | "触发语义", "force smoke", "detector drift" (axis1→axis2)  |
| Verify   | verification-before-completion | 完成 / 对照计划 / 对照 spec / this run's basis + 实测      |
| Review   | code-review                    | "review", "PR", "审代码", "dual-axis"                      |
| Review   | review-report-repair           | "GATE: BLOCKED", "High unresolved", "修审查意见"           |
| Defining | logicsync                      | "vague request", "长访谈", "盘问"                          |
| SSOT     | domain-modeling                | "glossary", "ADR", "CONTEXT.md"                            |
