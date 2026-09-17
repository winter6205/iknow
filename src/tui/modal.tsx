/** @jsxImportSource @opentui/react */
/**
 * src/tui/modal.tsx
 *
 * #343 T4（自 archive/tui-ink/src/modal.tsx 迁移 ink → OpenTUI，语义不变）：
 * TUI modal 渲染槽：
 *  - `SelectModal`：通用选择 modal（标题 + 选项列表 + 选中索引 + 键位提示），
 *    纯渲染、无内部状态（选中索引 / 键路由由宿主持有）；
 *  - `ModalHost`：按 modal 判别联合分派渲染（permission / select），无活动
 *    modal 时返回 null；
 *  - 权限确认实例 = `PERMISSION_ANSWERS`（y/a/n = once/always/reject）喂给
 *    SelectModal，键路由走纯函数 `reduceModalKey`（宿主 useKeyboard 消费，
 *    OpenTUI KeyEvent 经 `modalKeyEventOf` 投影为 ModalKeyEvent）。
 *
 * 行账纪律（OpenTUI 版）：渲染与行账共用 `wrapModalLines`（wrap-ansi，
 * trim:false + hard:true）把每个逻辑行折成物理行 —— SelectModal 逐物理行
 * 渲染 `<text>`，盒子高度 = 边框 2 + 物理行数，`selectModalRows` 同式预测，
 * 两者永不漂移（tests/tui/modal.test.tsx 行账不变式实测 ╭→╰ 行数核对）。
 */
import type { ReactNode } from "react";
import { TextAttributes, type KeyEvent } from "@opentui/core";
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
 *  （<4）时归 0（不设下限——下限会在窄终端高估内宽、低估折行行数）。 */
export function selectModalInnerWidth(cols: number): number {
  return Math.max(0, cols - 4);
}

/**
 * 按折行把内文行拆成物理行：wrap-ansi + `{trim:false, hard:true}`。
 * 内宽 ≤ 0（cols<4 退化终端）无法再折 → 记 1 行。
 * 渲染（SelectModal）与行账（selectModalRows）共用本函数 —— 单一来源。
 */
export function wrapModalLines(s: string, inner: number): string[] {
  if (inner <= 0) return [s];
  return wrapAnsi(s, inner, { trim: false, hard: true }).split("\n");
}

/**
 * modal 盒子实际占用的终端行数（行账 SSOT，可单测）：上下边框 2 行 +
 * 标题 / 描述 / 选项 / 键位提示折行后的行数。选中行的 `❯ ` 前缀与非选中
 * 行的两空格前缀等宽（各 2 列），折行预测按选中形态计（最宽形态）。
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

/** 权限 modal 占行（chrome 行账入账用）。 */
export function permissionModalRows(
  ask: {
    readonly tool: string;
    readonly summaryHint: string;
  },
  cols: number,
  selectedIndex = 0
): number {
  return selectModalRows(permissionModalContent(ask), cols, selectedIndex);
}

/** 选项选中行的 `❯ ` / 非选中行的两空格前缀宽度（各 2 列）。 */
const OPTION_PREFIX = "❯ ";

/**
 * 通用选择 modal（纯渲染）：圆角线框 + 标题 + 可选描述 + 选项列表 +
 * 底部键位提示。selectedIndex 由宿主持有（↑↓ / Enter / hotkey / Esc 的
 * 键路由在宿主 useKeyboard，走 reduceModalKey 纯函数）。
 *
 * 每个逻辑行先经 wrapModalLines 折成物理行再逐行 `<text>` 渲染 —— 与
 * selectModalRows 同源，盒子高度 = 预测行数（行账不变式）。
 */
