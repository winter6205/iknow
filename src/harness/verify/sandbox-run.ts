/**
 * verify 沙箱执行体 (#128 T7/M4 拆分)。
 *
 * 与判定编排 (verify-loop.ts) 隔离: 本文件只负责"验证命令 → bwrap 沙箱执行 →
 * 超时包裹 → SandboxCmdRecord 落盘"。M6 抽共享工厂 (bash 工具同款装配语义),
 * 消除 makeDefaultRunVerify 在 verify-loop 内部重造 bash 装配。
 */
import { tmpdir } from "node:os";
import type { SandboxCmdRecord, TraceService } from "../trace/index.js";
import type {
  EgressPolicyInput,
  EgressSession,
  SandboxRunResult,
} from "../sandbox/index.js";
import {
  BASE_ENV_WHITELIST,
  createBwrapFence,
  createEgressSession,
  createEnvIsolation,
  createFsPolicy,
  runInSandbox,
} from "../sandbox/index.js";

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
 * bash 工具的围栏 / 资源限额, 不单独放宽)。命令拼 `bash -c <command>`,
 * 与 bash.ts 一致。
 *
 * ADR-0092 / Round 2:工作区档 fs 档 + homeRoot 透传,bwrap 据此在工作区档
 * 叠 `--ro-bind <home>` + `--bind <cwd>` + `--bind <tmpDir>` 三层(global 档
 * 下 bwrap 不发射,V1 baseline 不破)。fsMode 缺省回退与 bash 工具同形态
 * (`"global"`)。
 *
 * homeRoot 缺省**不**再回落成「不发射 home 层」:verify 面若在 workspace 档
 * 漏传 homeRoot,bwrap 抛 typed error(fail-loud)—— 静默跳过 home ro-bind 会
 * 让验证命令的围栏悄悄退回全局档,而 bash 工具仍在工作区档,同一会话两条
 * 执行面档位不一致且无信号。
 */
