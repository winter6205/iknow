# 0148. Per-call concurrency safety — a read-only bash may share a wave; anything uncertain stays serial

Date: 2026-10-20
Status: accepted
Deciders: operator
Related: ADR-0147 (the two-stage permission gate this runs inside — its wave shape and its verdicts are unchanged), ADR-0101 (same-round parallel spawn — the same "several calls in one turn may run at once" idea, for a different tool), ADR-0146 (the session-resident egress agent — its per-call endpoint is what keeps concurrent calls' violations apart), ADR-0141 (the fence posture — its spec invariant 9, every fenced call re-checks bwrap, so concurrent calls each re-check), ADR-0068 (hard wall — unchanged), ADR-0037 / ADR-0109 (`validateReadonlyCommand` "serves readonly mode only" — that clause stands in its scope, see §8; its literal reading is annotated below)

> Contradicts ADR-0037 / ADR-0109 — but worth reopening because the readonly table answers a **mode admission** question, not the worktree gate's **write prediction** question ("will this write the workspace?"), and the two diverge in both directions: it once over-refused a legitimate read (`2>&1` — the recorded reason of Amendment 2026-09-04, withdrawn by Amendment 2026-10-10) and it still **admits** `git status`, which does write the workspace's `.git/index` (Context fact 5) — which is why that gate keeps its own narrower predicate; the concurrency question is a **different** one ("may this call share a wave?"), where a false positive costs concurrency and never correctness (each concurrent call still builds its own fence and its own egress endpoint; the permission axis is untouched); and the standing clause's **scope** holds: readonly mode is still the only place the table is a **gate**, and here it is one conjunct of a **stricter** conjunction that can only refuse. Detail: §8.

Spec: none — this is a performance decision inside the wave scheduler. The wave shape it encodes is the shared partitioner's rule (`src/harness/tools/concurrency-waves.ts`), applied incrementally in `src/harness/aci/aci-executor.ts`; the fence posture it leans on is `specs/yolo-mode.md` invariant 9 (ADR-0141).

## Context

**Facts 1–5 are the base's facts, verified against the real code at `4d8bf890`** (the commit before this change) and, for facts 4 and 5, by **running** that code. The implementation of this ADR landed in parallel with it, so the citations are by file and function name rather than by line number — the line numbers were still moving while this ADR was written.

**1. Concurrency safety is a static per-tool boolean.** `AciMeta.isConcurrencySafe` (`src/harness/aci/types.ts`) is one boolean per **tool**, not per call. bash declares `false`, and it must: most bash calls mutate the filesystem, and nothing about the tool's name says otherwise. The consequence is that every bash call is a singleton wave — a turn that asks for `git status`, `ls` and `cat file` pays three sequential fence assemblies for work that is trivially parallel.

**2. A batch is split into waves in two places, and both split sites read that same static flag.** The engine's batch split (`src/harness/loop-engine.ts`, `runToolPhase`, the `partitionConcurrencyWaves` call) and the ACI executor's incremental per-wave scan (`src/harness/aci/aci-executor.ts`, `toWaveItem` → `scanWave`). The executor's scan encodes the shape rule verbatim: a call joins the current wave iff it is concurrency-safe **or** its verdict is `deny` (a denied call has no side effect, so it rides along in its neighbours' wave — the #653 behaviour).

**3. The fence cannot backstop a wrong answer.** The bwrap fence bind-mounts the **host root writable** — `--bind / /`, with the argv comment "Host root: real paths visible and writable" (`src/harness/sandbox/bwrap.ts`). `cwdReadonly` adds exactly **one** more mount, `--ro-bind <cwd> <cwd>`, so the cwd is read-only and **everything outside the cwd is still writable inside the fence**. The system prefixes (`/usr`, `/bin`, `/lib`, `/lib64`, `/etc`, plus on-disk `/opt` and `/snap`) are re-bound read-only over that writable base, but the root itself is not. So "this command is read-only" being wrong is not a contained mistake: it is a real write to the host filesystem, at whatever path the command names.

**4. The readonly validator has three gaps, verified against the real implementation.** `validateReadonlyCommand` (`src/harness/aci/tools/bash-readonly.ts`) **PASSES** `cat $(touch x) f`; it **PASSES** ``echo `touch x` ``; and it **PASSES** `ls\ntouch x` (a real newline). The third is structural: the shell segment splitter cuts on `;`, `&&` and `|` but **not** on a newline (`src/harness/permission/text-segments.ts`, `isSegmentCutAt`), so the second statement rides inside the first segment and the validator judges the whole text as the first statement. `findDangerousPattern` (`src/harness/permission/hard-walls.ts`) returns **null** for all three: the substitution family answers `ask` there rather than a hit, and the destructive roster does not see the body of a substitution. **Neither existing policy closes these three holes** — a conjunction built on those two alone would let a write into a shared wave.

**The expansion gap is the whole family, not only the braced form.** The substitution gap above is not a `$(…)`-shaped hole: `validateReadonlyCommand` **PASSES** the unbraced `cat $HOME/x` and `echo x $REDIR` as well, and `findDangerousPattern` returns **null** for both. A braced and an unbraced `$` are the same unknowable expansion, so the predicate refuses **any** `$` and any backtick (Decision §4, conjunct 4) instead of only the shapes the validator is commonly probed with.

Two neighbouring cases matter as much, because they are the ones a cruder rule would get wrong. `ls 2>&1` **PASSES** the validator (an fd duplication is neither a background job nor an output-file redirect — ADR-0037's Amendment 2026-10-10), and `grep -o pat f` **PASSES** it (`-o` there is `--only-matching`).

**5. Two concurrent `git status` calls contend for the same index lock.** `git status` refreshes and rewrites the index, and the refresh takes `.git/index.lock` — the lock file is observable while the call runs (measured: on a 40k-file repository with a stale index, `.git/index.lock` appears during `git status`, and does **not** appear with `GIT_OPTIONAL_LOCKS=0`). The lock path is per **repository**, so two `git status` calls in the same repository contend for it, and the loser of that contention cannot create the lock — git's standard `fatal: Unable to create '<repo>/.git/index.lock': File exists.` (git's own message for a lock that is already held; reproduced against a held lock). Today `GIT_OPTIONAL_LOCKS=0` is injected **only** in readonly mode (`applyCwdReadonlyFenceEnv`, `src/harness/sandbox/env-isolation.ts`); the default `bashMode: "any"` path does not set it.

## Decision

### 1. The contract: a per-call predicate beside the static flag

A tool may now declare a per-call predicate, beside the static default:

```ts
export interface ConcurrencySafetyMeta {
  readonly isConcurrencySafe: boolean;
  readonly isConcurrencySafeForInput?: (input: unknown) => boolean;
}
```

(`src/harness/tools/concurrency-waves.ts`.) `AciMeta` inherits it (`src/harness/aci/types.ts`).

The static flag **stays**: it is the answer for a tool that declares no predicate, and every existing tool still declares only it. The new field is optional and additive — no existing tool's declaration changes, and no existing tool's behaviour changes.

The predicate receives the **raw** tool input (`unknown`), because the wave splitter asks its question **before** schema validation. The predicate therefore narrows the input itself and never trusts it.

### 2. The resolver: one shared answer

`isConcurrencySafeForCall(meta, input)` (`src/harness/tools/concurrency-waves.ts`) is the one place the question is answered:

- **no meta** (an unknown tool) → **false**. An unknown tool may not be assumed safe.
- **a declared predicate → it decides**, for every call of that tool: `predicate(input) === true`. The static default is **not** consulted for that call at all — the predicate is authoritative for its tool's calls.
- **a predicate that throws** → **false**. A predicate that cannot answer must never widen concurrency.
- **a predicate that returns anything other than exactly `true`** → **false**. Only an explicit `true` is an answer; a truthy non-boolean is not.
- **no predicate** → the static `isConcurrencySafe === true` decides, exactly as before.

The declared predicate is **authoritative** for the calls of the tool that declares it, in **both** directions: it may declare a call safe that the static default called unsafe (bash: a read-only command) and unsafe that the static default called safe. What may never happen is an **uncertain** answer widening concurrency: an unknown tool, a predicate that throws, and a predicate that returns anything other than exactly `true` all mean "not concurrency-safe" (§2's list above). "Uncertain ⇒ serial" is the whole safety argument of this ADR, and it is enforced in one function both split sites call.

### 3. Two split sites, one answer

Both split sites now ask the resolver:

- the **engine's batch split** — `src/harness/loop-engine.ts` calls `isConcurrencySafeForCall(def?.aci, call.input)` in the partitioner's predicate;
- the **executor's incremental scan** — `src/harness/aci/aci-executor.ts` sets `doesNotBreakWave: isConcurrencySafeForCall(def?.aci, call.input)` in `toWaveItem`, and `scanWave` joins on it with the deny arm.

**Both had to change, or the change is inert end to end.** The engine's split is the coarse one: it hands the executor one wave at a time, so a partition that still gives every bash call its own wave produces singleton waves — a wave that can overlap nothing. Changing only the executor's scan would judge a singleton wave's single call safe and then still run it alone.

The predicate must also survive the ACI catalog projection (`src/harness/permission/permission-executor.ts`, `project`): the projected def carries the predicate, written only when present, so a def without one projects byte-identically. The projection's job is **isomorphism with the source def** — the permission runtime's own view of the catalog must not drift from the defs it projects — and that is all it is. The **production executor path does not read the projected catalog**: `createAciExecutor` is built with the registry's own catalog (`catalog: reg.catalog` — `src/harness/build-engine.ts`, `src/harness/subagent/worker.ts`, `src/harness/aci/demo.ts`), whose defs carry the predicate directly. The projection change is therefore a correctness fix for the projection itself (its pass-through is covered by a test), not a precondition of the production path.

**The wave SHAPE rule is unchanged.** A call joins the current wave iff it is concurrency-safe **or** its verdict is `deny`; otherwise it breaks the wave and starts the next one. Only the _answer_ to "is this call concurrency-safe?" changed — from a static per-tool boolean to a per-call decision.

### 4. bash's predicate: the conjunction

bash's **tool-level default stays `isConcurrencySafe: false`** (`src/harness/aci/tools/bash.ts`): most bash calls mutate the filesystem, so the tool as a whole is not concurrency-safe. The per-call predicate (`isReadonlyBashConcurrencySafe`, `src/harness/aci/tools/bash-concurrency.ts`) answers the narrower question the wave splitter actually asks: **may this specific call join a wave of concurrent bash calls?**

It is a **conjunction** — all of the following must hold, and it never throws:

1. the input is a non-null object and `command` is a non-empty string;
2. `background !== true` — a background job is long-lived, outlives the wave, and never reaches the foreground fence env;
3. the command contains **no newline and no carriage return**;
4. the command contains **no shell expansion of any form** — **no `$` at all** (braced `${…}` or unbraced `$NAME`) **and no backtick**;
5. `validateReadonlyCommand(command)` does **not** throw;
6. `findDangerousPattern(command)` — called **without** the cleanup-root snapshot — returns **null**;
7. the command carries **no output form**: no `tee` command word, no `--output` / `--output=…` token, and no standalone `-o` token — except when the **first word** of the command is `grep` or `rg`, where `-o` is `--only-matching`. (This conjunct is **defensive redundancy** — see §5.)

Conjunct 6 is deliberately **stricter** than the bash handler's own call, which passes the cleanup-root snapshot (`src/harness/aci/tools/bash.ts`) and can therefore turn a `destructive-rm` hit into a bounded-cleanup exception. Strictness is the right direction for a concurrency judgment.

### 5. Why each conjunct exists

- **(1)(2) a well-formed, foreground call.** A background call is a long-lived process; it must never share a wave.
- **(3) the newline.** The segment splitter cuts on `;`, `&&` and `|` but not on a newline, so `ls\ntouch x` reaches the validator as one segment and **passes** it (Context fact 4). A newline is a statement separator the validator cannot see.
- **(4) shell expansion.** What `$(…)` / backtick / `${…}` / `$NAME` expand to is **not knowable at judgment time**, and a write can hide inside the expansion (`cat $(touch x) f` — Context fact 4). A parameter expansion is not a substitution, but it is equally unknowable: `cat ${HOME}/x` and the unbraced `cat $HOME/x` also pass the validator, and `findDangerousPattern` returns null for both (Context fact 4). The fence cannot backstop any of them (Context fact 3). The rule is therefore shape-blind — **any** `$` and any backtick are refused, including a literal `$` inside a file name (`cat file$.txt`). That false positive only costs concurrency, never correctness, so erring on the conservative side is free.
- **(5) the readonly policy.** It is the deny-by-default command-word roster (`src/harness/permission/command-roster.ts` → `READONLY_ALLOWED`) plus the per-command flag policies for `find` / `sort` / `git` (`src/harness/aci/tools/bash-readonly.ts`). It is **reused, not re-implemented**: one policy, one owner.
- **(6) the destructive wall.** The wall's own judgment about a destructive shape, minus the cleanup-root exception.
- **(7) the output form.** A route by which the call can write to a file. The scan is deliberately **quote-blind** and errs conservative: a false positive (`echo "tee"`) only costs concurrency, while a false negative would let a write into a shared wave. It is also **defensive redundancy**: the readonly policy already rejects every write form this scan targets, **structurally** (`tee` is not in the readonly command roster; `sort -o` and `git --output` are rejected by their own flag policies). So the only commands it refuses that the other conjuncts would have admitted are a handful of harmless read-only ones (`ls -o`, `od -o`, `find . -name tee`). It is kept because it is the guard that **survives a future roster change**: if `tee` ever enters the readonly roster, this scan is what still refuses the write form. (The plan's "validator 未覆盖则补在判定中" applies to the other conjuncts — the substitution, the newline and the expansion family — which the validator genuinely does not cover; the output-form scan is the one conjunct that is already covered.)

**Why there is no naive `>` scan.** `ls 2>&1` is a legitimate read-only call and it **passes** the validator (Context fact 4). A "contains `>`" scan would reject it. The validator's `>` claim already answers redirects precisely — the owned-redirect fact on the parse path, the fd-duplication carve-out on the text path (`src/harness/aci/tools/bash-readonly.ts`, `withoutFdDuplications` / `admitUnit`) — so the predicate does not re-answer that question with a cruder rule.

**Why `-o` is denied except for `grep` / `rg`.** `grep -o pat f` is a legitimate read-only call and it **passes** the validator; there `-o` means `--only-matching`. The exemption is scoped to the **first word**, because that is where `-o` is `--only-matching`; a standalone `-o` token anywhere else is an output-file argument.

### 6. The fence cannot backstop a misjudgment

This is why the conjunction is a conjunction. The fence bind-mounts the host root **writable** (`src/harness/sandbox/bwrap.ts`, `--bind / /`) and `cwdReadonly` adds exactly one more mount, `--ro-bind <cwd> <cwd>`. Everything outside the cwd is still writable inside the fence. A wrong "this command is read-only" verdict is therefore **not a contained mistake** — it is a real write to the host filesystem, at whatever path the command names. The fence is a mitigation for a validator hole _in the workspace_; it is not a backstop for a wrong concurrency judgment.

Two consequences, both of them the reason the rule is "uncertain ⇒ serial":

- the predicate is deny-by-default and **never throws** (`src/harness/aci/tools/bash-concurrency.ts` — the whole body is wrapped, and any throw answers `false`);
- a predicate that throws is answered `false` by the resolver (§2), never propagated.

### 7. `GIT_OPTIONAL_LOCKS=0` for a concurrency-safe call that runs git

A call the predicate judges concurrency-safe **and whose command runs git** gets `GIT_OPTIONAL_LOCKS=0` in its fence env (`src/harness/aci/tools/bash.ts`, `gitOptionalLocksFenceEnv` and the fence-env assembly). The variable is the **same one** readonly mode already injects (`applyCwdReadonlyFenceEnv`, `src/harness/sandbox/env-isolation.ts`); only the **trigger** is wider: _readonly mode_ (the mode) versus _a concurrency-safe git call_ (the call). Same variable, same precedent, wider trigger.

The reason is Context fact 5: `git status` refreshes and rewrites the index, and the refresh takes `.git/index.lock`; the lock path is per repository, so two concurrent `git status` calls in the same repository contend for it. `GIT_OPTIONAL_LOCKS=0` tells git to skip the optional index refresh, so the lock is never taken.

**The trigger has two halves, and both are needed.** The verdict answers "may this call share a wave?"; the second half answers "does this command actually run git?" (`commandInvokesGit`, `src/harness/aci/tools/bash-concurrency.ts`). The second half is not decoration: the variable is **git-specific**, so a read-only call that never runs git (`ls`, `pwd`, `cat file`) must not carry it — injecting it there would put a git-specific variable into the env of every read-only call, for a race those calls cannot have. The second half reuses the readonly policy's own command-word notion (the roster's `flag_policy` table, `src/harness/permission/command-roster.ts`), so the two can never disagree about which unit is a git unit; a git word in ARGUMENT position (`cat git`, `ls /usr/bin/git`) is not an invocation and is not matched.

**The lone-call trade-off, stated plainly.** A per-call seam cannot know whether the call will end up sharing a wave. A git call that ends up **alone** in its wave still gets `GIT_OPTIONAL_LOCKS=0`: the injection is decided per call, from the call's own command, and the wave is decided later, by the splitter. That is the honest cost of a per-call trigger — the price paid for the protection when a neighbour *does* share the wave. Narrowing it further would need an "am I concurrent?" flag carried from the wave splitter (`aci-executor` → `permission-executor` → `bash`), i.e. the trigger would have to move from the call to the wave; this ADR keeps the trigger on the call, and the blast radius is exactly "a git call that ran alone carries one inert variable".

The injection is scoped exactly: a call the predicate **rejects** gets nothing added, so its env stays byte-for-byte today's (the spread of an empty object adds no key); a call that does not run git gets nothing added either; the background arm returns before the fence env and never sees it; and in readonly mode the variable is already `0`, so the concurrency-safe arm re-states the same value.

### 8. What this does not change

- **Readonly-mode admission is unchanged.** `bashMode === "readonly"` still calls `validateReadonlyCommand` **alone** (`src/harness/aci/tools/bash.ts`). The new predicate is a **concurrency** judgment — a strictly narrower question ("may this call share a wave?") — and it never loosens the readonly gate. A command the readonly gate rejects is not "unsafe to share a wave"; it is not admitted at all.
- **`validateReadonlyCommand` is not repurposed.** ADR-0037 and ADR-0109 record that it "serves readonly mode only" / "still serves only `bashMode === "readonly"`". **That statement stands in its scope** — the table is a gate in readonly mode and nowhere else; its literal reading as "used in no other place" no longer holds verbatim, and is annotated at the top of this ADR. This change uses it as **one conjunct of a strictly stricter conjunction**, in a **different question** (may this call share a wave?), and does not turn it into a gate for anything it did not already gate. The reuse is in the conservative direction: every command the readonly policy rejects is a command the predicate refuses to share a wave.
- **The last-read ledger does not reuse this predicate.** `docs/CONTEXT.md` forbids reusing `validateReadonlyCommand` as the ledger's admission rule (the **last-read ledger** entry's `_Avoid_` line). That prohibition stands; this change does not touch the ledger, and the ledger keeps its own admission rule.
- **The permission axis is untouched.** No verdict changes; no `deny` and no `ask` is relaxed; ADR-0147's two-stage gate is unchanged. This ADR changes where a call is **placed**, never what it is allowed to **do**.
- **One wave is not the same as one overlap.** This ADR fixes the wave's **shape**: five read-only bash calls are now one wave instead of five. Whether the calls of that wave physically overlap is still ADR-0147's business: its stage 2 starts the calls the policy **allows** together, and its stage 3 puts the calls it **asks** about to the user one at a time. bash sits in the `execute` category, whose default verdict is `ask`, so under the default policy the five calls are still asked one at a time and run one at a time; they overlap when the verdict is `allow` (a `--yolo` session, an "always allow" answer, or a project rule that allows bash). That is the two-stage gate's deliberate design ("two approval questions are never in flight at once"), and changing it would be a permission-axis change, which this ADR does not make.
- **A denied call still joins its neighbours' wave** (the #653 behaviour, unchanged).
- **The hard walls and the security review are unchanged** (ADR-0068).
- **The fence posture is unchanged.** ADR-0141's spec invariant 9 (`specs/yolo-mode.md`) still holds: bwrap presence is rechecked on **every** fenced call. Concurrent calls each re-check; a check result is not shared between concurrent calls.
- **The judged text and the executed text cannot diverge.** The predicate judges the command text **as the tool received it**, BEFORE the bash handler restores the secret placeholders (`<<<SECRET_N>>>` → the real value, `src/harness/secret-roundtrip/registry.ts`), while bwrap spawns the **restored** text. The gap is closed structurally: every placeholder contains a `>`, and the readonly policy rejects any `>` ("output redirection is not allowed", `src/harness/aci/tools/bash-readonly.ts`) — so `cat <<<SECRET_1>>>` is rejected by `validateReadonlyCommand` and the predicate answers `false`. A placeholder-bearing command is therefore never judged concurrency-safe, and no command the predicate accepts has an executed text that differs from its judged text.
- **The egress seam is unchanged.** ADR-0146's per-call endpoint gives each concurrent call its own socket, its own proxy policy and its own violation sink, so a violation raised by one concurrent call is attributed to that call alone.

## Plan corrections

The plan this implements (`plans/perf-d2-readonly-bash.md`, now in the repository) is corrected on four points. The deviations are on record here.

**C1 — the conjunction is seven conjuncts, not the plan's three.** Plan task 2 names three conditions: `validateReadonlyCommand` passes, `findDangerousPattern` returns null, and no output form. The implementation has seven: those three, plus the input shape, `background !== true`, the no-newline rule, and the no-expansion rule (any `$`, braced or not, and any backtick). The four extra conditions are not decoration: they close the three gaps of Context fact 4, which the plan's own two policy conjuncts do **not** close (`cat $(touch x) f`, ``echo `touch x` `` and `ls\ntouch x` all pass `validateReadonlyCommand`, and `findDangerousPattern` returns null for all three). The plan's own phrase "validator 未覆盖则补在判定中" — add to the judgment what the validator does not cover — is the rule the implementation follows; the plan under-counted how much the validator does not cover. (Recounted after the expansion rule was widened to the whole `$` family: it is still **one** conjunct, so the count is still seven.)

**C2 — the `-o` rule is scoped to the first word.** The plan lists "`-o` / `--output` 类输出参数" as one rule. The implementation exempts `-o` only when the **first word** is `grep` or `rg` (where `-o` is `--only-matching`), and denies a standalone `-o` token everywhere else. A blanket `-o` rule would have denied `grep -o pat f`, a legitimate read-only call.

**C3 — the `GIT_OPTIONAL_LOCKS` injection was not in the plan; the plan now records it.** The plan's task list did not mention it; the implementation adds it to the fence env for a concurrency-safe call that runs git. The reason is Context fact 5. The plan's invariant "并发调用共享 C 的代理时，各自子 socket、策略与违规记录互不串号" shows the plan was thinking about per-call isolation for the egress seam, but not for git's index lock. The addition is recorded here so the plan↔code delta is enumerated, and the plan file has since been amended to name the injection as part of task 1's delivery (and to record the lone-call cost of a per-call trigger, §7).

**C4 — the plan's anchors are pre-merge and are re-located by function name.** Plan task 1 cites `src/harness/aci/tools/bash.ts:1464` for the tool-level constant and `src/harness/aci/aci-executor.ts:283` for `doesNotBreakWave`; plan task 2 cites `bash.ts:1327` and `:1317` for the two policy calls. The plan says "C、D1 合入后按函数名重新定位", so this is the plan's own instruction, not a deviation — the citations above are the re-located ones, by function name.

## Why this is an ADR

The three ADR conditions — hard to reverse, surprising without context, the result of a real trade-off — all hold:

- **Hard to reverse** — the per-call concurrency contract lands on the **shared** tool metadata (`AciMeta`, `src/harness/aci/types.ts`), which is read by **both** wave-split sites (`src/harness/loop-engine.ts` `runToolPhase`; `src/harness/aci/aci-executor.ts` `toWaveItem`) and carried by the catalog projection (`src/harness/permission/permission-executor.ts` `project`). Reversing it later changes the scheduler's contract, the tool-metadata shape and the safety argument (§2, §3) at once, not one call site.
- **Surprising without context** — a reader who sees bash declare `isConcurrencySafe: false` and then finds read-only bash calls sharing one wave will read the code as contradicting itself; the **Context** section (facts 1–5) and §8 carry why it does not.
- **A real trade-off** — the **Alternatives rejected** section lists the alternatives that were genuinely weighed and why each lost (a second read-only bash tool, letting the predicate decide the permission verdict, failing open on a throwing predicate, reusing the readonly-mode gate as the concurrency gate, letting the fence backstop the misjudgment).

## Alternatives rejected

- **Keep the static flag and ship a second, read-only bash tool.** Rejected: the model asks for reads with `bash` because that is the tool it has; a parallel `read_only_bash` would be a second spelling of the same capability and would not change what the model asks for. The narrow question is real, so the answer belongs on the call.
- **Let the predicate decide the permission verdict as well.** Rejected: the predicate answers a **placement** question ("may this call share a wave?"), never a permission question. A declared predicate decides the **concurrency** answer for its tool's calls (§2) — and only that. The permission axis stays where it was: no verdict changes, no `deny` and no `ask` is relaxed, and ADR-0147's two-stage gate is untouched (§8).
- **Treat a throwing predicate as "safe" (fail open) so a buggy predicate cannot wedge the scheduler.** Rejected: a throwing predicate means the call's safety is **unknown**, and unknown must mean serial. A bug in a predicate costs concurrency, never correctness.
- **Reuse the readonly-mode gate as the concurrency gate.** Rejected: readonly mode is a _mode_ — it denies a command outright. The concurrency question is about _placement_. A command the readonly mode rejects is not thereby a command that may not share a wave, and the two questions must stay apart so that a performance change can never loosen the readonly gate.
- **Let the fence backstop the misjudgment (trust the predicate's optimism, skip the conjunction).** Rejected: the host root is bind-mounted writable; a wrong verdict is a real write (Context fact 3).
- **Add a naive `>` scan and deny `2>&1`.** Rejected: an fd duplication is a legitimate read-only call, and the validator already answers redirects precisely; a cruder second rule would deny real reads for no safety gain.
- **Inject `GIT_OPTIONAL_LOCKS=0` for every bash call.** Rejected: it would change the env of calls that are not concurrency-safe, for a race those calls cannot have — they run alone. The injection is scoped to the calls it protects. The same reasoning applies to the calls that ARE concurrency-safe but never run git: the variable is git-specific, so §7's second trigger half keeps it out of their env.
- **Change only the executor's scan.** Rejected: the engine's split hands the executor one wave at a time, so a partition that still isolates every bash call produces singleton waves and the change is inert end to end.

## Consequences

- Adjacent read-only bash calls in one turn now share a wave: `git status`, `ls`, `cat file`, `grep …` run concurrently instead of one wave each.
- The wave shape rule is unchanged, so a mutating bash call still breaks the wave and runs alone — as does any call the predicate cannot prove read-only.
- Every other tool's declaration is unchanged, so every other tool's wave placement is unchanged.
- A wave of concurrent bash calls runs N fence assemblies concurrently; each call builds its own fence, its own netns and its own egress endpoint (ADR-0146).
- The bash tool's **static** flag is still `false`, so a reader of the catalog alone still sees "bash is not concurrency-safe". The per-call predicate is what makes a specific call shareable, and the resolver is where the two meet — that is why the static flag is not simply flipped to `true`.
- `GIT_OPTIONAL_LOCKS=0` now reaches **git** calls that are concurrency-safe but not in readonly mode, and only those: a read-only call that never runs git (`ls`, `pwd`, `cat file`) carries no git-specific variable. For a readonly-mode call the env is unchanged (the same value from both paths).
- A concurrency-safe **git** call that ends up **alone** in its wave still carries `GIT_OPTIONAL_LOCKS=0` — the trigger is per call and the wave is decided later, so a per-call seam cannot tell "alone" from "sharing a wave" (§7). The blast radius is one inert variable on a git call that ran alone.
- The predicate is a pure function of the call's input: the same input always gives the same answer, and the answer does not depend on the wave the call lands in.

## Out of scope (separate follow-ups)

- Any change to the readonly-mode admission gate.
- Any change to the permission policy, the hard walls, the security review, or ADR-0147's two-stage gate.
- The last-read ledger's admission rule.
- A per-call predicate for any tool other than bash.
- Making `git status` (or any other command) safe to run concurrently **without** `GIT_OPTIONAL_LOCKS=0`.
- The background arm's fence env — `background: true` calls stay serial by construction.
