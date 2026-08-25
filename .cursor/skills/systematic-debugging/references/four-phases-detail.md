# Four Phases — Detailed Walkthrough

Complete walkthrough of REPRODUCE -> ISOLATE -> INSTRUMENT -> FIX with a worked example.

## Phase 1: REPRODUCE

**BEFORE attempting ANY fix:**

1. **Get the failing command or failing test.**
   - Exact command, exact test name, exact environment.
   - Run it. Confirm it fails the same way every time.
   - Save the exact stdout + stderr + exit code.

2. **If intermittent (flaky), STOP.**
   - "Cannot reproduce" = cannot fix.
   - Add deterministic reproduction: fixture, seed, mock, network stub, time freeze.
   - Repeat 10x. Only when fail rate >= 90% proceed.

## Phase 2: ISOLATE

**Bisect to the offending change, not the symptom location.**

3. **Bisect to smallest change.**
   - `git bisect start` / `git bisect bad` / `git bisect good` for history.
   - Or remove code/config until failure disappears, then add back.
   - Or `git log --oneline -20` + read commits in reverse chronological order.

4. **Identify the actual offending line / commit / config.**
   - Symptom location (where the error surfaces) is NOT root cause (where bad value originates).
   - Trace data backward: where does bad value originate? What called this? Keep tracing up.
   - Fix at source, not at symptom.

## Phase 3: INSTRUMENT

**Add the smallest evidence that proves the hypothesis. Never guess.**

5. **Add the smallest possible log / print / debugger break.**
   - One log at the suspected root cause line.
   - One log at each boundary crossing (function entry/exit, API request/response).
   - Run once. Read evidence. Confirm hypothesis OR form new one.
   - Do not add `try/except: pass` to silence the error. That is symptom-patching.
   - Do not ask for direction without showing the log output first.

## Phase 4: FIX

**Apply the minimum fix. Verify with the failing test going green.**

6. **Apply minimum fix at root cause.**
   - ONE change at a time.
   - No "while I'm here" improvements.
   - No bundled refactoring.
   - Re-run the failing test. Confirm green.
   - Run the full suite. If new failures: the fix is wrong — return to Phase 1.
   - Report must state that root cause was identified AND fix verified end-to-end.

---

## Worked Example

4-phase (REPRODUCE -> ISOLATE -> INSTRUMENT -> FIX) complete walkthrough. Scenario: pytest 5/12 failing, `test_payment_processor::test_concurrent_payments` is flaky.

### Phase 1: REPRODUCE

1. Capture the failing command:

   ```bash
   $ pytest tests/test_payment_processor.py::test_concurrent_payments -v
   FAILED tests/test_payment_processor.py::test_concurrent_payments - AssertionError: expected balance 100, got 50
   === 5 failed, 7 passed in 12.34s ===
   ```

2. If flaky, STOP. Add deterministic reproduction:
   ```bash
   $ for i in {1..10}; do pytest tests/test_payment_processor.py::test_concurrent_payments 2>&1 | tail -1; done
   # 8/10 failed, fail rate 80% (>= 90% threshold; tighten to 100% deterministic)
   # Add fixture: fixed datetime, fixed thread pool size, fixed DB seed
   ```
   Note: fail rate < 90% blocks Phase 2 because hypothesis would be polluted by noise. Fixtures lock external state so the race condition surfaces deterministically.

### Phase 2: ISOLATE

3. Bisect to the smallest change:

   ```bash
   $ git log --oneline -20 -- tests/test_payment_processor.py
   # abc123 (HEAD)  feat(payment): add concurrent payment processing
   # def456       refactor: extract payment service from order service
   # ghi789       (older)

   $ git stash  # test def456
   $ pytest tests/test_payment_processor.py::test_concurrent_payments -v
   # 0/10 failed at def456 -> flaky introduced by HEAD commit
   ```

4. Identify the actual offending line:
   ```bash
   # HEAD commit diff: payment_processor.py:42-67 (new concurrent processing)
   # Symptom location = line 89 (assertion failed) NOT root cause = lines 42-67 (concurrent logic)
   ```
   Note: symptom (assertion fail) != root cause (concurrent logic). Trace data backward: where does `balance=50` come from? -> `_charge()` return value -> called at lines 42-67 -> shared resource race.

### Phase 3: INSTRUMENT

5. Add minimum log at root cause:
   ```python
   # Edit payment_processor.py:42
   import logging
   logger = logging.getLogger(__name__)

   def process_payment_concurrent(payments: list[Payment]) -> Result:
       with ThreadPoolExecutor(max_workers=10) as ex:
           futures = [ex.submit(_charge, p) for p in payments]
           results = [f.result() for f in futures]  # wait for all
           logger.info(f"concurrent results: {results}")  # hypothesis 1: race on shared resource
           return results

   # Run once, read log:
   # INFO concurrent results: [50, 50, 100, 50, ...]  # multiple payments return 50 (charge not committed, or race)
   # Hypothesis 1 verified: race condition on `_charge` shared DB session
   ```
   Note: instrumentation must precede the hypothesis, not follow it. Log position = hypothesis position, not symptom position.

### Phase 4: FIX

6. Apply minimum fix at root cause:
   ```python
   # Edit payment_processor.py:42 — independent DB session per thread (race fix)
   def process_payment_concurrent(payments: list[Payment]) -> Result:
       results = []
       with ThreadPoolExecutor(max_workers=10) as ex:
           def _charge_with_session(p: Payment) -> ChargeResult:
               with db.session_scope() as session:  # independent session per thread
                   return _charge(p, session)
           futures = [ex.submit(_charge_with_session, p) for p in payments]
           results = [f.result() for f in futures]
       return results

   # Re-run failing test:
   $ pytest tests/test_payment_processor.py::test_concurrent_payments -v
   # 10/10 passed in 8.50s ✅

   # Run full suite:
   $ pytest tests/ -v
   # 12/12 passed ✅ (no new failures)

   # Report:
   Root cause identified: race condition on shared DB session. Fix verified: 10/10 deterministic, 12/12 full suite.
   ```
   Note: minimum fix = independent session per thread, NOT refactoring to queue / actor model / distributed lock (scope creep). Original failing test 10/10 green + full suite 12/12 green = fix verified.

---

## Phase Summary

| Phase      | Key Action                                                           | Anti-pattern                                           |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| REPRODUCE  | fail rate >= 90% before next step                                    | guess fix on flaky test                                |
| ISOLATE    | bisect for offending commit, distinguish symptom vs root cause       | patch symptom location (assertion line)                |
| INSTRUMENT | log at root cause, hypothesis first then instrument                  | print at symptom and read later                        |
| FIX        | minimum fix at root cause, full suite verifies, red test turns green | drive-by refactor / try-except swallow / bundled fixes |

**Adaptable:** any flaky / failing test follows this 4-phase flow. pytest / vitest / playwright / Go test are isomorphic.