export function SelectModal(props: {
  readonly content: SelectModalContent;
  readonly selectedIndex: number;
  readonly cols: number;
}): ReactNode {
  const pal = tuiPalette;
  const { content, selectedIndex, cols } = props;
  const inner = selectModalInnerWidth(cols);
  const hint = content.hint ?? SELECT_MODAL_HINT;
  const lines: ReactNode[] = [];

  wrapModalLines(content.title, inner).forEach((line, i) => {
    lines.push(
      <text
        key={`title-${i}`}
        fg={pal.running}
        attributes={TextAttributes.BOLD}
      >
        {line}
      </text>
    );
  });
  if (content.description !== undefined && content.description.length > 0) {
    wrapModalLines(content.description, inner).forEach((line, i) => {
      lines.push(
        <text key={`desc-${i}`} fg={pal.dim}>
          {line}
        </text>
      );
    });
  }
  content.options.forEach((opt, optIdx) => {
    const selected = optIdx === selectedIndex;
    const prefix = selected ? OPTION_PREFIX : "  ";
    wrapModalLines(`${prefix}${selectOptionLine(opt)}`, inner).forEach(
      (line, i) => {
        // 选中项首物理行：`❯ ` 前缀上 accent，其余上正文色（与非选中区分）。
        if (selected && i === 0 && line.startsWith(OPTION_PREFIX)) {
          lines.push(
            <text key={`opt-${optIdx}-${i}`}>
              <span fg={pal.accent}>{OPTION_PREFIX}</span>
              <span fg={pal.text} attributes={TextAttributes.BOLD}>
                {line.slice(OPTION_PREFIX.length)}
              </span>
            </text>
          );
          return;
        }
        lines.push(
          <text
            key={`opt-${optIdx}-${i}`}
            fg={selected ? pal.text : pal.dim}
            attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}
          >
            {line}
          </text>
        );
      }
    );
  });
  wrapModalLines(hint, inner).forEach((line, i) => {
    lines.push(
      <text key={`hint-${i}`} fg={pal.dim}>
        {line}
      </text>
    );
  });

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={pal.running}
      paddingX={1}
      marginBottom={1}
    >
      {lines}
    </box>
  );
}

/**
 * ModalHost：modal 渲染槽。无活动 modal → null（行账 0）；permission →
 * 权限确认三选项；select → 通用选择。宿主持状态 + 键路由，Host 只做分派渲染。
 */
export function ModalHost(props: {
  readonly modal: TuiModal | undefined;
  readonly cols: number;
}): ReactNode {
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

/** reduceModalKey / reduceThinkingSwitchKey / reduceThinkingEffortKey 的键位
 *  输入切片（宿主键事件的投影形态）。OpenTUI KeyEvent.name 值域（同
 *  parse.keypress 常量）：↑/↓ = "up"/"down"，←/→ = "left"/"right"，Enter/Esc/
 *  Tab/Space = "return"/"escape"/"tab"/"space"。 */
export interface ModalKeyEvent {
  readonly input: string;
  readonly key: {
    readonly upArrow: boolean;
    readonly downArrow: boolean;
    readonly leftArrow: boolean;
    readonly rightArrow: boolean;
    readonly tab: boolean;
    readonly space: boolean;
    readonly return: boolean;
    readonly escape: boolean;
    readonly ctrl: boolean;
    readonly meta: boolean;
  };
}

/** OpenTUI KeyEvent → ModalKeyEvent 投影（宿主 useKeyboard 与 reduceModalKey
 *  之间的适配单源；单字符可打印键走 hotkey 直选通道）。 */
export function modalKeyEventOf(e: KeyEvent): ModalKeyEvent {
  return {
    input: typeof e.name === "string" && e.name.length === 1 ? e.name : "",
    key: {
      upArrow: e.name === "up",
      downArrow: e.name === "down",
      leftArrow: e.name === "left",
      rightArrow: e.name === "right",
      tab: e.name === "tab",
      space: e.name === "space",
      return: e.name === "return",
      escape: e.name === "escape",
      ctrl: e.ctrl,
      meta: e.meta,
    },
  };
}

/** reduceModalKey 决策结果。 */
export type ModalKeyAction =
  | { readonly type: "move"; readonly index: number }
  | { readonly type: "select"; readonly value: string }
  | { readonly type: "dismiss" }
  | { readonly type: "ignore" };

/**
 * modal 键路由纯函数（宿主 useKeyboard 消费，可单测）：
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
