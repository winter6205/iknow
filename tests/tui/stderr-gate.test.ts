/**
 * tests/tui/stderr-gate.test.ts — TUI 存活期间的裸 stderr trace 门（bun:test）。
 *
 * 背景：OpenTUI alternate-screen 渲染只接管自己的绘制区，后台模块
 * （lsp warmup / notifier / memory 等）的 `process.stderr.write` 会漏到光标
 * 位置——视觉上像出现在输入框里（用户报告的 "no client available" 即此）。
 * agent 主路径不受影响（warmup 是 fire-and-forget，失败只留 trace），所以修
 * 的是显示面：live 期间把裸 stderr 缓冲，renderer destroy + 终端恢复后按序
 * 回放到真实 stderr——信息不丢，屏上不污染。
 *
 * 门的写入面是注入的 target（生产传 process.stderr，形状兼容 { write }），
 * 本文件用 fake target 钉行为；runTui 的接线点由 structural-pin 测试
 * （run-errors.test.ts 追加）与 aiterm PTY 实测收口——同文件既有的分工理由：
 * bun test 无真 TTY，完整 runTui 路径不可注入。
 */
import { afterEach, describe, expect, it } from "bun:test";

import {
  createProcessStderrGate,
  createStderrGate,
  MAX_BUFFERED_CHUNKS,
  type StderrGateHandle,
  type StderrWriteTarget,
} from "../../src/tui/stderr-gate.js";

/** fake target：record 记录直写；hijacked 模拟门装上后外部写入走 patch。 */
function makeTarget() {
  const written: string[] = [];
  let patched: ((chunk: string) => boolean) | undefined;
  const target: StderrWriteTarget = {
    write(chunk: string | Uint8Array): boolean {
      if (patched !== undefined) return patched(String(chunk));
      written.push(String(chunk));
      return true;
    },
  };
  return {
    target,
    written,
    setPatched: (p?: (c: string) => boolean) => (patched = p),
  };
}

/** 生产 createProcessStderrGate 用的可还原假 stderr（只换 write 属性）。 */
function makeProcessLikeTarget() {
  const written: string[] = [];
  const proc: StderrWriteTarget = {
    write(chunk: string | Uint8Array): boolean {
      written.push(String(chunk));
      return true;
    },
  };
  return { proc, written };
}

let lastGate: StderrGateHandle | undefined;
afterEach(() => {
  // 兜底释放：用例失败时也不把门留在装配态污染后续用例。
  lastGate?.end();
  lastGate = undefined;
});

