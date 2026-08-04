export const CPU_SEC = 30;
export const MEM_BYTES = 1 << 30;
export const TMP_BYTES = 1 << 30;
export const MAX_PROCS = 256;
export const MAX_FD = 1024;

export interface ResourceLimitOptions {
  readonly cpu?: number;
  readonly mem?: number;
  readonly tmp?: number;
  readonly procs?: number;
  readonly fd?: number;
}

/**
 * v0 only the `tmp` value is enforceable (bwrap `--size`); CPU/mem/procs/fd
 * are policy constants exposed for v1 hooks (seccomp, cgroup v2).
 */
export interface ResourceLimits {
  readonly cpu: number;
  readonly mem: number;
  readonly tmp: number;
  readonly procs: number;
  readonly fd: number;
  toRlimitFlags(): string[];
}

interface LimitSpec {
  readonly value: number | undefined;
  readonly fallback: number;
  readonly minimum: number;
  readonly maximum: number;
}

function safeValue(spec: LimitSpec): number {
  const value = spec.value ?? spec.fallback;
  if (!Number.isFinite(value)) return spec.fallback;
  return Math.min(spec.maximum, Math.max(spec.minimum, Math.trunc(value)));
}

export function createResourceLimits(
  opts: ResourceLimitOptions = {}
): ResourceLimits {
  const limits = {
    cpu: safeValue({
      value: opts.cpu,
      fallback: CPU_SEC,
      minimum: 1,
      maximum: CPU_SEC,
    }),
    mem: safeValue({
      value: opts.mem,
      fallback: MEM_BYTES,
      minimum: 1,
      maximum: MEM_BYTES,
    }),
    tmp: safeValue({
      value: opts.tmp,
      fallback: TMP_BYTES,
      minimum: 1,
      maximum: TMP_BYTES,
    }),
    procs: safeValue({
      value: opts.procs,
      fallback: MAX_PROCS,
      minimum: 1,
      maximum: MAX_PROCS,
    }),
    fd: safeValue({
      value: opts.fd,
      fallback: MAX_FD,
      minimum: 1,
      maximum: MAX_FD,
    }),
    toRlimitFlags(): string[] {
      return ["--size", String(limits.tmp), "--tmpfs", "/tmp"];
    },
  };
  return Object.freeze(limits);
}

export type { ResourceLimits as ResourceLimitsPolicy };
