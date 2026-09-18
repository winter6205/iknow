/**
 * #356 subagent JSON envelope — 父↔子 进程间信封 schema 冻结落点 (D1)。
 *
 * 两个方向的信封:
 *   - 父→子 worker 请求 (parseWorkerEnvelope):
 *       { task, systemPrompt?, disallowedTools?, model?, maxTurns?, timeoutMs?,
 *         sandboxRoot, env?, role?, finalText?, evidenceContext? }
 *   - 子→父 result (parseParentEnvelope / truncateEnvelopeResult):
 *       { status: "ok"|"failed", summary, result, fileRefs?, usage?, reason?,
 *         stop_reason?, truncated?, totalLength?, task_id?, tmp_root?,
 *         output_path?, product_roster? }
 *
 * 校验规则 (SC13 / plan D1 acceptance 3):
 *   - 缺必填字段 / wrong type / 非对象 → throw ProtocolError (协议错误);
 *   - 收尾 newline 先 trim 再 parse;多条 newline 按首条独立 JSON parse
 *     (第二条独立 JSON 被忽略,取首条);
 *   - ajv 实例与仓库同款 strict 配置 (同 src/harness/tools/registry.ts
 *     makeAjv),不引入第二份配置差异。
 *
 * 父可见投影 (T5): 父代理交差正文是短摘要、路径与停因，不是终稿全文。
 * 原文长于交差或超过 20000 字时置 truncated（汇报已收束）；status/reason 不变。
 */
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { ProtocolError } from "../errors.js";
import type { StopReason } from "../model-adapter/types.js";
import type { WriteSituation } from "../session-roots.js";

/**
 * T7 (`specs/skill-index-increment.md` / SC10 + assumption 7) — 父会话 spawn
 * **当时**的模型索引条目（= 父冻表 ∪ 父索引进场史，按模型索引资格过滤后的
 * 那些），随 envelope 过进程边界。
 *
 * 形态 = `SkillSummary`（`identity/assemble.ts`）的 wire 子集：name 必有、
 * description 可选（降档后的裸名行，ADR-0046 Decision 2）。刻意**不带**
 * `disabled`：模型索引面本就不含 disabled 条目，多带一个字段等于给 wire
 * 开第二条语义。
 *
 * 这不是第二套渲染：worker 侧照旧把条目交给 `skillsSegment`（渲染 SSOT），
 * 本结构只是数据。
 */
export interface SkillIndexSnapshotEntry {
  readonly name: string;
  readonly description?: string;
}

