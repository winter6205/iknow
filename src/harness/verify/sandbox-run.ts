/**
 * verify 沙箱执行体 (#128 T7/M4 拆分)。
 *
 * 与判定编排 (verify-loop.ts) 隔离: 本文件只负责"验证命令 → bwrap 沙箱执行 →
 * 超时包裹 → SandboxCmdRecord 落盘"。M6 抽共享工厂 (bash 工具同款装配语义),
 * 消除 makeDefaultRunVerify 在 verify-loop 内部重造 bash 装配。
 */
import { homedir, tmpdir } from "node:os";
import type { SandboxCmdRecord, TraceService } from "../trace/index.js";
import type { SandboxRunResult } from "../sandbox/index.js";
import {
  BASE_ENV_WHITELIST,
  createBwrapFence,
  createEnvIsolation,
  createFsPolicy,
  createNetworkPolicy,
  createResourceLimits,
  defaultOptionalReadRoots,
  runInSandbox,
} from "../sandbox/index.js";
import { resolveInstallRoot } from "../session-roots.js";

/**
 * 验证执行体: command → 沙箱执行 → { exitCode, stdout, stderr }。
 * 生产缺省装配用 runInSandbox + bwrap; 测试注入脚本化替身。
 */
export type RunVerifyFn = (
  command: string,
  ctx: { readonly signal?: AbortSignal }
) => Promise<SandboxRunResult>;

/**
 * 生产缺省 runVerify: 与 bash 工具同款沙箱装配 (spec:64 声明验证命令沿用
 * bash 工具的 fsPolicy / 资源限额, 不单独放宽)。命令拼 `bash -c <command>`,
 * 与 bash.ts 一致。
 *
 * T4 闭世界双轴 (ADR-0037 §9.2): 读白名单 = installRoot(合同根,#4) +
 * node 工具链根(缺省推导,#5) + git 全局配置(可选成员,#7,与 bash 前台/
 * 后台同一 helper);写白名单 = cwd(taskRoot) + tmp。verify 不传
 * projectIdentityRoot(维持现状,#6 由装配层条件决定)。
 */
export function makeDefaultRunVerify(opts: {
  readonly cwd: string;
  readonly home: string;
  /** T4 (ADR-0037 §9.2 #4): iknow 运行时安装根 —— 闭世界读白名单的合同
   *  读根(项目自身工具链读通道)。缺省回退 `resolveInstallRoot()` 进程级
   *  SSOT(既有第四角色,不新增状态源),不许静默留空;显式传入即覆盖
   *  (测试注入缝 —— session-roots 刻意不给进程缓存 reset 缝)。 */
  readonly installRoot?: string;
}): RunVerifyFn {
  const installRoot = opts.installRoot ?? resolveInstallRoot();
  const fsPolicy = createFsPolicy({
    cwd: opts.cwd,
    home: opts.home,
    tmpDir: tmpdir(),
    installRoot,
    optionalReadRoots: defaultOptionalReadRoots({ home: opts.home }),
  });
  const networkPolicy = createNetworkPolicy();
  const resourceLimits = createResourceLimits();
  const envIsolation = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST });
  return async (command, ctx) => {
    const fenceEnv = envIsolation.filter(process.env);
    const fence = createBwrapFence({
      command: "bash",
      args: ["-c", command],
      fsPolicy,
      networkPolicy,
      resourceLimits,
      env: fenceEnv,
      cwd: opts.cwd,
    });
    return runInSandbox({
      fence,
      cwd: opts.cwd,
      signal: ctx?.signal,
      env: fenceEnv,
    });
  };
}

/**
 * 单次命令执行 + 超时包裹 (verify-loop 层, 不动 runner 签名)。
 * 每执行一个独立 AbortController: timeoutSec 到时 abort (timedOut=true);
 * 用户 signal abort 同样转发给 controller (用户优先, 由调用方判 aborted)。
 * exec 启动失败 (spawn error / 沙箱拒绝) → 收敛为 exit=127 (真失败分支语义)。
 * spec:67 / plan §Decisions: 每次执行落一条 SandboxCmdRecord (parentTurnId 挂
 * 触发本轮验证的 completed turn id, 单值 parent, #286)。
 */
export async function runVerifyOnce(
  runVerify: RunVerifyFn,
  command: string,
  opts: {
    readonly timeoutSec: number;
    readonly signal?: AbortSignal;
    /** 观测落点 (spec:67: 验证命令经 SandboxCmdRecord 落盘)。 */
    readonly trace?: TraceService;
    /** 触发本轮验证的 completed turn id (plan §Decisions parentTurnId 语义)。 */
    readonly parentTurnId: string;
  }
): Promise<{ readonly result: SandboxRunResult; readonly timedOut: boolean }> {
  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  const startMono = performance.now();
  let timedOut = false;
  /** spawn/沙箱启动失败记录 (S3: 收敛 127 时保留根因, 不进 stderr 伪造)。 */
  let sandboxError: string | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutSec * 1000);
  const onUserAbort = (): void => controller.abort();
  if (opts.signal !== undefined) {
    opts.signal.addEventListener("abort", onUserAbort, { once: true });
  }
  try {
    let result: SandboxRunResult;
    try {
      result = await runVerify(command, { signal: controller.signal });
    } catch (err) {
      // 启动失败不抛错打断闭环, 归入 exit=127 真失败 (spec:94 ENOENT 边界)。
      // // EXIT: spawn/沙箱启动失败 → 收敛为 exit=127, 走真失败分支。
      // (S3 判据: fallback 分支必含显式退出条件; err 记录于 SandboxCmdRecord error)
      result = { exitCode: 127, stdout: "", stderr: "" };
      sandboxError = err instanceof Error ? err.message : String(err);
    }
    const endedAt = new Date().toISOString();
    const record: SandboxCmdRecord = {
      parentTurnId: opts.parentTurnId,
      command,
      exitCode: result.exitCode,
      stdoutCaptured: result.stdout.length > 0,
      ...(result.stdout.length > 0 ? { stdout: result.stdout } : {}),
      startedAt,
      endedAt,
      durationMs: Math.round(performance.now() - startMono),
      status: timedOut ? "error" : "ok",
      // 失败根因显式记录 (S3: 超时 / 启动失败不静默): Postel, 成功无 error。
      ...(timedOut
        ? {
            error: {
              type: "timeout" as const,
              message: "verify command timed out",
            },
          }
        : sandboxError !== undefined
          ? {
              error: {
                type: "execution_failed" as const,
                message: sandboxError,
              },
            }
          : {}),
    };
    void opts.trace?.recordSandboxCmd(record);
    return { result, timedOut };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onUserAbort);
  }
}

/** 供 verify-loop 缺省装配 home 解析 (对齐 homedir() 缺省)。 */
export function defaultVerifyHome(home?: string): string {
  return home ?? homedir();
}
