# Skill discovery flowchart

```
Task arrives
│
├── Scale router (sequence — invoke the current slot only)
│   ├── Scope 已定 + single session ─────────→ logicsync
│   ├── Scope 已定 + multi-session ──────────→ architecture-change-reviewer → writing-plans
│   └── Scope 未定 + multi-session ──────────→ architecture-change-reviewer → writing-plans
│                                              (session-handoff when the session must persist)
│
├── Defining what to build
│   ├── Vague / under-specified request ──→ logicsync
│   ├── Glossary / ADR / SSOT decision ───→ domain-modeling
│   ├── Don't know what you want yet ────→ logicsync
│   ├── Have rough concept, need variants → wayfinder
│   └── New project/feature/change ───────→ spec-driven-development
│
├── Planning implementation
│   ├── Spec ready, ACR not yet / not yes ─→ architecture-change-reviewer
│   ├── ACR all-yes, next artifact is plan → writing-plans
│   └── Single-file or trivial ──────────→ minimal-change-verifier
│
├── Implementing code
│   ├── TDD: failing test first ──────────→ test-driven-development
│   ├── 5-class boundary contract ────────→ defensive-contract-validator
│   ├── Module boundary violation ───────→ bounded-context-guardian
│   ├── ESLint complexity / fn>60 or file>1000 ───→ complexity-anti-drift
│   └── Empty catch / null-on-failure ───→ error-handling-enforcer
│
├── Verifying
│   ├── Bug / something broke ───────────→ systematic-debugging
│   └── Pre-merge final check ──────────→ verification-before-completion
│
├── Reviewing
│   ├── Pre-impl 5-verdict ─────────────→ architecture-change-reviewer
│   ├── Post-impl dual-axis review ──────→ code-review
│   └── GATE BLOCKED / High open ───────→ review-report-repair
│
├── Committing / branching
│   └── diff is one task / no drive-by ─→ minimal-change-verifier
│
└── Meta / orchestration
    ├── Creating/editing SKILL.md ─────→ skill-authoring (user must name it)
    ├── Self-evolving rules ───────────→ self-evolving-rules (user must name it)
    ├── First-time / migrate setup ────→ setup-arthurpower
    └── 2+ independent tasks to fan out → dispatching-parallel-agents
        (current agent runs the skill; workers do the work)
```

`architecture-change-reviewer` is model-invoked (5-line verdict still blocks on `no` / `unclear`). `writing-plans` and `spec-driven-development` are user-invoked gates. `dispatching-parallel-agents` is model-invoked: the current agent fans out workers.