/** 父→子 worker 请求信封。schema 冻结形态见 WORKER_SCHEMA。 */
export interface WorkerEnvelope {
  readonly task: string;
  readonly systemPrompt?: string;
  readonly disallowedTools?: readonly string[];
  readonly model?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly sandboxRoot: string;
  readonly env?: Readonly<Record<string, unknown>>;
  /**
   * #556 T2: 来自 SubAgentDefinition.role 的 wire-additive 字段。worker 装配
   * 期查 catalog 取 body 注入 persona 段 (T2 acceptance); 缺省 / 未知 →
   * V1 baseline (defense-in-depth fallback, 详见 worker.ts + plan T2)。
   */
  readonly role?: string;
  /**
   * Host truncated dialogue (judge). Independent of `task`.
   */
  readonly finalText?: string;
  /**
   * Evidence prompt object (judge). Independent of `task`.
   */
  readonly evidenceContext?: object;
  /**
   * T6 (plans/write-situation-disclosure.md) — 写处境三态，由 spawn 期
   * `manager.buildWorkerPayload` 调用 `writeSituation(isolationOn, resolved)`
   * 算好后透传（ADR-0069 D2）。worker prior (`priorMessagesFromEnvelope`)
   * 据此渲染写根段：
   *   - `writable_main` / `writable_tree` → ①/② 文案（与改造前逐字节相等）；
   *   - `no_writable_root` → ③ 态披露（不点名建树工具，不嵌入沙箱根）；
   *   - 缺省（**legacy envelope** —— 跨版本 resume / 旧 worker bootstrap）→
   *     typed skip（spec OQ1 采纳 (b)），不注入写根段，不回落旧文案。
   *
   * Wire additive + optional —— 与 `role` 同形态;旧 envelope（无此字段）
   * 仍可被 ajv 接受，**不破现有契约**（`additionalProperties:false` 下需
   * 在 WORKER_SCHEMA.properties 显式声明）。
   */
  readonly writeSituation?: WriteSituation;
  /**
   * T5 (ADR-0071 / SC8 + L2): 该 worker 的
   * taskId (parent spawn 时 manager.randomUUID() 锁定)。traceFilePath 配
   * 对使用 —— worker file-mode 落该路径 + conversationId=taskId,代替
   * L2 假 scope `randomUUID()`(已退役)。缺席 → 走 IKNOW_TRACE_OUT 退路。
   * Wire additive + optional —— 与 `role` 同形态;旧 envelope / 跨版本 resume
   * 仍 ajv 接受,worker 不退化(`additionalProperties:false` 下需在
   * WORKER_SCHEMA.properties 显式声明)。
   */
  readonly taskId?: string;
  /**
   * T5 (ADR-0071 / SC8 + L2): worker 进程内
   * JsonlTraceService 的 file mode 锚点,由 spawn 期 `manager.buildWorkerPayload`
   * 算好后透传(父进程已经替这个 taskId 建好 `<父会话文件夹>/subagents/agent-<taskId>.jsonl`)。
   * worker 拿这个文件路径 + 对应 taskId 直接创 file-mode JsonlTraceService,
   * 不再走 `randomUUID()` L2 假 scope(已退役,per-agent 形态优先)。
   * Wire additive + optional —— 与 `role` 同形态;旧 envelope / 跨版本 resume →
   * 缺席,worker 退化到既有 IKNOW_TRACE_OUT / defaultTraceDir 形态(byte-stable)。
   */
  readonly traceFilePath?: string;
  /**
   * ADR-0102 T3: 工人 transcript 落点 —— `<父会话文件夹>/subagents/<taskId>/
   * <taskId>.jsonl`（与 `agent-<taskId>.jsonl` per-agent trace 分家，不是第二
   * 份 trace，也不是 continue 源的替代品 —— trace 语义不动）。worker loop 边跑
   * 边把消息 append 进这条账（SessionFileV1 读路径可吃）；subagent_continue
   * 的闸认它存在与否。Wire additive + optional —— 与 `traceFilePath` 同形态;
   * 旧 envelope（无此字段）→ ajv 接受 → worker 零 transcript 写（byte-stable）。
   */
  readonly transcriptPath?: string;
  /**
   * ADR-0085 / SC9:父会话账本锚点 —— worker 与父共用**同一本** todos.md,
   * `projectDir` = 父会话项目目录(`TodoWriteToolDeps.todoDir` 的同一值),
   * `conversationId` = 父会话 id。worker 装配期把它透传给 todo_write 工厂,
   * 工具据此 read / update 父账本,并对其 `add` 做 typed 拒绝(添加仅父会话)。
   *
   * 不从 trace 文件布局反推(fragile coupling):manager 从 host 注入的
   * `opts.todoDir` + `def.conversationId` 直接落值,与 todo-write.ts 的
   * `resolveConversationTodoPath` 同一对 (projectDir, conversationId)。
   *
   * Wire additive + optional —— 与 `role` 同形态;旧 envelope(无此字段)
   * 仍可被 ajv 接受,worker 装配路径退回「无 todoDir」旧形态
   * (`additionalProperties:false` 下需在 WORKER_SCHEMA.properties 显式声明)。
   */
  readonly todoLedger?: {
    readonly projectDir: string;
    readonly conversationId: string;
  };
  /**
   * T7 (`specs/skill-index-increment.md` / SC10 + assumption 7) — 父会话
   * spawn **当时**的完整模型索引快照（= 父冻表模型索引名 ∪ 父索引进场史名，
   * 见 ADR-0098）。在场 → worker 的 `<available_skills>` 冻表以它为**唯一
   * 来源**（worker 装配期现算一次，进 resolver 闭包后进程内恒定）；缺席
   * （旧 envelope / 跨版本 resume / manager 直造路径）→ worker 退回自己的
   * 独立 rescan（`createSkillScanner`），行为逐字节不变。
   *
   * **空数组 ≠ 缺席**：`[]` = 父确实没有模型索引（worker 渲染空清单句），
   * 键缺席 = 没人给快照（worker 自扫）。两者在 JSON 里可分辨，故父侧只在
   * getter 缺席 / 返回 undefined 时省略键，返回 `[]` 照样落线。
   *
   * 为什么传**条目**而不是只传 name 名单：spec 的判据是「完整」。父与 worker
   * 的技能根可以不同（插件根随 reload / 工作目录差异），按 name 在 worker
   * catalog 里回查会**丢条目**；直出条目还省掉 worker 侧的一次解析。代价是
   * 该名在 worker 里可能无正文可加载（`skill()` 报 not found）—— 索引可见、
   * 正文取不到是已知退化，好过静默少一行。
   *
   * Wire additive + optional —— 与 `role` 同形态;旧 envelope（无此字段）
   * 仍可被 ajv 接受，**不破现有契约**（`additionalProperties:false` 下需
   * 在 WORKER_SCHEMA.properties 显式声明）。
   */
  readonly skillIndexSnapshot?: readonly SkillIndexSnapshotEntry[];
}

