/**
 * D-α V1 观测地板 — `envelope.fileRefs` 派生（补 V1 写侧缺口）。
 *
 * `SubAgentEnvelope.fileRefs` 从 #356 起就在 interface 与 `PARENT_SCHEMA` 里
 * 声明，但写侧从未填充：父代理拿到的信封永远无 fileRefs。本模块补上派生侧。
 *
 * 真值来源 = `RunResult.messages`（append-only 权威历史）里的 `tool_use` 块：
 * 工具名命中 write 集时取 `input.path`。write 集本身由 ACI catalog 的
 * `aci.category === "write"` 派生（`writeToolNamesFrom`），不在本模块硬编码
 * 工具名单 —— 新增写类工具自动进集，不会漏。
 *
 * 已知边界（刻意不覆盖）：
 *   - `bash` 属 `execute` 类，重定向 / `tee` 等经 shell 写盘的文件无法从
 *     tool_use 入参还原，不进 fileRefs；
 *   - `memory_save` / `todo_write` / `bash_stop` 也是 write 类，但入参无
 *     `path` 字段，天然被 path 过滤掉（不需要额外名单）。
 *
 * 纯函数、零 IO：不 stat / 不 realpath / 不判断文件是否真的落盘 —— fileRefs
 * 是「子代理声明动过的路径」的观测投影，不是文件系统事实断言。
 */

import type { AciCatalog } from "../aci/types.js";
import type { AnthropicNativeMessage } from "../model-adapter/types.js";

/** ACI catalog 里所有 `category: "write"` 的工具名（派生，不硬编码）。 */
export function writeToolNamesFrom(catalog: AciCatalog): ReadonlySet<string> {
  const out = new Set<string>();
  for (const def of catalog.all()) {
    if (def.aci.category === "write") out.add(def.name);
  }
  return out;
}

/**
 * 扫权威历史里的 `tool_use` 块，收集 write 类工具的 `input.path`。
 *
 * 去重按首次出现顺序（同一文件被 edit 多次只留一条，顺序即子代理触碰顺序）。
 * 任何形状异常（input 非对象 / path 非字符串 / path 空串）都跳过，不抛 ——
 * 观测派生绝不能把一次成功的子代理运行变成协议错误。
 */
export function deriveFileRefs(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  writeToolNames: ReadonlySet<string>
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      if (!writeToolNames.has(block.name)) continue;
      const input = block.input;
      if (input === null || typeof input !== "object") continue;
      const filePath = (input as Record<string, unknown>).path;
      if (typeof filePath !== "string" || filePath.length === 0) continue;
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      out.push(filePath);
    }
  }
  return out;
}
