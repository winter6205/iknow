/**
 * TUI-lifetime stderr gate.
 *
 * **Problem**: the OpenTUI alternate-screen renderer owns only its own draw
 * region; a raw `process.stderr.write` from a background module (lsp warmup /
 * notifier / memory discovery …) lands at the cursor position — visually
 * inside the input box (user-reported "no client available" bleed). Those
 * traces are intentional human diagnostics for non-TUI runs, so the fix
 * keeps them, not deletes them.
 *
 * **Design**: while the gate is begun (renderer live), writes are buffered;
 * `end()` — called after the renderer is destroyed and the terminal restored
 * to the main screen — replays the buffer in write order onto the real
 * stream. Nothing is lost, nothing bleeds (bounded by MAX_BUFFERED_CHUNKS,
 * overflow counted and noted, never silently dropped). Scope is the
 * `process.stderr.write` layer only; direct fd-2 writes from child processes
 * land on the main screen anyway and are out of scope.
 *
 * Re-entrancy: after `end()` the patch is removed, so a late caller still
 * holding the `capture` closure passes straight through to the real stream
 * (never re-buffered, never replayed twice).
 *
 * begin/end are idempotent (double begin = no-op; end without begin =
 * no-op), so every runTui exit path (normal / catch / signal) can call
 * `end()` unconditionally.
 */

/** Minimal shape of `process.stderr` the gate patches (injectable for tests). */
export interface StderrWriteTarget {
  write(chunk: string | Uint8Array): boolean;
}

export interface StderrGateHandle {
  /** Arm the gate (idempotent). While armed, routed writes buffer. */
  begin(): void;
  /** Disarm and replay buffered chunks in order (idempotent, safe unpaired). */
  end(): void;
  /** Write path for callers routed into the gate (the patched `write`). */
  capture(chunk: string): boolean;
}

/**
 * Buffer cap: a TUI session can run for days, so an unbounded buffer would
 * let a chatty background module grow with uptime. Past the cap the excess is
 * dropped and counted; `end()` appends one suppression note so the drop is
 * never silent.
 */
export const MAX_BUFFERED_CHUNKS = 500;

export function createStderrGate(
  target: StderrWriteTarget,
  sink?: (chunk: string) => boolean
): StderrGateHandle {
  let buffer: string[] | undefined;
  let dropped = 0;
  // 默认晚绑定经 target.write 解析（每次查属性）：注入替换 write 的宿主
  // （如 process.stderr）也能直通；生产门显式传 sink 锁定原始写入。
  const write =
    sink ??
    ((chunk: string): boolean => Reflect.apply(target.write, target, [chunk]));
  return {
    begin(): void {
      if (buffer !== undefined) return; // EXIT: already armed (single gate per runTui).
      buffer = [];
      dropped = 0;
    },
    end(): void {
      if (buffer === undefined) return; // EXIT: never armed / already ended (idempotent).
      const pending = buffer;
      const lost = dropped;
      buffer = undefined;
      dropped = 0;
      for (const chunk of pending) write(chunk);
      if (lost > 0) {
        write(
          `[stderr-gate] ${lost} more line(s) dropped at the ${MAX_BUFFERED_CHUNKS}-chunk cap\n`
        );
      }
    },
    capture(chunk: string): boolean {
      if (buffer !== undefined) {
        if (buffer.length < MAX_BUFFERED_CHUNKS) buffer.push(chunk);
        else dropped += 1;
        return true;
      }
      // EXIT: gate not armed (or mid-teardown) → straight to the real stream.
      return write(chunk);
    },
  };
}

/**
 * Production gate over a `process.stderr`-shaped stream: begin swaps the
 * stream's own `write` property, so every in-process bare
 * `process.stderr.write` (all background modules, no per-module opt-in) is
 * gated for the TUI's lifetime. The original writer is captured **at begin**
 * (not at construction) and restored at end — an outer interceptor installed
 * earlier (e.g. a subprocess test driver that swaps `process.stderr.write`
 * before importing) regains the property, and the replay is delivered to it
 * rather than stranding the capture. The target parameter defaults to the
 * real stream and exists so the swap/restore contract is unit-testable.
 */
export function createProcessStderrGate(
  stream: StderrWriteTarget = process.stderr
): StderrGateHandle {
  let installed:
    | {
        original: (chunk: string) => boolean;
        gate: StderrGateHandle;
      }
    | undefined;
  return {
    begin(): void {
      if (installed !== undefined) return; // EXIT: double begin — one patch per begin/end cycle.
      const original = stream.write.bind(stream);
      // sink=original（begin 期捕获）：回放恒走当时链上的真实写入（可能是
      // 外层拦截器），不经本门的 patch → 无递归。
      const gate = createStderrGate(stream, original);
      installed = { original, gate };
      stream.write = ((chunk: string | Uint8Array): boolean =>
        gate.capture(String(chunk))) as typeof stream.write;
      gate.begin();
    },
    end(): void {
      if (installed === undefined) return; // EXIT: end without begin (assembly threw before arming).
      const { original, gate } = installed;
      installed = undefined;
      stream.write = original as typeof stream.write;
      // Replay after the restore: flushed lines land on whoever owned the
      // stream before us (real stderr → main screen post-teardown).
      gate.end();
    },
    capture(chunk: string): boolean {
      // EXIT: not installed → pass-through to the current stream owner.
      return (
        installed?.gate.capture(chunk) ??
        Reflect.apply(stream.write, stream, [chunk])
      );
    },
  };
}

/**
 * Process-wide gate used by runTui's lifecycle wiring (one renderer per
 * process; begin/end are idempotent so every exit path may call end).
 */
const processGate = createProcessStderrGate();

/** Arm the process-wide gate (call after the renderer is created). */
export function beginStderrGate(): void {
  processGate.begin();
}

/** Disarm + replay (call after terminal restore on every exit path). */
export function endStderrGate(): void {
  processGate.end();
}