/** 子→父 result 信封。schema 冻结形态见 PARENT_SCHEMA。 */
export interface SubAgentEnvelope {
  readonly status: "ok" | "failed";
  readonly summary: string;
  readonly result: string;
  readonly fileRefs?: readonly string[];
  /** 子代理 run 的 usage 快照 (TokenUsage 形态, JSON 可序列化; 与 schema `usage?: object` 对齐)。 */
  readonly usage?: object;
  readonly reason?:
    "crashed" | "maxTurnsExceeded" | "timeout" | "protocolError";
  /**
   * D-α 观测地板 (additive):子代理 run() 的实际停因,来源
   * `RunResult.stopReason`(loop-engine 八值 append-only 联合)。
   *
   * 与 `reason` 语义不同,**不合并**:`reason` 是父代理侧的失败归因四值枚举
   * (crashed / maxTurnsExceeded / timeout / protocolError),`stop_reason` 是
   * 子代理循环自身的停止原因(含 completed 等成功停因)。status / reason 两个
   * 枚举维持 V1 冻结形态(envelope-freeze.test.ts 锁定)。
   *
   * TS 侧直接复用 `StopReason`(唯一声明点,联合追加值时零漂移);wire schema
   * 侧刻意**不冻 enum**(见 PARENT_SCHEMA 注释)。缺席 = 该信封不是从一次
   * run() 返回值派生的(如 MaxTurnsExceeded 抛出路径),不可猜测。
   */
  readonly stop_reason?: StopReason;
  readonly truncated?: boolean;
  readonly totalLength?: number;
  /**
   * SC4 locator (additive): worker task id. Wire name `task_id` matches
   * wait:false spawn receipts. Absent on legacy envelopes.
   */
  readonly task_id?: string;
  /**
   * SC4 locator (additive): host path of this worker's fence `/tmp` pad
   * (`…/subagents/<taskId>/fence-tmp`). Used to read by id later.
   */
  readonly tmp_root?: string;
  /**
   * Locked sentence 2 (plans/session-fg-handoff-interrupt.md): pad-relative
   * path of the file the **host** wrote the worker's terminal assistant text
   * to (`FINAL_TEXT_PAD_NAME`, sibling of the pad's other products). The
   * parent-visible envelope stays a short summary — this field is the full-text
   * channel, read back with `subagent_result(tmp_path)`.
   *
   * Postel: present only when a file was actually written. A failed pad write
   * or an empty/whitespace-only `result` (e.g. the timeout fallback envelope)
   * omits the key rather than pointing at a file that does not exist.
   *
   * Wire additive + optional — legacy envelopes without it still parse; the
   * host's own stamp is in `attachParentVisibleTmp`.
   */
  readonly output_path?: string;
  /**
   * SC5 short roster of pad top-level names. SC4 success path omits it
   * or leaves it empty — T4 does not populate this field.
   */
  readonly product_roster?: readonly string[];
}

