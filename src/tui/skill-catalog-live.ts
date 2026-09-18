/**
 * `skill-index-increment` SC8（slash 侧）—— TUI 斜杠候选面的「当场热」。
 *
 * Spec: `specs/skill-index-increment.md` SC8 / T6。
 *
 * ## 为什么需要这个 hook
 *
 * `TuiExtensions.skillCatalog` 是**装配期**一次扫描的快照（`run.tsx` 经
 * `buildTuiDeps` 的 onExtensions 注入，props 一路静态透传到 `TuiApp`）。
 * 用户在一次会话中间把 SKILL.md 落盘（自己写、`/` 外的工具写、插件目录
 * 就位）之后，候选面**没有任何刷新路径** —— 整个会话期都看不见新条目。
 * SC8 要求「安装 / reload 当下 slash 候选已含可加载新条目，不必等下一
 * turn」。
 *
 * 本 hook 把「打开斜杠面板」当作那个人侧可观测的**当下**：上升沿触发一次
 * `rescan()`，拿到现行可加载面就换给渲染面。模型侧的增量仍归 T5
 * （`skillIndexDelta`）—— 人侧与模型侧是两条独立的读路径，本 hook 只动人侧。
 *
 * ## 失败取舍（Input-contract exception 列）
 *
 * `rescan()` 的 IO 故障抛 typed `SkillRescanError`（`rescan.ts`）。人侧候选
 * 是宽松面：**失败保留缓存 catalog**，不清空候选、不上抛、不阻断输入 ——
 * 「根目录一时读不到」不该让人连既有的 `/help` 都用不了。失败经
 * `onRescanError` 上报（宿主落 notice），便于操作员看见退化。
 *
 * 注意这与**模型侧**的取舍相反且刻意：`computeSkillIndexDelta` 在同一个
 * typed 错误上必须上抛（残缺的扫描结果贴进 messages 会被模型读成「技能被
 * 删了」）。两条纪律的分界是「读的人是谁」。
 *
 * ## 与 props 的关系
 *
 * 刷新结果只对**它扫出来时的那份 base catalog** 有效：引擎重建 / rebind
 * 后 `catalog` prop 换对象，旧结果立即作废（返回新 prop），避免拿上一个
 * 引擎的根列表冒充现行面。
 */
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../harness/errors.js";
import type { SkillCatalog } from "../harness/skill/catalog.js";
import type { SkillRescanner } from "../harness/skill/rescan.js";

export interface LiveSkillCatalogOptions {
  /** 装配期缓存 catalog（props 透传；引擎重建后换对象）。 */
  readonly catalog: SkillCatalog;
  /**
   * T6 rescan 缝。缺席（测试 / fixture / ask 形态）→ 本 hook 退化为**恒等
   * 透传** props catalog，不扫描也不改行为。
   */
  readonly rescanner: SkillRescanner | undefined;
  /**
   * 斜杠面板是否打开（输入 trim 后以 `/` 开头）。**上升沿**触发一次 rescan
   * —— 每次「打开面板」都是一次新的「当下」。
   */
  readonly paletteOpen: boolean;
  /**
   * rescan 失败上报（typed `SkillRescanError`，或任何 rescan 抛出的东西）。
   * 缺席 → 失败静默保留缓存（调用方不关心时可省）。
   */
  readonly onRescanError: ((err: unknown) => void) | undefined;
}

/**
 * rescan 失败的 notice 文案（人侧可读）。
 *
 * `SkillRescanError` 是 typed 错误（判别位 `kind: "rescan_failed"` + `faults`
 * 明细），按 `.claude/rules/code-quality.md` 的 typed-error catch 契约：**先
 * 认 `kind` 再分流**，不得走 `String(err)` —— 那样 `faults` 里的路径与 errno
 * 全部不可见，操作员只看到 `[object Object]`。
 *
 * 非该形态（编程错误 / 非 Error 抛出物）退化为 `Error#message`，不假装是
 * rescan 故障。
 */
export function formatSkillRescanFailure(err: unknown): string {
  const shaped = err as {
    readonly kind?: unknown;
    readonly faults?: readonly {
      readonly kind?: unknown;
      readonly path?: unknown;
      readonly code?: unknown;
    }[];
  };
  if (
    typeof err === "object" &&
    err !== null &&
    shaped.kind === "rescan_failed" &&
    Array.isArray(shaped.faults)
  ) {
    const detail = shaped.faults
      .map((fault) => {
        const code = fault.code === undefined ? "" : ` (${String(fault.code)})`;
        return `${String(fault.kind)} ${String(fault.path)}${code}`;
      })
      .join("; ");
    return `技能重扫失败（候选保留上次结果）：${detail}`;
  }
  // 非 rescan 形态 → sanctioned renderer（先 Error.message，plain object
  // 走 JSON.stringify 兜底，kind/faults 不丢）。
  return errorMessage(err);
}

export function useLiveSkillCatalog(
  options: LiveSkillCatalogOptions
): SkillCatalog {
  const { catalog, rescanner, paletteOpen } = options;
  // 刷新结果连同它扫出来时的 base 一起存：base 不匹配 = 陈旧结果，直接在
  // render 期丢掉（不靠 effect 清理，避免「先渲染一帧旧引擎的 catalog」）。
  const [refreshed, setRefreshed] = useState<
    { readonly base: SkillCatalog; readonly catalog: SkillCatalog } | undefined
  >(undefined);
  // 本次「打开」已为哪份 base 扫过 —— 上升沿复位，保证每次打开重扫一次
  // （同一次打开期间 catalog 换对象也会重扫：那是换引擎，值得重扫）。
  const scannedBase = useRef<SkillCatalog | undefined>(undefined);
  // 代际：base 换掉后落地的旧结果作废。effect 因 deps 身份变化重跑时**不**
  // 推进代际（早退分支在上方），故 in-flight 的 rescan 不会被误丢。
  const generation = useRef(0);
  // 回调经 ref 读：调用方通常传内联箭头（每次 render 新身份），进 deps 会
  // 让 effect 每帧重跑（虽被早退挡住，但白白多跑）；放进 ref 则 deps 只剩
  // 真正的「何时该重扫」信号。
  const onRescanError = useRef(options.onRescanError);
  onRescanError.current = options.onRescanError;

  useEffect(() => {
    // alive-ref（与 useSubagentsPolling / useAsksPolling 同款纪律）：组件
    // 卸载后落地的 rescan 回调不得写 state / 触发宿主回调 —— 否则
    // 「setState on unmounted」与「卸载后的引擎报错给卸载前的宿主」都会
    // 发生。代际守卫管「结果该不该落地」，alive 管「组件还在不在」。
    let alive = true;
    // 面板关闭 → 复位：下一次打开是新的一次「当场」。
    if (!paletteOpen) {
      scannedBase.current = undefined;
      return () => {
        alive = false;
      };
    }
    if (rescanner === undefined || scannedBase.current === catalog) {
      return () => {
        alive = false;
      };
    }
    scannedBase.current = catalog;
    const mine = (generation.current += 1);
    void rescanner.rescan().then(
      (faces) => {
        if (alive && generation.current === mine)
          setRefreshed({ base: catalog, catalog: faces });
      },
      (err: unknown) => {
        // EXIT: rescan 失败 → 保留缓存 catalog（见文件头「失败取舍」）。
        if (alive && generation.current === mine) onRescanError.current?.(err);
      }
    );
    return () => {
      alive = false;
    };
  }, [paletteOpen, catalog, rescanner]);

  if (refreshed !== undefined && refreshed.base === catalog) {
    return refreshed.catalog;
  }
  return catalog;
}
