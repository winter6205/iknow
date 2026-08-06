import { stat } from "node:fs/promises";
import {
  findProjectAgents,
  findUserAgents,
  listRulesFiles,
  type MemoryLayerEntry,
} from "./discovery.js";
import { assembleSystemPrompt, type AssemblyContext } from "./assembly.js";

/** Resolve the static system prompt while refreshing only when layer mtimes change. */
export function createSystemResolver(
  ctx: AssemblyContext
): () => Promise<string | undefined> {
  let tracked: ReadonlyArray<MemoryLayerEntry> | undefined;
  let lastMtime = new Map<string, number>();
  let lastSystem: string | undefined;
  // In-flight dedupe: serve 多会话并发调 resolver 时,并发调用共享同一次
  // discovery + assembly,不重复读盘,也不互相覆盖 lastSystem 造成竞态。
  // resolve 后 inflight 清空,下一次调用重新走 mtime 检查(refresh 语义)。
  let inflight: Promise<string | undefined> | undefined;

  const refreshOnce = async (): Promise<string | undefined> => {
    try {
      if (!tracked) {
        tracked = await discover(ctx);
        lastMtime = await mtimes(tracked);
      } else {
        const current = await mtimes(tracked);
        if (sameMtimes(lastMtime, current)) return lastSystem;
        lastMtime = current;
      }
      lastSystem = await assembleSystemPrompt(ctx);
      return lastSystem;
    } catch (err) {
      // 装配失败不毒化缓存:丢弃 tracked/lastMtime,下次调用重新 discovery。
      tracked = undefined;
      lastMtime = new Map();
      throw err;
    } finally {
      inflight = undefined;
    }
  };

  return () => {
    if (!inflight) inflight = refreshOnce();
    return inflight;
  };
}

async function discover(
  ctx: AssemblyContext
): Promise<ReadonlyArray<MemoryLayerEntry>> {
  const [projectAgents, userAgents, projectRules, userRules] =
    await Promise.all([
      findProjectAgents(ctx.cwd),
      findUserAgents(ctx.userHome),
      listRulesFiles(ctx.cwd, "project"),
      listRulesFiles(ctx.userHome, "user"),
    ]);
  return [userAgents, ...userRules, projectAgents, ...projectRules].filter(
    (entry): entry is MemoryLayerEntry => entry !== null
  );
}

async function mtimes(
  entries: ReadonlyArray<MemoryLayerEntry>
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        result.set(entry.path, (await stat(entry.path)).mtimeMs);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          // 永久缺失:用 sentinel 标记,缓存可比,文件从无到有会触发 refresh。
          result.set(entry.path, MISSING_MTIME);
        } else {
          // 瞬时失败(EACCES / EBUSY / 锁):不写 sentinel,下次重试可自愈;
          // 同 mtime 比较时因路径缺席也算"已变化",触发 refresh。
          process.stderr.write(
            `[memory/refresh] stat failed for ${entry.path}: ${code ?? "unknown"}\n`
          );
        }
      }
    })
  );
  return result;
}

const MISSING_MTIME = -1;

function sameMtimes(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, mtime] of a) if (b.get(path) !== mtime) return false;
  return true;
}
