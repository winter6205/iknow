/**
 * review-fix (M2/M3):两级会话树目录名 SSOT。
 *
 * Layout: `<baseDir>/projects/<project-slug>/<conversationId>/{...,subagents/}`。
 * 唯一字面量声明点。此前四份影子副本(定义或本地字面量)——
 *   - `session-api/store/session-store.ts`(`SUBAGENT_TRACE_DIR_NAME` 定义处);
 *   - `traceserver/session-discovery.ts` + `traceserver/sessions.ts`
 *     (各自 `PROJECTS_DIR_NAME` / `"subagents"` 本地字面量);
 *   - `harness/subagent/manager.ts`(M5 两段式派生新增)——
 * 已收敛到本文件。
 *
 * 落位依据:`src/shared/` 是 harness / session-api / traceserver 三方
 * 已共同 import 的中立层(traceserver 的「不得 import harness/」边界,
 * `tests/traceserver/output-backstop.test.ts` 钉死,同样适用于本常量——
 * 读侧路径解耦原则与 output-backstop 同源)。修改任何一个名字必须同步
 * 评估旧布局兼容性(session folder consolidation T1 的存档/迁移语义)。
 */

/** `<baseDir>/projects/<slug>/` 第一级 —— 项目身份 slug 层目录名。 */
export const PROJECTS_DIR_NAME = "projects";

/** `<projectDir>/<convId>/subagents/` —— per-agent 子代理记录目录名。 */
export const SUBAGENT_TRACE_DIR_NAME = "subagents";

/** `<sessionFolder>/fence-tmp/` — 主会话围栏 `/tmp` 宿主垫底（ADR-0074）。不与 `subagents/` 碰撞。 */
export const MAIN_SESSION_FENCE_TMP_DIR_NAME = "fence-tmp";

/** `<projectDir>/tasks/` —— 后台任务登记根(ADR-0088)。与会话文件夹叶子同级。 */
export const TASKS_DIR_NAME = "tasks";

/** `<projectDir>/memory/` —— 项目记忆库根(ADR-0099)。与会话叶子、`tasks/` 同级。 */
export const MEMORY_DIR_NAME = "memory";
