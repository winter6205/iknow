/**
 * TTY detection and stdout/stderr writers for the product CLI.
 */

/** True when both stdin and stdout are TTYs (interactive product session). */
export function isInteractive(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

/** Write a line (or multi-line block) to stdout; ensures trailing newline. */
export function writeOut(text: string): void {
  if (text.length === 0) {
    process.stdout.write("\n");
    return;
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/** Write a line (or multi-line block) to stderr; ensures trailing newline. */
export function writeErr(text: string): void {
  if (text.length === 0) {
    process.stderr.write("\n");
    return;
  }
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

/** Clear current stderr line (best-effort; no-op when not a TTY). */
export function clearErrLine(): void {
  if (process.stderr.isTTY) {
    process.stderr.write("\r\x1b[K");
  }
}
