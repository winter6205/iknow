import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  CPU_SEC,
  MAX_FD,
  MAX_PROCS,
  MEM_BYTES,
  TMP_BYTES,
  createResourceLimits,
} from "../../../src/harness/sandbox/resource-limits.js";

describe("createResourceLimits", () => {
  it("uses safe defaults and exposes policy constants (no argv projection)", () => {
    const limits = createResourceLimits();
    assert.deepEqual(
      {
        cpu: limits.cpu,
        mem: limits.mem,
        tmp: limits.tmp,
        procs: limits.procs,
        fd: limits.fd,
      },
      {
        cpu: CPU_SEC,
        mem: MEM_BYTES,
        tmp: TMP_BYTES,
        procs: MAX_PROCS,
        fd: MAX_FD,
      }
    );
    // ADR-0092 全局档:围栏不再发射 --size / --tmpfs /tmp,`ResourceLimits`
    // 只保留 v1 hooks(seccomp / cgroup v2)消费的常量面。
    assert.equal("toRlimitFlags" in limits, false);
    assert.ok(Object.isFrozen(limits));
  });

  it("accepts positive overrides and clamps unsafe values", () => {
    const limits = createResourceLimits({
      cpu: 7.9,
      mem: 0,
      tmp: Number.POSITIVE_INFINITY,
      procs: 999,
      fd: -4,
    });
    assert.equal(limits.cpu, 7);
    assert.equal(limits.mem, 1);
    assert.equal(limits.tmp, TMP_BYTES);
    assert.equal(limits.procs, MAX_PROCS);
    assert.equal(limits.fd, 1);
  });
});
