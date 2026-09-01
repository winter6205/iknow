/**
 * LSP 编辑失效通知层 — spec 251-lsp-tool（§ notifier.ts）+ lsp-optimization plan T2。
 *
 * **职责**：edit_file 写盘成功后，由装配层（build-engine.ts）把
 * `invalidate(file)` 作为 registry 的 `onEdit` 回调注入；notifier 再把该文件
 * 的最新文本同步给对应语言服务器客户端，让 server 侧文本保持最新。
 *
 * **标准 didChange（plan T2，取代 Q2/A13 的 `workspace/xrefs` 字面值）**：
 * 旧实现发送非标准 `workspace/xrefs`，server 侧文本永远停留在 didOpen
 * version:1，后续 definition/references 基于陈旧内容。改经
 * `client.notifyChange(file)` 走标准 `textDocument/didChange`（full sync，
 * version++）：server 侧文本同步后，后续请求天然基于新内容，无需猜测
 * server 私有失效语义。「发送方式」仍框定在本文件内部，后续调整只需改此处。
 *
 * **降级策略（spec Open Question 决议）**：notifier 是尽力而为（best-effort）。
 *   - `invalidate` 是 fire-and-forget：返回 void，内部异步发送；
 *   - 异步发送包裹 try/catch，任何失败（client 已 dispose / 读文件失败 /
 *     spawn 失败）都记录并忽略，**绝不把错误抛回 edit_file 主路径**，
 *     否则一次失效通知失败会把整次 edit 变成 execution_failed；
 *   - `getClient` 返回 undefined（该文件无可用 LSP server）→ 静默跳过。
 *     文件写盘本身已成功，未通知到 server 只是陈旧缓存，可自愈。
 *
 * **取消语义（Q2/A9）**：本模块只发 JSON-RPC notification，不终止任何
 * 语言服务器子进程（与 client.ts 一致，见 spec S14）。
 */
import type { LspCtx } from "./types.js";
import { getClient } from "./client.js";

/**
 * 创建 LSP 编辑失效 notifier。
 *
 * @param ctx  LSP 客户端上下文（build-engine 装配时传入 `{ directory }`）。
 * @returns   `{ invalidate(file) }` —— fire-and-forget 失效回调，供装配层
 *            作为 registry 的 `onEdit` 注入 edit_file。
 */
export function createLspNotifier(ctx: LspCtx): {
  readonly invalidate: (file: string) => void;
} {
  const invalidate = (file: string): void => {
    // 尽力而为：异步发送，失败不抛回 edit_file 主路径（spec Open Question
    // 决议）。onEdit 回调是同步签名，这里立即返回，发送在后台完成。
    void notifyInvalidation(ctx, file);
  };

  return { invalidate };
}

/**
 * 异步发送单条失效通知。内部 catch 一切错误并吞掉（记录/忽略），
 * 保证不把错误传播给调用方（fire-and-forget）。
 */
async function notifyInvalidation(ctx: LspCtx, file: string): Promise<void> {
  try {
    const client = await getClient(ctx, file);
    if (!client) {
      // 该文件无可用 LSP server → 静默跳过（降级，不阻碍写盘主路径）。
      return;
    }
    // 标准 didChange 同步（见头注释）：未打开 → didOpen 等价路径；
    // 已打开 → didChange full sync version++。读文件失败在此 reject 并被
    // 下方 catch 吞掉（notifier best-effort，不回传 edit_file 主路径）。
    await client.notifyChange(file);
  } catch (err) {
    // 降级：notifier 失败不影响 edit_file 主路径（spec Open Question 决议）。
    // 文件已写盘成功；失效通知失败只是 server 侧短暂陈旧，可自愈。
    // stderr 留痕便于诊断,S3 禁空 catch → 必须有可观测面。
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[lsp-notifier] invalidate failed for ${file}: ${msg}\n`
    );
  }
}
