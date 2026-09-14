# Test Shape — Pyramid, Patterns, Anti-Patterns

Companion to `test-driven-development` SKILL.md. Load when choosing test level or writing style; not required for every RED→GREEN loop.

## Pyramid (~80 / 15 / 5)

| Level                | Share | Role                                   |
| -------------------- | ----- | -------------------------------------- |
| Unit (small)         | ~80%  | Pure logic, isolated, milliseconds     |
| Integration (medium) | ~15%  | API / DB / FS boundaries, localhost OK |
| E2E (large)          | ~5%   | Critical user flows only               |

**Beyoncé rule:** if you liked the behavior, put a test on it. Infra/refactor/migration is not your bug net.

### Size (resource model)

| Size   | Constraints                           | Speed   |
| ------ | ------------------------------------- | ------- |
| Small  | Single process; no I/O / network / DB | ms      |
| Medium | Multi-process OK; localhost only      | seconds |
| Large  | External services allowed             | minutes |

### Pick a level

- Pure logic, no side effects → unit (small)
- Crosses API / DB / FS → integration (medium)
- Must work end-to-end for a critical path → E2E (large)

## Writing rules (short)

- **State, not interactions** — assert outcomes, not call sequences
- **DAMP over DRY in tests** — each test reads as a full spec
- **Real > fake > stub > mock** — mock only at slow / nondeterministic / side-effect boundaries
- **AAA + one concept** — Arrange / Act / Assert; one behavior; name like `"rejects empty titles"`

Code examples: [`testing-patterns.md`](testing-patterns.md).

## Anti-patterns

| Anti-pattern                   | Fix                                       |
| ------------------------------ | ----------------------------------------- |
| Testing implementation details | Assert inputs → outputs                   |
| Flaky (timing / order)         | Deterministic asserts; isolated state     |
| Testing the framework          | Test your code only                       |
| Snapshot abuse                 | Sparse; review every change               |
| Shared mutable fixture         | Each test owns setup/teardown             |
| Mocking everything             | Prefer real implementations at boundaries |
