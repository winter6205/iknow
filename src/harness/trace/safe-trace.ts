/**
 * safeTrace wrapper — the centralized "never throws" contract: swallow a
 * rejected Promise (resolves to undefined) without swallowing sync throws
 * from calling fn itself.
 *
 * The implementation must stay NON-async:
 *   - in an `async function` V8 would wrap any sync throw in the body into a
 *     rejected Promise, silently caught by onRejected — violating "never
 *     swallow sync throws from fn()";
 *   - non-async: a sync throw during fn() evaluation propagates upward (a
 *     programming error, must not be swallowed), while a rejection of the
 *     returned Promise is caught → undefined (IO error, swallowed).
 *
 * Return type `Promise<T | undefined>`: even without throwing, fn's result
 * can itself be undefined (JsonlTraceService write-failure path).
 */
export function safeTrace<T>(fn: () => Promise<T>): Promise<T | undefined> {
  return fn().then(
    (value) => value,
    () => undefined
  );
}
