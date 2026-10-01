/**
 * Read a `createKillSessionHook` interruption payload into a `ViolationRecord`.
 *
 * The PAYLOAD is read by one function, `parseViolationEvent` in
 * `sandbox/violation-handling.ts`; this file only gives that answer a trace
 * row's shape. It used to be a second, independent reader, and the two
 * disagreed: this one recognized `{mid, high, mid-escalation}` and rewrote
 * anything else to `"mid"`, while the serve hub's projection accepted only
 * `{mid, high}` and dropped a `mid-escalation` row entirely. One payload read
 * two ways is a payload whose meaning is whatever the reader felt like — and
 * the row that went missing is exactly the one SC12's join needs.
 *
 * Two things this deliberately does not do:
 *
 *  - **Decide anything.** The row records what the counter observed: a tier, a
 *    tool, a count, and the bounded cleanup evidence each plane reported. It
 *    carries no attribution verdict, and the host must not add one — "a deny
 *    alone does not prove harness causation" (spec #1170 Assumption 9).
 *  - **Coerce a cleanup verdict or a tier.** An interruption item whose
 *    cleanup does not match the closed three-state shape is dropped rather
 *    than defaulted, and a tier the producer did not name (or named with a
 *    label this build does not recognize) is left ABSENT on the row rather
 *    than rewritten to `"mid"`. A fabricated `confirmed_stopped`, and a
 *    fabricated severity, are the two failures this contract exists to
 *    prevent.
 *
 * Unknown / malformed fields are simply absent on the record, so a payload
 * from an older or newer producer still produces a readable row.
 */

import type { ViolationRecord } from "./types.js";
import { parseViolationEvent } from "../sandbox/violation-handling.js";

/**
 * Build the trace record for one interruption payload. `ts` is the caller's
 * observation time: the payload itself carries none, and stamping it here
 * keeps the two hosts' rows comparable without inventing a clock in the hook.
 *
 * `tier` is optional on the record: a payload that named none, or named one
 * this build does not recognize, produces a row with the field ABSENT. That is
 * a fact about the producer ("it named no tier"), and it is deliberately not
 * the same statement as a row recording `mid`.
 */
export function violationRecordFromReason(
  reason: string,
  ts: string
): ViolationRecord | undefined {
  const parsed = parseViolationEvent(reason);
  if (parsed === undefined) return undefined;
  return {
    ts,
    ...(parsed.tier !== undefined ? { tier: parsed.tier } : {}),
    tool: parsed.tool,
    // The raw reason, not an empty string: a payload whose `message` was
    // missing is still a payload, and its text is the only description of it.
    message: parsed.message === "" ? reason : parsed.message,
    ...(parsed.turnId !== undefined ? { turnId: parsed.turnId } : {}),
    ...(parsed.toolUseId !== undefined ? { toolUseId: parsed.toolUseId } : {}),
    ...(parsed.confirmedViolations !== undefined
      ? { confirmedViolations: parsed.confirmedViolations }
      : {}),
    ...(parsed.cleanup !== undefined ? { cleanup: parsed.cleanup } : {}),
    detail: parsed.detail,
  };
}