/**
 * SSOT name of the host-written final-text file inside a worker's pad.
 * Pad-relative (what `subagent_result(tmp_path)` consumes), never absolute.
 */
export const FINAL_TEXT_PAD_NAME = "final.md";

const TRUNCATION_LIMIT = 20000;
/** Parent-visible summary cap (handoff + crashed stderr tail). */
export const SUMMARY_LIMIT = 2000;
const TRUNCATION_MARKER = (total: number) =>
  `[report folded; total ${total} chars]`;

/**
 * 仓库同款 ajv 配置: strict: true + ajv-formats (同
 * src/harness/tools/registry.ts makeAjv)。D1 探针与 envelope.ts 共用同一份配置。
 */
export function makeEnvelopeAjv(): Ajv.default {
  const ajv = new Ajv.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  return ajv;
}

/** 父→子 worker 请求 schema (D1 冻结,探针与 product 同源)。 */
export const WORKER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    task: { type: "string" },
    systemPrompt: { type: "string" },
    disallowedTools: { type: "array", items: { type: "string" } },
    model: { type: "string" },
    maxTurns: { type: "integer", minimum: 1 },
    timeoutMs: { type: "integer", minimum: 1 },
    sandboxRoot: { type: "string" },
    env: { type: "object" },
    role: { type: "string" },
    finalText: { type: "string" },
    evidenceContext: { type: "object" },
    // T6: 写处境三态 —— 与 role 同形态（wire additive, optional）。
    // 枚举值锁进 wire schema（与 status / reason 同 — 是判定面）；
    // 旧 envelope（缺此字段）→ ajv 接受 → worker typed skip。
    writeSituation: {
      type: "string",
      enum: ["writable_main", "writable_tree", "no_writable_root"],
    },
    // T5: taskId —— 与 role 同形态（wire additive, optional）。
    // 不锁格式（uuid 形态由调用方决定，无 SSOT 枚举）。
    // 旧 envelope / 跨版本 resume → 缺省 → worker 走 IKNOW_TRACE_OUT 退路。
    taskId: { type: "string" },
    // T5: traceFilePath —— 与 role 同形态（wire additive, optional）。
    // 字符串路径，不锁 enum（路径形态由调用方决定，无 SSOT 枚举）。
    // 旧 envelope / 跨版本 resume → 缺省 → worker 走 IKNOW_TRACE_OUT 退路。
    traceFilePath: { type: "string" },
    // ADR-0102 T3: transcriptPath —— 与 traceFilePath 同形态（wire additive,
    // optional）。路径字符串不锁格式；旧 envelope 缺省 → worker 不写工人账。
    transcriptPath: { type: "string" },
    // ADR-0085 / SC9: 父会话账本锚点 —— 与 role 同形态（wire additive,
    // optional）。两个子字段都必填(锚点不完整即 repudiate,让装配层
    // 收到 ProtocolError 而不是一个残缺的 ledger 缝);旧 envelope 缺此
    // 字段 → ajv 接受 → worker 退回无 todoDir 的旧工具面。
    todoLedger: {
      type: "object",
      properties: {
        projectDir: { type: "string", minLength: 1 },
        conversationId: { type: "string", minLength: 1 },
      },
      required: ["projectDir", "conversationId"],
      additionalProperties: false,
    },
    // T7: 父会话当时完整模型索引快照 —— 与 role 同形态（wire additive,
    // optional）。条目锁 `{name, description?}`：name 必有且非空（裸名行
    // 也必须有名字），description 可选（降档形态），不收额外键（不给 wire
    // 开第二套字段）。空数组合法且**与键缺席不同义**（见接口注释）。
    // 旧 envelope（缺此字段）→ ajv 接受 → worker 走自己的独立 rescan。
    skillIndexSnapshot: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          description: { type: "string" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  required: ["task", "sandboxRoot"],
  additionalProperties: false,
};

