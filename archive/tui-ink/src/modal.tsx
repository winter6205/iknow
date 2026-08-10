/**
 * src/tui/modal.tsx
 *
 * #279 项3：TUI modal 渲染槽（对齐 upstream-openharness 的 ModalHost +
 * SelectModal 模式，自写实现）：
 *  - `SelectModal`：通用选择 modal（标题 + 选项列表 + 选中索引 + 键位提示），
 *    纯渲染、无内部状态（选中索引 / 键路由由宿主持有，与 openharness 同构）；
 *  - `ModalHost`：按 modal 判别联合分派渲染（permission / select），无活动
 *    modal 时返回 null；
 *  - 权限确认实例 = `PERMISSION_ANSWERS`（y/a/n = once/always/reject）喂给
 *    SelectModal，键路由走纯函数 `reduceModalKey`（宿主 useInput 消费）。
 *
 * 行账纪律（#189 / #268 同类）：modal 占屏必须入账 —— `selectModalRows`
 * 用 **wrap-ansi（ink 折行同款库、同参数 trim:false + hard:true）** 预测
 * modal 盒子的实际终端行数（边框 2 行 + 内文折行后行数），app 层
 * chromeReserveRows 据此压缩 viewport，窄终端不溢出。不能用贪心字符填充
 * （wrapTextVisual）：ink 走 wrap-ansi 整词换行，长工具名 + 窄列时贪心
 * 填充少算行数 → 帧高溢出。渲染与行账共用 `selectModalContent` /
 * `selectOptionLine` 单一来源，防双份实现漂移。
 */
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import wrapAnsi from "wrap-ansi";
import { tuiPalette } from "./theme.js";

/** 通用选择项：hotkey 直选（大小写不敏感）；description 行内补充说明。 */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly hotkey?: string;
  readonly description?: string;
}

/** SelectModal 内容描述（渲染与行账共用 SSOT）。 */
export interface SelectModalContent {
  readonly title: string;
  readonly description?: string;
  readonly options: ReadonlyArray<SelectOption>;
  /** 底部键位提示行（缺省 = 通用 ↑↓/Enter/Esc 提示）。 */
  readonly hint?: string;
}

/** 权限确认三态：once = 本次允许；always = 总是允许（本会话）；reject = 拒绝。 */
export type PermissionAnswer = "once" | "always" | "reject";

export const PERMISSION_ANSWERS: ReadonlyArray<SelectOption> = Object.freeze([
  Object.freeze({ value: "once", hotkey: "y", label: "本次允许" }),
  Object.freeze({
    value: "always",
    hotkey: "a",
    label: "总是允许（本会话）",
  }),
  Object.freeze({ value: "reject", hotkey: "n", label: "拒绝" }),
]);

export const PERMISSION_MODAL_HINT = "y/a/n 直选 · ↑↓ + Enter · Esc 收起";
export const SELECT_MODAL_HINT = "↑↓ 选择 · Enter 确认 · Esc 收起";

/** modal 判别联合（ModalHost 分派入口）。 */
export type TuiModal =
  | {
      readonly kind: "permission";
      readonly tool: string;
      readonly summaryHint: string;
      readonly selectedIndex: number;
    }
  | ({ readonly kind: "select" } & SelectModalContent & {
        readonly selectedIndex: number;
      });

/** 权限 modal 的内容描述（渲染 + 行账单一来源）。 */
export function permissionModalContent(ask: {
  readonly tool: string;
  readonly summaryHint: string;
}): SelectModalContent {
  return {
    title: `允许执行 ${ask.tool}？`,
    ...(ask.summaryHint.length > 0 ? { description: ask.summaryHint } : {}),
    options: PERMISSION_ANSWERS,
    hint: PERMISSION_MODAL_HINT,
  };
}

/** 选项行纯文本（含 hotkey 前缀 + description）；渲染与行账共用。 */
export function selectOptionLine(option: SelectOption): string {
  const hotkey = option.hotkey ? `[${option.hotkey}] ` : "";
  const desc = option.description ? `  ${option.description}` : "";
  return `${hotkey}${option.label}${desc}`;
}

/** 盒子内文可用宽度：终端列 - 左右边框 2 - paddingX 左右各 1。cols 极窄
 *  （<4）时归 0（不再设 8 下限——下限会在 cols<12 高估内宽、低估折行行数）。 */
export function selectModalInnerWidth(cols: number): number {
  return Math.max(0, cols - 4);
}

/**
 * 按 ink 同款折行把内文行拆成物理行：wrap-ansi + `{trim:false, hard:true}`
 * （ink wrapText 'wrap' 模式的原参数）。ink 走整词换行——贪心字符填充
 * （wrapTextVisual）在长工具名 + 窄列时少算行数，行账必须与渲染同库同参。
 * 内宽 ≤ 0（cols<4 退化终端）无法再折 → 记 1 行。
 */
function wrapModalLines(s: string, inner: number): string[] {
  if (inner <= 0) return [s];
  return wrapAnsi(s, inner, { trim: false, hard: true }).split("\n");
}

/**
 * modal 盒子实际占用的终端行数（行账 SSOT，可单测）：上下边框 2 行 +
 * 标题 / 描述 / 选项 / 键位提示按 wrap-ansi 折行后的行数。选中行的 `❯ `
 * 前缀与非选中行的两空格前缀等宽（各 2 列），折行预测按选中形态计（最宽形态）。
 */
