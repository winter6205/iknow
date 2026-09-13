/**
 * review-fix (M1/M2/M3):home 项目树分组键 SSOT。
 *
 * ADR-0071 / ADR-0088:`<poolRoot>/projects/<basename(projectIdentityRoot)>-<sha1[:12]>/`
 * 是会话文件夹与后台任务登记表共用的分组锚。两处消费者
 * (`src/session-api/store/session-store.ts` 的 `resolveProjectSessionDir`,
 *  `src/harness/background/paths.ts` 的 `resolveTasksDir`)历史上各算一份
 * 公式并各自定长度上限 —— 漂移会让任务登记落入与同名会话文件夹不同
 * 的 slug,造成登记表孤儿(无对话的活账本 / 反之)。本模块把公式与上限
 * 收成单一字面量:`computeProjectSlug` 出 slug,`MAX_PROJECT_IDENTITY_ROOT_BYTES`
 * 出上限,两处共用。
 *
 * 落位依据:`src/shared/` 是 harness / session-api / traceserver 三方
 * 已共同 import 的中立层(`src/harness/` Gate B 不允许 import
 * `src/session-api/`,反之亦然;`src/shared/` 是唯一双向可达层)。
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";

/**
 * `projectIdentityRoot` 路径字符数上限。会话文件夹与后台登记表共用同一上
 * 限 —— 121–255 字符的根必须**两边都接受**,否则同根下会话文件夹已解析
 * 但登记表抛 typed error → 登记表孤儿。先前两处历史上限分别为
 * `MAX_ROOT_DETAIL_CHARS = 120`(paths.ts)与 `MAX_CONVERSATION_ID_BYTES
 * = 255`(session-store.ts)—— review 抓到的 regression 区间即 121–255
 * 字符。
 *
 * 选 255 = POSIX 单段文件系统名硬上限,与会话 id 段保持同源(`session-store.ts`
 * `MAX_CONVERSATION_ID_BYTES` 也是 255),统一诊断回显。
 */
export const MAX_PROJECT_IDENTITY_ROOT_BYTES = 255;

/**
 * 单一口径 slug 公式: `<basename(root)>-<sha1(root)[:12]>`。
 *
 * 无 IO、无副作用、不校验输入形态(校验由消费方各自的 typed-error
 * 包装承担:session-store 抛 `SessionRootError`,paths.ts 也抛同一
 * `SessionRootError`;只在校验通过后调用本函数)。
 */
export function computeProjectSlug(projectIdentityRoot: string): string {
  const digest = createHash("sha1")
    .update(projectIdentityRoot)
    .digest("hex")
    .slice(0, 12);
  return `${basename(projectIdentityRoot)}-${digest}`;
}
