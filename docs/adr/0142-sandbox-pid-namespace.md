# 0142. The fence unshares the pid namespace: no descendant outlives it

Date: 2026-10-15
Status: accepted
Deciders: operator
Related: ADR-0097 (the fence's constant `--unshare-net`; this ADR adds the second constant namespace flag and keeps the same "no input strips it" discipline), ADR-0021 (the background lifecycle guardrail `--die-with-parent`), ADR-0134 (the foreground runtime deadline and its cleanup evidence), ADR-0022 (background task stop), ADR-0119 (yolo retires the fence wholesale, so it is untouched by this ADR)

Spec: none — the fence's parameter set is pinned by `src/harness/sandbox/bwrap.ts` and its tests; there is no sandbox spec file, and this ADR does not introduce one.

## Context

The fence guaranteed that a *process* would not survive a tool call, and it did not guarantee that a *descendant* would not. Two mechanisms covered termination, and both had a hole.

Teardown is process-group directed. `runner.ts` and `background/manager.ts` both send `SIGTERM` to the group, wait a grace window, then `SIGKILL` the group. A process group signal reaches every member **except** processes that left the group — and `setsid`, `daemon(3)`, and any supervisor that double-forks all do exactly that.

`--die-with-parent` does not close it. That flag covers bwrap's **direct** child only. A grandchild two levels down is outside its reach.

So a fenced command could run:

```sh
setsid sh -c 'exec sleep 300' &
```

detach into a fresh process group, and keep running **on the host** after the tool call had already returned and reported a settled cleanup — holding its port, its CPU, and its file handles. The caller was told the work was stopped; a process was not.

This was not hypothetical: it is the ordinary shape of "start a server, walk away", which is one of the things `background: true` exists to do.

A second, subtler gap pointed the same way: a fenced command that learned its own pid (`echo $$`) wrote a **host-visible** pid, and the harness had no way to make that pid mean anything after teardown.

## Decision

Add `--unshare-pid` to the fence's constant namespace block, next to `--unshare-net`, in `baseArgs` (`src/harness/sandbox/bwrap.ts`).

The pid namespace makes the fence's lifetime the hard boundary. bwrap becomes PID 1 of a namespace whose only other members are the fenced command and its descendants, and the kernel kills **every remaining process in the namespace** when that init exits. A `setsid` descendant cannot escape this: it changes its process group and its session, but it cannot leave the pid namespace it was born in. There is no ordering in which it outlives the fence.

`--unshare-pid` is **constant**, exactly like `--unshare-net`: no option, no conditional, no escape hatch. Both fence tiers and both routes (foreground / background) go through the one assembly point, so all of them get it. The yolo branch returns bare argv *before* `baseArgs` is reached and is therefore untouched — consistent with ADR-0119, where yolo retires the fence wholesale rather than relaxing it.

## Consequences

### A namespace's init does not answer a plain SIGTERM

The kernel does not deliver default-disposition signals to a namespace's init. bwrap is two processes — a parent that performs setup, and a child that becomes PID 1 of the namespace — so under this ADR the **first** SIGTERM round reaches the parent and leaves the init running.

Measured on this host: group `SIGTERM` → the parent dies, the ns-init survives (`NSpid: <host> 1`); a direct `SIGTERM` to the ns-init is ignored; `SIGKILL` to it works, and takes the rest of the namespace with it.

This exposed a latent coupling in the background teardown. `requestTeardown` armed two timers of the same length: the 2 s `waitForProcessGroupGone` observation and the 2 s SIGKILL fallback. The observation polls every 20 ms, so it always expired **before** the escalation fired and settled the task as `unconfirmed` — reporting a group that drained moments later as one that did not. Separately, the escalation's own guard `t.client.status === "running"` skipped itself whenever the direct child had already exited (the status migrates to `killed` within ~100 ms of the first SIGTERM) — which is precisely the case under a pid namespace, where the child exits but the group stays full.

Both are fixed in this ADR, in `src/harness/background/manager.ts`:

- the observation no longer settles the task on the SIGTERM window alone; if the group has not emptied, the escalation chain owns the verdict;
- the escalation's guard asks whether **this teardown** is still in flight (`task.killFallback` is set) rather than whether the task is still `running`, so a dead direct child with a live group still escalates.

The escalation guard keeps its original purpose — `clearTaskTimers` (whose only caller is `shutdown()`) clears `killFallback` before shutdown escalates, so a duplicate round is still prevented.

`confirmed_stopped` is **not** relaxed. Its contract stays: a group with any live, non-zombie member is still reported as alive, and only an emptied group is reported as stopped. What changed is that the verdict now comes from a chain that can actually clear a pid namespace.

### A fenced pid is no longer a host pid

`echo $$` inside the fence now yields a namespace pid. On this host a fenced `$$` is 4, and the host answers `kill -0 4` with ESRCH — for the wrong reason. Any test that probed such a pid would have gone green against a broken fence.

This is a test-facing consequence only; no product code reads a pid from inside the fence. `runner.ts` and `manager.ts` both operate on `child.pid` — the host pid of the `bwrap` process itself — which is unchanged. `/proc/<pid>/stat` starttime reads (`background/proc.ts`, `subagent/worker-identity-stop.ts`) likewise read host pids.

The harness therefore locates fenced processes by a **host-unique argv marker** instead of by a pid file: the fixture renames its process (`exec -a <marker> …`) and the test resolves the real host pid with `pgrep -f '^<marker>'`. `tests/harness/aci/tools/spawn-test-utils.ts` carries the shared helpers, and each case still proves the liveness half before the teardown half, so a green run cannot mean "nothing ever started".

### The fence can no longer see the host's processes

Inside the namespace, `ps` and `/proc` show only the fence's own processes. A fenced command can no longer enumerate host processes.

This is accepted deliberately: it is the same posture `--unshare-net` already takes on the network axis, where the fence is closed to the host and the only egress is the proxy seam. Process enumeration is not a capability any fenced task needs, and the `/proc` subtree stays excluded from the protected-target walk exactly as before (`bwrap.ts`'s `classifyProtectedEntry`, `credential-read-mask.ts`) — the guest's `/proc/self/environ` is the `clearenv`'d one either way.

### Unchanged: the residual in `egress/session.ts`

The egress seam documents that the proxy token rides the fence's `bwrap --setenv` argv and is briefly readable by local users via `/proc/<pid>/cmdline`. **This ADR does not close that residual.** bwrap's own argv lives in the host's pid namespace, so it stays readable there exactly as before. No security regression, and no security claim to retire.

### Unchanged: resource limits

`resource-limits.ts` projects nothing onto argv — there is no `--rlimit` and no `setrlimit` anywhere in `src/`, and `MAX_PROCS` is an unconsumed constant (a test pins that). So there is no `RLIMIT_NPROC` interaction: the limit would have been enforced per-UID host-wide and pid namespaces do not scope it. If rlimits are ever wired up, that pairing needs its own ADR.

## Rejected

**Walk the process tree and kill descendants explicitly.** The reliable sources of the descendant set — `/proc` scanning, `psutil`, or cgroup tracking — are all either unavailable inside the fence or a second mechanism to get wrong. The pid namespace makes the kernel do this exactly and for free, at the namespace's own init.

**Rely on `--die-with-parent` alone.** It covers the direct child only; a `setsid` grandchild is already outside it.

**Signal the process group by walking up to the session.** `--die-with-parent` plus a session sweep would not help: the failing case is a process that left the group, and the session is a weaker handle than the namespace, not a stronger one.

**Keep the pid namespace but make `processGroupAlive` treat a namespace-init-only remainder as gone.** This is the change this ADR deliberately does *not* make: the remainder is a live process with live children, not an artefact, and calling it "stopped" would report a lie. The escalation fix makes the verdict true instead of redefining it.

## Verification

- `tests/harness/aci/bash-setsid-detached.test.ts` — a `setsid` grandchild launched by a fenced command is gone from the host after the foreground deadline and after `bash_stop`; both routes, proven red before this ADR and green after.
- `tests/harness/background/pidns-teardown-race.test.ts` — a `--unshare-pid` fence settles as `confirmed_stopped`, and the host agrees the group is empty.
- `tests/harness/aci/tools/bash.test.ts` and `tests/harness/aci/bash-foreground-deadline.test.ts` — the pre-existing "no surviving descendant" cases, moved onto argv-marker lookup so they keep pinning the invariant under the new pid semantics.