export function selectModalRows(
  content: SelectModalContent,
  cols: number,
  selectedIndex = 0
): number {
  const inner = selectModalInnerWidth(cols);
  let rows = 2; // 圆角边框：顶框线 + 底框线
  rows += wrapModalLines(content.title, inner).length;
  if (content.description !== undefined && content.description.length > 0) {
    rows += wrapModalLines(content.description, inner).length;
  }
  content.options.forEach((opt, i) => {
    const prefix = i === selectedIndex ? "❯ " : "  ";
    rows += wrapModalLines(`${prefix}${selectOptionLine(opt)}`, inner).length;
  });
  const hint = content.hint ?? SELECT_MODAL_HINT;
  rows += wrapModalLines(hint, inner).length;
  return rows;
}

/** 权限 modal 占行（chromeReserveRows 入账用）。 */
export function permissionModalRows(
  ask: { readonly tool: string; readonly summaryHint: string },
  cols: number,
  selectedIndex = 0
): number {
  return selectModalRows(permissionModalContent(ask), cols, selectedIndex);
}

/**
 * 通用选择 modal（纯渲染）：圆角线框 + 标题 + 可选描述 + 选项列表 +
 * 底部键位提示。selectedIndex 由宿主持有（↑↓ / Enter / hotkey / Esc 的
 * 键路由在宿主 useInput，走 reduceModalKey 纯函数）。
 */
export function SelectModal(props: {
  readonly content: SelectModalContent;
  readonly selectedIndex: number;
  readonly cols: number;
}): ReactElement {
  const pal = tuiPalette;
  const { content, selectedIndex } = props;
  const hint = content.hint ?? SELECT_MODAL_HINT;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={pal.running}
      paddingX={1}
      marginBottom={1}
    >
      <Text color={pal.running} bold>
        {content.title}
      </Text>
      {content.description !== undefined && content.description.length > 0 && (
        <Text color={pal.dim}>{content.description}</Text>
      )}
      {content.options.map((opt, i) => {
        const selected = i === selectedIndex;
        return (
          <Text key={opt.value} color={selected ? pal.accent : pal.dim}>
            {selected ? "❯ " : "  "}
            {opt.hotkey !== undefined ? `[${opt.hotkey}] ` : ""}
            <Text color={selected ? pal.text : pal.dim} bold={selected}>
              {opt.label}
            </Text>
            {opt.description !== undefined ? (
              <Text color={pal.dim}> {opt.description}</Text>
            ) : null}
          </Text>
        );
      })}
      <Text color={pal.dim}>{hint}</Text>
    </Box>
  );
}

/**
 * ModalHost：modal 渲染槽。无活动 modal → null（行账 0）；permission →
 * 权限确认三选项；select → 通用选择。与 openharness ModalHost 同构
 * （宿主持状态 + 键路由，Host 只做分派渲染）。
 */
export function ModalHost(props: {
  readonly modal: TuiModal | undefined;
  readonly cols: number;
}): ReactElement | null {
  const { modal, cols } = props;
  if (modal === undefined) return null;
  if (modal.kind === "permission") {
    return (
      <SelectModal
        content={permissionModalContent(modal)}
        selectedIndex={modal.selectedIndex}
        cols={cols}
      />
    );
  }
  return (
    <SelectModal
      content={modal}
      selectedIndex={modal.selectedIndex}
      cols={cols}
    />
  );
}

/** reduceModalKey 的键位输入切片（宿主 useInput 参数投影）。 */
export interface ModalKeyEvent {
  readonly input: string;
  readonly key: {
    readonly upArrow: boolean;
    readonly downArrow: boolean;
    readonly return: boolean;
    readonly escape: boolean;
    readonly ctrl: boolean;
    readonly meta: boolean;
  };
}

/** reduceModalKey 决策结果。 */
export type ModalKeyAction =
  | { readonly type: "move"; readonly index: number }
  | { readonly type: "select"; readonly value: string }
  | { readonly type: "dismiss" }
  | { readonly type: "ignore" };

/**
 * modal 键路由纯函数（宿主 useInput 消费，可单测）：
 *  - ↑/↓ 移动选中索引（clamp）；Enter 选中当前项；Esc 收起（dismiss）；
 *  - 可打印字符按 hotkey 直选（大小写不敏感）；
 *  - ctrl/meta 组合键与无匹配字符 → ignore（宿主自行决定是否吞键）。
 */
export function reduceModalKey(
  event: ModalKeyEvent,
  modal: {
    readonly options: ReadonlyArray<SelectOption>;
    readonly selectedIndex: number;
  }
): ModalKeyAction {
  const { options, selectedIndex } = modal;
  const { input, key } = event;
  if (key.ctrl || key.meta) return { type: "ignore" };
  if (key.upArrow) {
    return { type: "move", index: Math.max(0, selectedIndex - 1) };
  }
  if (key.downArrow) {
    return {
      type: "move",
      index: Math.min(options.length - 1, selectedIndex + 1),
    };
  }
  if (key.return) {
    const current = options[selectedIndex];
    return current !== undefined
      ? { type: "select", value: current.value }
      : { type: "ignore" };
  }
  if (key.escape) return { type: "dismiss" };
  const lower = input.toLowerCase();
  if (lower.length > 0) {
    const hit = options.find(
      (opt) => opt.hotkey !== undefined && opt.hotkey.toLowerCase() === lower
    );
    if (hit !== undefined) return { type: "select", value: hit.value };
  }
  return { type: "ignore" };
}
