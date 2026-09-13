/**
 * T3 (ADR-0071 Decision 1/4) + 会话文件夹归并回归修复:
 * trace 读侧扫描根解析 —— flag > `IKNOW_TRACE_OUT` env > 调用方写侧 dataDir。
 *
 * trace 锚点已迁入会话文件夹,主会话写入由 `resolveConversationTraceFilePath`
 * 经 hub / store 派生;本根承担 ACI 读侧工具(list_sessions / query_trace /
 * get_record)的扫描根与 trace 面板目录。写侧会话池 = 显式 `--data-dir` 否则
 * `~/.iknow`(ADR-0087,会话池不再按 cwd / workspaceRoot 分片),缺省派生必须
 * 复用**调用方自己的写侧 dataDir**。
 *
 * 独立成模块的原因:cli.ts 有模块级 `main()` 副作用,不可被 tui/run.tsx
 * 或测试导入;本模块无副作用。
 *
 * `resolve` 把任意相对输入归一化为绝对路径,保证下游 mkdirSync / appendFileSync
 * 不会被调用方传 cwd-relative 时「以启动时 CWD 为根」再次踩 T3 退役的坑。
 */
import { resolve } from "node:path";
import { resolveServeDataDir } from "../session-api/serve.js";

export function resolveTraceRoot(
  flag: string | undefined,
  writeSideDataDir: string | undefined
): string {
  return resolve(
    flag ??
      process.env.IKNOW_TRACE_OUT ??
      writeSideDataDir ??
      // 末位兜底:调用方未传写侧池根(旧调用方 / 测试 seam)→ 缺省 `~/.iknow`。
      // 三入口 (chat / serve / tui) 都显式传 `resolveServeDataDir(parsed.dataDir)`,
      // 故本分支只在「无 --data-dir 可透传」的调用点生效(ADR-0087 默认池根)。
      resolveServeDataDir()
  );
}
