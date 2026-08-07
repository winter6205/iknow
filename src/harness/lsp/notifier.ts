/**
 * LSP 编辑失效通知层 — spec 251-lsp-tool（§ notifier.ts）。
 *
 * **职责**：edit_file 写盘成功后，由装配层（build-engine.ts）把
 * `invalidate(file)` 作为 registry 的 `onEdit` 回调注入；notifier 再给
 * 对应文件的 tsserver 客户端发 invalidation 通知，让语言服务器及时刷新
 * 对已改文件的引用/xrefs 缓存。
 *
 * **Q2/A13 决议**：发送 `workspace/xrefs`（spec 字面值）。该 method 非标准
 * LSP 方法，但本 spec 明确要求按此发；装配层已把「发送方式」框定在
 * notifier 内部，后续若确证 tsserver 需要 `textDocument/didSave` 之类的
 * 标准通道，只需改本文件一处。
 *
 * **降级策略（spec Open Question 决议）**：notifier 是尽力而为（best-effort）。
 *   - `invalidate` 是 fire-and-forget：返回 void，内部异步发送；
 *   - 异步发送包裹 try/catch，任何失败（client 已 dispose / 网络断 /
 *     spawn 失败）都记录并忽略，**绝不把错误抛回 edit_file 主路径**，
 *     否则一次失效通知失败会把整次 edit 变成 execution_failed；
 *   - `getClient` 返回 undefined（该文件无可用 LSP server）→ 静默跳过。
 *     文件写盘本身已成功，未通知到 tsserver 只是陈旧缓存，可自愈。
 *
 * **取消语义（Q2/A9）**：本模块只发 JSON-RPC notification，不终止任何
 * tsserver 子进程（与 client.ts 一致，见 spec S14）。
 */
import { pathToFileURL } from "node:url";

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
    await client.sendNotification("workspace/xrefs", {
      uri: pathToFileURL(file).href,
    });
  } catch {
    // 降级：notifier 失败不影响 edit_file 主路径（spec Open Question 决议）。
    // 文件已写盘成功；失效通知失败只是 tsserver 侧短暂陈旧，可自愈。
  }
}