export function makeDefaultRunVerify(opts: {
  readonly cwd: string;
  /**
   * ADR-0092 / SC12: 验证命令的会话 tmp 宿主路径 —— `$TMPDIR` 的来源,
   * 同时是工作区档 `--bind <tmpRoot>` 的源端(两者必须同一份)。
   *
   * 缺省回退进程 `tmpdir()`:**这是 fallback 不是目标态** —— 会话 tmp 的
   * 权威解析归调用方(`resolveSessionFenceTmp({ projectDir, conversationId })`,
   * 与 bash 工具面同一 helper)。回退只服务「未接线 / 测试注入」路径:
   * 在那里报错会让 verify 在拿不到 projectDir / conversationId 时直接失败,
   * 超出本面职责。生产两个 caller(session-api/hub、cli/chat-session)都显式传。
   */
  readonly tmpDir?: string;
  /** ADR-0092 Round 2 / SC11/SC12:工作区档 fs 档。缺省 → global(V1 baseline)。 */
  readonly fsMode?: import("../sandbox/fs-mode.js").FsIsolationMode;
  /** ADR-0092 Round 2 / SC11:工作区档 home ro-bind 源端宿主绝对路径。 */
  readonly homeRoot?: string;
  /**
   * ADR-0097 / T7:出口代理缝策略 —— 由 caller(verify-loop 装配期)透传
   * (通常经 `createEgressPolicyFactory` 派生)。verify 模块级形态:per-
   * session 单例 session(所有 verify 命令共享同一份 session),首次
   * `runVerify` 调用时 lazy start;后续调用复用(spec §Module-level form
   * 「module-level singleton」);start 失败 → 无缝(fail-closed,与后台
   * 同语义);调用方负责 dispose(由 verify-loop / hub 在会话退出时调
   * `disposeEgressSessionForVerify` 释放)。
   *
   * 缺省 = caller 未注入 = 无缝(V1 baseline 等价;沙箱内 `--unshare-net`
   * 恒在)。**生产装配 TODO**:hub / chat-session 装配点本票后接。
   */
  readonly egressPolicy?: EgressPolicyInput;
}): RunVerifyFn {
  // 注意:调用方(verify-loop.ts)每轮现造本闭包,故此处工厂期快照 == 该轮
  // 的 per-call 快照 —— 与 bash handler 入口 D2 snapshot 同 vintage。
  const tmpDir = opts.tmpDir ?? tmpdir();
  const fsMode = opts.fsMode ?? "global";
  const homeRoot = opts.homeRoot;
  const fsPolicy = createFsPolicy({ tmpDir, mode: fsMode });
  const envIsolation = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST });
  // ADR-0097 / T7:模块级 session 单例 —— 首次调用时 lazy start。
  // start 失败(典型:中继产品依赖缺席 / unix socket 占用)→ session 保持 undefined,
  // 后续调用 fence 走纯断网(fail-closed)。调用方经
  // `disposeEgressSessionForVerify` 释放(verify-loop / hub 会话退出时)。
  let egressSession: EgressSession | undefined;
  let egressStartAttempted = false;
  async function ensureEgressSession(): Promise<EgressSession | undefined> {
    if (egressStartAttempted) return egressSession;
    egressStartAttempted = true;
    if (opts.egressPolicy === undefined) return undefined;
    try {
      egressSession = await createEgressSession({
        policy: opts.egressPolicy,
      });
    } catch {
      egressSession = undefined;
    }
    return egressSession;
  }
  return async (command, ctx) => {
    // ADR-0092 / SC12:`$TMPDIR` 与交给 createBwrapFence 的 `tmpRoot` 必须
    // 是**同一份**宿主真路径(与 bash.ts 的 fenceEnv 同形同时机)。
    // `envIsolation.filter` 只按 BASE_ENV_WHITELIST 放行宿主已有的
    // `TMPDIR` —— 宿主未导出时它根本不在场,围栏内写 `"$TMPDIR/x"` 会落到
    // `/x`(guest 根)被拒。显式注入才是本面的目标态;filter 结果里的宿主
    // 值被有意覆盖(生产装配的会话 tmp 由调用方给,不由宿主 env 决定)。
    // ADR-0097 / T7:egress session lazy start —— 首次调用起,后续复用。
    const session = await ensureEgressSession();
    // egress-ssh-bridge T5：内层监听前导与 bash.ts 前台 / background
    // spawn factory 同形 —— session 在场时 payload =
    // `<innerBridgeScript>\n<command>`；缺席 = byte-identical（invariant 3）。
    const commandPayload =
      session !== undefined
        ? `${session.spec.innerBridgeScript}\n${command}`
        : command;
    const fenceEnv = {
      ...envIsolation.filter(process.env),
      TMPDIR: tmpDir,
      ...(session !== undefined ? session.spec.env : {}),
    };
    const fence = createBwrapFence({
      command: "bash",
      args: ["-c", commandPayload],
      fsPolicy,
      env: fenceEnv,
      cwd: opts.cwd,
      // ADR-0092 Round 2 / SC11:workspace 档三层。**不**按 `homeRoot !==
      // undefined` 预过滤 —— home 层缺席时 bwrap 抛 typed error(工作区档
      // 缺 home = 静默退化成全局档,是安全洞不是容错)。此处只表达「哪些层
      // 的源端是哪些路径」,「缺了该不该发射」由 fence 装配层唯一裁决。
      ...(fsMode === "workspace"
        ? { homeRoot, workspaceRoot: opts.cwd, tmpRoot: tmpDir }
        : {}),
      // ADR-0097 / T7:egress 缝(per-call fence argv,module-level session)。
      ...(session !== undefined ? { egress: session.spec } : {}),
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
 * ADR-0097 / T7:释放 `makeDefaultRunVerify` 模块级 egress session
 * (verify-loop / hub 在会话退出时调用)。session 未起 / 已 dispose 时
 * 静默成功(幂等)。
 */
export async function disposeEgressSessionForVerify(
  verifyFn: RunVerifyFn
): Promise<void> {
  // verifyFn 是闭包,无引用桥 —— 调用方负责持有 `(verifyFn as any)._egressSession`
  // 或本工厂返回值。本票最小实现:由 makeDefaultRunVerify 返回值 close
  // 关联字段(已隐式 —— factory 闭包内部 `egressSession` 变量,本函数无
  // 桥接)。**生产装配 TODO**:verify-loop / hub 装配点本票后接 ——
  // 本票只定义契约,不实现 dispose 桥(避免在工厂返回值上挂占位字段污染
  // RunVerifyFn 签名)。
  void verifyFn;
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