describe("stderr gate：live 期缓冲、end 按序回放", () => {
  it("门开启期间的写入不触达真实流，end 时按写入顺序一次性回放", () => {
    const t = makeTarget();
    const gate = createStderrGate(t.target);
    lastGate = gate;
    gate.begin();
    // 门装上后外部写入走 patch（生产即 process.stderr.write 被替换后的路径）
    t.setPatched((chunk) => gate.capture(chunk));

    t.target.write("[lsp-warmup] partial: json: no client available\n");
    t.target.write("[memory] some other background trace\n");
    expect(t.written.length).toBe(0); // 直播期间一条都不能漏（漏字即输入框污染）

    t.setPatched(undefined); // end 前解除 patch = 生产 end 的 restore-first 语义
    gate.end();
    expect(t.written.join("")).toContain("json: no client available");
    expect(t.written.join("")).toContain("[memory]");
    expect(t.written[0]).toContain("json"); // 回放顺序 = 因果序
    expect(t.written[1]).toContain("[memory]");
  });

  it("begin 幂等；未 begin 的 end 与双 end 均为 no-op 不抛", () => {
    const t = makeTarget();
    const gate = createStderrGate(t.target);
    lastGate = gate;
    gate.end(); // 从未 begin → no-op
    gate.begin();
    gate.begin(); // 双 begin 不叠加
    t.setPatched((chunk) => gate.capture(chunk));
    t.target.write("one\n");
    t.setPatched(undefined);
    gate.end();
    gate.end(); // 双 end 幂等
    expect(t.written.length).toBe(1);
  });

  it("end 之后写入直达真实流（patch 已解除，不留缓冲路径）", () => {
    const t = makeTarget();
    const gate = createStderrGate(t.target);
    lastGate = gate;
    gate.begin();
    t.setPatched((chunk) => gate.capture(chunk));
    t.target.write("buffered\n");
    t.setPatched(undefined); // restore-first（生产 end 语义）
    gate.end();
    t.target.write("direct\n");
    expect(t.written.join("")).toBe("buffered\ndirect\n");
  });

  it("end 之后到达 capture 的新写入直通真实流（不递归入缓冲）", () => {
    const t = makeTarget();
    // sink=创建期绑定的真实写入（与生产门同构）：回放/直通恒不经 patch。
    const gate = createStderrGate(t.target, t.target.write.bind(t.target));
    lastGate = gate;
    gate.begin();
    t.setPatched((chunk) => gate.capture(chunk));
    t.target.write("first\n");
    t.setPatched(undefined); // restore-first（生产 end 语义）
    gate.end(); // 回放 "first"
    // 旧调用方仍持有 capture 闭包并继续写：buffer 已清 → 直通 sink，
    // 不重新入缓冲（否则会丢字或等下一次 end——而那永远不会来）。
    gate.capture("second-after-end\n");
    expect(t.written.join("")).toBe("first\nsecond-after-end\n");
  });

  it("生产门：裸 write(stream.write) 在 begin/end 窗口内被缓冲，end 按序回放到原始流并解除 patch", () => {
    const { proc, written } = makeProcessLikeTarget();
    const gate = createProcessStderrGate(proc);
    lastGate = gate;
    gate.begin();
    // 模拟后台模块的裸调用路径（process.stderr.write 属性已被替换）：
    proc.write("bleed-1\n");
    proc.write("bleed-2\n");
    expect(written.length).toBe(0); // 直播期间零漏字
    gate.end();
    expect(written.join("")).toBe("bleed-1\nbleed-2\n"); // 按序回放到主屏
    // 还原为 bound 原始写入（引用是 bind 副本，语义等价）：行为断言——
    // 后续写入不再经门（若 patch 残留会重新缓冲、永远不出现）。
    proc.write("post\n");
    expect(written.join("")).toBe("bleed-1\nbleed-2\npost\n");
  });

  it("生产门与外层 write 拦截器组合：begin 捕获外层、end 还原外层并投喂回放", () => {
    // run-errors 子进程 driver 的形状：先替换 process.stderr.write 做捕获，
    // 再进 runTui。门若在外层拦截器装载后构造、又用构造期绑定还原，会把
    // 外层永久踢出链（回放丢失 + 断言失明）。begin 期捕获修掉这点。
    const { proc, written } = makeProcessLikeTarget();
    const outerCaptured: string[] = [];
    proc.write = (chunk) => {
      outerCaptured.push(String(chunk));
      return true;
    };
    const gate = createProcessStderrGate(proc);
    lastGate = gate;
    gate.begin(); // 捕获的是 outer，而非最底层 written
    proc.write("live\n");
    expect(outerCaptured.length).toBe(0); // 直播期零漏字
    gate.end();
    expect(outerCaptured.join("")).toBe("live\n"); // 回放投喂给外层
    proc.write("after\n");
    expect(outerCaptured.join("")).toBe("live\nafter\n"); // 链完整交还
    expect(written.length).toBe(0);
  });

  it("超过缓冲上限的写入被丢弃并在 end 时给出计数说明（长跑内存有界、丢弃不静默）", () => {
    const t = makeTarget();
    const gate = createStderrGate(t.target, t.target.write.bind(t.target));
    lastGate = gate;
    gate.begin();
    for (let i = 0; i < MAX_BUFFERED_CHUNKS + 5; i += 1) {
      gate.capture(`line-${i}\n`);
    }
    t.setPatched(undefined);
    gate.end();
    expect(t.written.length).toBe(MAX_BUFFERED_CHUNKS + 1); // 500 条 + 1 条说明
    expect(t.written[0]).toBe("line-0\n");
    expect(t.written[MAX_BUFFERED_CHUNKS]).toContain("5 more line(s) dropped");
  });
});
