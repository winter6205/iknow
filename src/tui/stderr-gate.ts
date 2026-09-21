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
 * no-op), so every runTui exit path may call `end()` unconditionally. The
 * replay guarantee is wired on the two runTui exits (normal / catch) that
 * restore the terminal first; a signal shutdown (runtime.ts re-kill path)
 * never restores the main screen at all — a pre-existing gap outside this
 * module — so on that path the buffer is lost with the process, by design
 * of the wiring, not silently contradicted here.
 */

/** Minimal shape of `process.stderr` the gate patches (injectable for tests). */
export interface StderrWriteTarget {
  write(chunk: string | Uint8Array): boolean;
}

/** begin/end lifecycle surface — what the process-wide wiring exposes. */
export interface StderrGateLifecycle {
  /** Arm the gate (idempotent). While armed, routed writes buffer. */
  begin(): void;
  /** Disarm and replay buffered chunks in order (idempotent, safe unpaired). */
  end(): void;
}

export interface StderrGateHandle extends StderrGateLifecycle {
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
          `[stderr-gate] ${lost} more chunk(s) dropped at the ${MAX_BUFFERED_CHUNKS}-chunk cap\n`
        );
      }
    },
    capture(chunk: string): boolean {
      if (buffer !== undefined) {
        if (buffer.length < MAX_BUFFERED_CHUNKS) buffer.push(chunk);
        else dropped += 1; // EXIT: over cap → counted drop, surfaced as one note at end().
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
 * gated for the TUI's lifetime. The incumbent writer is captured **at begin**
 * (not at construction) and restored **by reference** at end — an outer
 * interceptor installed earlier (e.g. a subprocess test driver that swaps
 * `process.stderr.write` before importing) regains the exact property it
 * owned, and the replay is delivered to it rather than stranding the capture.
 * The target parameter defaults to the real stream and exists so the
 * swap/restore contract is unit-testable.
 */
export function createProcessStderrGate(
  stream: StderrWriteTarget = process.stderr
): StderrGateLifecycle {
  let installed: { restore(): void; gate: StderrGateHandle } | undefined;
  return {
    begin(): void {
      if (installed !== undefined) return; // EXIT: double begin — one patch per begin/end cycle.
      // 还原按引用而非 bind 副本（spy/mockRestore 类消费方按身份比较）；
      // 但回放恒经 bind 后的 sink，不经被替换后的 stream.write → 无递归。
      const hadOwnWrite = Object.prototype.hasOwnProperty.call(stream, "write");
      const incumbent = stream.write;
      const gate = createStderrGate(stream, incumbent.bind(stream));
      installed = {
        restore(): void {
          if (hadOwnWrite) stream.write = incumbent;
          else delete (stream as { write?: unknown }).write; // 原本在原型上：交回原型解析。
        },
        gate,
      };
      stream.write = ((
        chunk: string | Uint8Array,
        encodingOrCb?: unknown,
        maybeCb?: unknown
      ): boolean => {
        gate.capture(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8")
        );
        // Node write 重载 (chunk, cb) / (chunk, encoding, cb)：缓冲是同步的，
        // 无错误即同步履行回调（丢弃 cb 会让等待回调的调用方挂起）。
        const cb =
          typeof encodingOrCb === "function"
            ? (encodingOrCb as () => void)
            : typeof maybeCb === "function"
              ? (maybeCb as () => void)
              : undefined;
        cb?.();
        return true;
      }) as typeof stream.write;
      gate.begin();
    },
    end(): void {
      if (installed === undefined) return; // EXIT: end without begin (assembly threw before arming).
      const { restore, gate } = installed;
      installed = undefined;
      restore();
      // Replay after the restore: flushed lines land on whoever owned the
      // stream before us (real stderr → main screen post-teardown).
      gate.end();
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
