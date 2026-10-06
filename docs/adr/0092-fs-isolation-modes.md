# 0092. Filesystem isolation, two modes; global by default; session tmp on host paths

Date: 2026-09-13
Status: accepted

## Context

The permission layers (whether to ask a human) and "which paths bash may touch" were treated as one question; this ADR splits them into two layers. The previous default closed-world posture hid the home directory, which forced base paths and `/tmp` into two sets of names, and the model could not write the real `~/.iknow` paths.

## Decision

Two filesystem-isolation modes. The default is the **global mode**: real host paths are readable and writable; write interception relies on the permission layer + hard-wall; home is not hidden. The optional **workspace mode**: home is visible, writes = live `taskRoot` + **session tmp**; the rest of home is not writable by default. The session tmp is a host directory inside the session folder, one block per identity; `$TMPDIR` points at it, and it is **not** bind-mounted as a Linux-internal `/tmp`. This axis is orthogonal to `worktreeOnMutate`.

**Why not keep the closed world as default:** hiding home forces base paths and `/tmp` into two sets of names and keeps the model from writing real `~/.iknow` paths; what the operator wants as the default is host paths plus permission interception.

**Why not let the workspace mode write all of home:** that would be no different from the global mode; the tightening that defines the workspace mode is precisely that the rest of home is not writable (session tmp excepted).

**Why not drop bwrap:** sandbox discipline forbids un-fenced background runs on product paths; network / env / rlimit still go through the fence. This ADR changes only the FS posture and the tmp naming.

## Amendment 2026-09-13 — workspace-mode implementation contract (Round 2)

**Switch**: `settings.isolation.fsMode`, value domain `"global" | "workspace"`, **user layer only** (an `isolation` section appearing in a project file is discarded — the ADR-0084 allowlist does not include this section); missing / illegal value / non-string → treated as `"global"`, fail-closed (the same value-domain discipline as `worktreeOnMutate`; the single read point is `resolveFsIsolationMode`). At runtime the holder (mirroring `GraphModeContext`) flips in place; the engine is not rebuilt.

**Fence shape**: the workspace mode stacks two layers on top of the global-mode argv (bwrap last-mount-wins order) — `--bind / /` as the base → system-prefix `--ro-bind`s → **`--ro-bind <home> <home>`** (visible but read-only) → `--bind <taskRoot> <taskRoot>` + `--bind <session tmp> <session tmp>` (the two write whitelists overlaid back to writable) → `--proc` / `--dev-bind`. Home is "visible + read-only", not the closed world's "invisible"; writes inside home outside the two whitelists hit kernel-level EROFS (nonzero exit). Paths outside home (e.g. `/tmp`) are not tightened by this mode — it tightens home writes only and builds no identity wall between sibling repos (spec Out of scope).

**Write tools**: the containment root of `write_file` / `edit_file` is **the same** under both modes (live `taskRoot` ∪ session tmp) — the workspace mode adds no new rejection surface on the write-tool side; its tightening lands only in the bash fence's mount layer. The modes differ only in whether bash may write the rest of home.

**Why not base the workspace mode on `--ro-bind / /`:** that would also rebind read-only everything under `<user>` except `/tmp` and `/etc`, and the taskRoot / session tmp whitelists would each need an extra `--bind` layer on top of the read-only surface; `--bind / /` + `--ro-bind $HOME $HOME` needs only two overlays, keeps argv shorter, and minimizes the diff against the global mode.

**Why not add a write-tool-side home blacklist to the workspace mode:** the write tools' writable set is already taskRoot ∪ session tmp. The workspace mode's added semantics are "bash can no longer write the rest of home", which does not change the write tools; implementing it in both places means two implementations that can each drift.

> **2026-10-06 note (ADR-0139 / ADR-0140).** This rejection stands and is load-bearing for a later decision, so it is recorded here rather than left to be re-litigated: the paragraph above forbids **duplicating** this boundary, not deciding it in the permission layer. When a call leaves what the current mode permits, one boundary decision is made **before the call runs**, in the permission decision path where every other "does this call need the operator" question is already decided, and the operator is asked through the product's existing ask route (ADR-0140). The fence remains what physically enforces the mode's reach, so this is one decision plus the existing physical enforcement — not two implementations of the boundary. Recording the reason here so a later implementer does not conclude that asking at the fence is required, or that a second authority is forbidden. The boundary contract lives in `specs/permission-axis-semantics.md`.

## Consequences

- Amends ADR-0037 §9 (the default closed-world posture is superseded; the workspace mode may reuse the write whitelist).
- Amends ADR-0074 (lifetime and one-block-per-identity are retained; binding `/tmp` is superseded).
- Amends ADR-0068 temporary-surface wording (durable delivery is still `taskRoot`).
