/**
 * src/tui/mouse.ts
 *
 * 鼠标滚轮捕获（标准 SGR 协议，DECSET 1000h + 1006h）。
 *
 * 为什么需要（#236 朴素滚动 + 滚轮）：ink 渲染到 normal buffer（alternateScreen:false），
 * 每帧重渲染覆盖屏幕。终端原生 scrollback 在这种情况下全是中间帧垃圾，滚轮翻历史
 * 看不到干净内容、且与 app 滚动状态脱节（"滚上去没法滚回来"）。唯一稳定做法是
 * 让 app 捕获滚轮 → 走同一个 chatScroll（与 PgUp/PgDn 一致）。
 *
 * 协议：DECSET 1000h = 报告按钮事件；1006h = SGR 编码（iTerm2/Windows Terminal/xterm
 * 通用）。滚轮 button code = 64（up）/ 65（down）。序列形态：\x1b[<64;x;yM（按下）
 * / \x1b[<64;x;ym（释放）。终端在用户停止滚动后会发 button=32/35（非滚轮按下+释放
 * 对），我们只看 button=64/65 的 "M"（按下）事件，避免双计数。
 *
 * 与 useInput 的关系：ink 的 useInput 同样会从 stdin 收到 SGR 序列（剥 ESC 后形态
 * "[<数字;数字;数字M/m"），由 isSgrMouseSequence 守卫丢弃，避免污染键盘键链。
 * 我们的 listener 与 ink useInput 并行：listener 先注册并消费滚轮，剩余字节透传。
 *
 * 卸载必须写 DECRST（1000l/1006l）关闭报告，否则残留模式会污染粘贴 / 选择。
 */
export interface MouseWheelCounts {
  /** 滚轮上滚（向历史）累计。一次 stdin chunk 可能含多个事件。 */
  readonly wheelUp: number;
  /** 滚轮下滚（向最新）累计。 */
  readonly wheelDown: number;
}

/** SGR 鼠标 button code（DECSET 1006 + 1000h 协议）。 */
const BUTTON_WHEEL_UP = 64;
const BUTTON_WHEEL_DOWN = 65;

/** DECSET 序列（启用 / 关闭 鼠标报告）。 */
const DECSET_MOUSE_REPORT_ENABLE = "\x1b[?1000h\x1b[?1006h";
const DECSET_MOUSE_REPORT_DISABLE = "\x1b[?1000l\x1b[?1006l";

/** ink useInput 守卫：ink 内部 use-input.js 剥 ESC 前缀，传到 useInput 回调时是
 *  "[<数字;数字;数字M/m" 形态。用单点维护避免两处 regex 漂移。 */
export function isSgrMouseSequence(input: string): boolean {
  return /^\[<\d+;\d+;\d+[Mm]$/.test(input);
}

// SGR 鼠标序列：\x1b[<button;x;y[Mm] （button=64/65 = 滚轮；M=按下，m=释放）
// 全局 g 防多行遗漏；不让我们在这里二次丢弃——只识别。
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** 解析一个 stdin chunk 中的 SGR 滚轮事件（仅 button=64/65 + M 终止符）。
 *  非 string 返回全零（app.tsx 用 chunk.toString 保险一层）。 */
export function parseMouseEvents(chunk: string): MouseWheelCounts {
  if (typeof chunk !== "string" || chunk.length === 0) {
    return { wheelUp: 0, wheelDown: 0 };
  }
  let wheelUp = 0;
  let wheelDown = 0;
  const re = new RegExp(SGR_MOUSE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    if (m[4] !== "M") continue; // 只数按下事件，释放不计
    const button = Number.parseInt(m[1] as string, 10);
    if (button === BUTTON_WHEEL_UP) wheelUp += 1;
    else if (button === BUTTON_WHEEL_DOWN) wheelDown += 1;
  }
  return { wheelUp, wheelDown };
}

/** 启用鼠标滚轮报告（SGR）。非 TTY stdout = no-op（测试 fs stream），返回空 cleanup。 */
export function enableMouseScroll(stdout: NodeJS.WriteStream): () => void {
  if (!stdout.isTTY) return (): void => undefined;
  stdout.write(DECSET_MOUSE_REPORT_ENABLE);
  let called = false;
  return (): void => {
    if (called) return;
    called = true;
    if (!stdout.isTTY) return;
    stdout.write(DECSET_MOUSE_REPORT_DISABLE);
  };
}
