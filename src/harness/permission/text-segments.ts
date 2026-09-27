/**
 * Internal text-segmentation seam (SC-S4-6): the quote-blind splitter that
 * the degrade arms read when there is no `ok` parse to answer from.
 *
 * This is the retired public `hard-walls.splitShellSegments` contract moved
 * behind an internal module. It is NOT a public surface: `aci/index.ts` and
 * `aci/permission.ts` do not re-export it, and no `ok`-path consumer computes
 * a verdict from its segments any more (SC-S4-2). It survives because three
 * quote-blind degrade arms legitimately still need `string[]` segments over
 * raw text and must not be thinned by this migration (R2 / SC-GATES-4):
 *   - `splitForDangerousScan` (`hard-walls.ts`), the `parser-unavailable`
 *     dangerous scan;
 *   - `isAllowedFromTextFold` (`hard-walls.ts`), the allowlist gate's
 *     declared non-`ok` fold (SC-S4-2's keep-today's-answer re-home);
 *   - `validateReadonlyTextPath` (`bash-readonly.ts`), the declared non-`ok`
 *     fold that keeps today's answer and adds no throw.
 *
 * The body is byte-for-byte the former `hard-walls` export — one copy, shared
 * by all survivors so the jscpd floor cannot trip on a duplicate.
 */

/**
 * Split a command into top-level segments on `;`, `&&`, `||`, and a lone
 * `|`. Each segment is independently validated against the allowlist /
 * dangerous-pattern checks so compound commands made of read-only tokens
 * (e.g. `ls -la ~/.iknow 2>/dev/null; echo ---; ls | head -30`) are no longer
 * denied wholesale for containing shell metacharacters.
 *
 * Conservative: backslash-escaped separators (`\;`) are kept literal so a
 * command like `r\m -rf /` does NOT split into `r` + `m -rf /` and remain
 * matched by the substring scan in `findDangerousPattern`.
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = "";
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === "\\" && i + 1 < command.length) {
      buf += ch + (command[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (isSegmentCutAt(command, i)) {
      segments.push(buf);
      buf = "";
      if (command[i + 1] === ch) i += 1;
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) segments.push(buf);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Is index `index` the start of a top-level cut: `;`, the `&&` / `||` pairs,
 * or a lone `|`? The double-character pairs also consume their second
 * character via the caller's `command[i + 1] === ch` step. A bare `&` never
 * cuts (the readonly / allowlist strictenings answer it as an operand).
 */
function isSegmentCutAt(command: string, index: number): boolean {
  const ch = command[index];
  return (
    ch === ";" ||
    (ch === "&" && command[index + 1] === "&") ||
    ch === "|"
  );
}
