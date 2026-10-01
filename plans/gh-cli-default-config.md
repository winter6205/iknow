# GitHub CLI startup under credential read protection

## Basis and evidence

The user reported that iknow cannot use `gh` and requested investigation of
the latest trace before opening an evaluation issue. Session
`2e4d3fd6-9aad-4c4a-b3e2-d2c9f5d66113` records `gh auth status` failing to
read `~/.config/gh/config.yml` with `permission denied`.

A real `gh` and bwrap fixture reproduces the failure without network access
or real credentials. The credential subtree mask covers config.yml, while
the egress layer restores only sentinel-masked hosts.yml. A late read-only
empty configuration overlay lets the same CLI start with defaults.

The initial two-file implementation spike was withdrawn before expanding
the change to the existing global-visibility assertion. The failing CLI
regression remains in place. This gate covers the complete implementation.

## Scope

- `src/harness/sandbox/credential-read-mask.ts`: generate a session-owned
  default config for a regular config.yml under the GitHub credential subtree;
  protect its source directory and apply it after the masks. Preserve explicit
  egress override priority. Never read or copy host configuration.
- `tests/harness/sandbox/credential-read-mask.test.ts`: exercise the real CLI,
  configuration and credential confidentiality, write protection, immutable
  generated sources, and the oversized-subtree fallback.
- `tests/harness/aci/bash-global-mode-visibility.test.ts`: recognize the paired
  synthetic config/source mounts without admitting a home/install read whitelist.
- `plans/gh-cli-default-config.md`: record the basis and preimplementation gate.

## Acceptance

1. A normal regular gh config does not prevent CLI startup; defaults are used.
2. Host config and real credentials remain unreadable; sentinel hosts remain usable.
3. Writes to host config and generated config sources are refused.
4. Other protected files and subtree fallback retain their protection.
5. A read-only authenticated GitHub request works through the fenced egress path.
6. Focused regressions, all sandbox and Bash integration suites, typecheck and complexity checks pass.

## Architecture gate

bounded-context-guardian: yes — the compatibility view stays in the existing credential read-mask module; no new dependency or context is introduced.
input-contract-tests: yes — cover absent/regular config, unsupported symlink handling, fallback size, independent source generation, and filesystem failures without expanding the public API.
error-handling-enforcer: yes — filesystem failures propagate; no failure is replaced by a readable host config or a successful empty result.
complexity-anti-drift: yes — one small configuration-view helper and the existing mount-plan orchestration retain separate responsibilities and bounded nesting.
minimal-change-verifier: yes — one CLI startup repair; no settings, credential roster, lockfile, permission-mode, or benchmark changes.

## Verification limits

Host aliases and custom gh configuration are deliberately not imported. This
fix supplies defaults and keeps the existing credential sentinel mechanism.
Symlink/non-regular config paths do not receive the new compatibility override.

## Verification scope refinement

The project-wide npm test run includes unrelated session and TUI suites.
After repairing the observed argv-stability regressions, delivery verification
uses every sandbox suite and every Bash integration suite plus the affected
role-substitution boundary suite, real authenticated execution, and static
checks. The broad run was stopped without claiming it passed. No TUI or
session implementation changed. This narrows test execution, not repair scope.