/** 子→父 result envelope schema (D1 冻结,探针与 product 同源)。 */
export const PARENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    summary: { type: "string" },
    result: { type: "string" },
    fileRefs: { type: "array", items: { type: "string" } },
    usage: { type: "object" },
    reason: {
      type: "string",
      enum: ["crashed", "maxTurnsExceeded", "timeout", "protocolError"],
    },
    // D-α 观测地板 (additive): 子代理 run() 的实际停因。
    // `additionalProperties: false` 下新字段必须显式声明, 否则 ajv 直接把带
    // stop_reason 的信封判成 ProtocolError。
    //
    // 刻意**无 enum**: `StopReason` 是 append-only 联合 (016 五值 → 017 两值
    // → #672 fused), 把当前八值冻进 wire schema 意味着每次追加停因都要同步改
    // 两处、且旧 parent 会拒收新 worker 的合法信封。status / reason 两个枚举
    // 之所以冻, 是因为它们是父代理的**判定面** (V1 冻结契约 SC9); stop_reason
    // 只是观测面, 不参与任何分支判定, 因此按 Postel 收宽。
    stop_reason: { type: "string" },
    truncated: { type: "boolean" },
    totalLength: { type: "integer" },
    // SC4 locator (additive, optional): non-empty when a current worker
    // projects a parent-visible envelope. Legacy jsonl without these keys
    // still parses. minLength:1 so empty strings are protocol errors.
    task_id: { type: "string", minLength: 1 },
    tmp_root: { type: "string", minLength: 1 },
    // Locked sentence 2 (additive, optional): pad-relative path of the
    // host-written final text. `additionalProperties: false` means an
    // undeclared key here would make every stamped envelope a ProtocolError.
    // minLength:1 — an empty string is a protocol error, not "no file".
    output_path: { type: "string", minLength: 1 },
    product_roster: { type: "array", items: { type: "string" } },
  },
  required: ["status", "summary", "result"],
  additionalProperties: false,
};

function compileEnvelopeAjv(schema: Record<string, unknown>): ValidateFunction {
  return makeEnvelopeAjv().compile(schema);
}

/**
 * 解析 + 校验父→子 worker 请求信封。
 *
 * 失败模式 (全部 throw ProtocolError,SC13):
 *   - 输入非对象 (裸字符串 / 数组 / null) → throw;
 *   - 缺必填字段 (task / sandboxRoot) → throw;
 *   - wrong type (如 task: 123) → throw。
 *
 * 收尾 newline 先 trim 再 parse;多条 newline 时按首条独立 JSON parse
 * (plan D1 acceptance 3 形态,第二条独立 JSON 被忽略)。
 */
export function parseWorkerEnvelope(input: string): WorkerEnvelope {
  return parseEnvelope(input, "worker") as WorkerEnvelope;
}

/**
 * 解析 + 校验子→父 result 信封。失败模式同 parseWorkerEnvelope。
 */
export function parseParentEnvelope(input: string): SubAgentEnvelope {
  return parseEnvelope(input, "parent") as SubAgentEnvelope;
}

function parseEnvelope(input: string, direction: "worker" | "parent"): unknown {
  const validate = direction === "worker" ? workerValidate : parentValidate;
  // 协议 = 一条 envelope 一行 (newline-JSON)。输入含多条 newline 时按首条独立
  // JSON parse (第二条独立 JSON 被忽略,plan D1 acceptance 3 形态);
  // 收尾 newline 由首行截取 + trim 消化。
  const firstLine = input.split("\n", 1)[0] ?? "";
  const trimmed = firstLine.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new ProtocolError(
      `subagent envelope parse failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProtocolError(
      `subagent ${direction} envelope: expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`
    );
  }
  if (!validate(parsed)) {
    throw new ProtocolError(
      `subagent ${direction} envelope validation failed: ${JSON.stringify(validate.errors ?? [])}`
    );
  }
  return parsed;
}

function shortSummary(summary: string, result: string): string {
  const source = summary.length > 0 ? summary : result;
  return source.length > SUMMARY_LIMIT
    ? `${source.slice(0, SUMMARY_LIMIT)}…`
    : source;
}

function failedSummary(env: SubAgentEnvelope): string {
  return env.reason === undefined
    ? "subagent failed"
    : `subagent failed: ${env.reason}`;
}

/**
 * SC5: empty handoff, or crash / timeout / truncated terminal.
 * Host may attach a short top-level pad roster (names only).
 */
export function shouldAttachProductRoster(env: SubAgentEnvelope): boolean {
  if (env.truncated === true) return true;
  if (env.reason === "crashed" || env.reason === "timeout") return true;
  if (env.summary.length === 0 && env.result.length === 0) return true;
  return (
    env.status === "failed" &&
    env.result.length === 0 &&
    env.summary === failedSummary(env)
  );
}

function shortHandoff(
  summary: string,
  fileRefs: readonly string[] | undefined,
  stopReason: StopReason | undefined
): string {
  const sections = [summary];
  if (fileRefs !== undefined && fileRefs.length > 0) {
    sections.push(
      `Changed files:\n${fileRefs.map((fileRef) => `- ${fileRef}`).join("\n")}`
    );
  }
  if (stopReason !== undefined) {
    sections.push(`Stop reason: ${stopReason}`);
  }
  return sections.filter((section) => section.length > 0).join("\n\n");
}

/**
 * 父可见投影：给父模型看的交差层（短摘要 + 路径 + 停因），不是终稿全文。
 * `truncated` 在原文长于交差或超过 20000 字时为真（汇报收束，不是任务失败）。
 */
/**
 * Stamp SC4 locator fields onto a parent-visible envelope.
 * `tmp_root` is omitted when the caller has no pad (legacy manager).
 */
export function attachParentVisibleTmp(
  env: SubAgentEnvelope,
  loc: {
    readonly task_id: string;
    readonly tmp_root?: string;
    /**
     * Locked sentence 2: pad-relative path of the host-written final text.
     * Absent when no file was written (Postel) — never point at a file that
     * does not exist.
     */
    readonly output_path?: string;
  }
): SubAgentEnvelope {
  return {
    ...env,
    task_id: loc.task_id,
    ...(loc.tmp_root !== undefined ? { tmp_root: loc.tmp_root } : {}),
    ...(loc.output_path !== undefined ? { output_path: loc.output_path } : {}),
  };
}

export function projectParentVisibleEnvelope(
  env: SubAgentEnvelope
): SubAgentEnvelope {
  const summary =
    env.status === "failed" &&
    env.summary.length === 0 &&
    env.reason !== "timeout"
      ? failedSummary(env)
      : shortSummary(env.summary, env.result);
  const handoff = shortHandoff(summary, env.fileRefs, env.stop_reason);
  const originalLen = env.result.length;
  const needsFoldMarker = originalLen > TRUNCATION_LIMIT;
  let result = handoff;
  if (needsFoldMarker) {
    const marker = TRUNCATION_MARKER(originalLen);
    const separator = handoff.length > 0 ? "\n\n" : "";
    const available = TRUNCATION_LIMIT - marker.length - separator.length;
    const boundedHandoff =
      handoff.length <= available
        ? handoff
        : `${handoff.slice(0, Math.max(0, available - 1))}…`;
    result = `${boundedHandoff}${separator}${marker}`;
  }
  const truncated = needsFoldMarker || originalLen > result.length;
  if (
    env.summary === summary &&
    env.result === result &&
    env.truncated === undefined &&
    env.totalLength === undefined &&
    !truncated
  ) {
    return env;
  }
  return {
    ...env,
    summary,
    result,
    ...(truncated ? { truncated: true, totalLength: originalLen } : {}),
  };
}

/**
 * IPC 浓缩：result > 20000 时折叠，避免把终稿全文塞进进程间信封。
 * 未超限保持字段，供 graph 节点沿边传递上游产物。父模型交差走
 * `projectParentVisibleEnvelope`。
 */
export function truncateEnvelopeResult(
  env: SubAgentEnvelope
): SubAgentEnvelope {
  if (env.result.length <= TRUNCATION_LIMIT) {
    if (
      env.status === "failed" &&
      env.summary.length === 0 &&
      env.reason !== "timeout"
    ) {
      return { ...env, summary: failedSummary(env) };
    }
    return env;
  }
  return projectParentVisibleEnvelope(env);
}

const workerValidate = compileEnvelopeAjv(WORKER_SCHEMA);
const parentValidate = compileEnvelopeAjv(PARENT_SCHEMA);
