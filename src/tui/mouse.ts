/**
 * src/tui/mouse.ts
 *
 * 鼠标滚轮支持（#146 行级滚动，ink 7.1.1 的 Key 类型没有 mouse 字段，
 * useInput 也不解析 SGR 鼠标序列；必须自己实现）。
 *
 * 协议：DECSET 1000h（启用鼠标报告）+ DECSET 1006h（SGR 编码格式）。
 * 滚轮事件 button code = 64（上滚，wheel up）/ 65（下滚，wheel down）。
 * 序列形态：\x1b[<64;x;yM（按下）/ \x1b[<64;x;ym（释放，禁用 m=M）。
 * 终端在用户停止滚动后会发「非滚轮按下」+「释放」对（button=32/35）；
 * 我们只看 button=64/65 的「按下」事件，避免把释放事件误算成滚动。
 *
 * 用法：
 *   const disable = enableMouseScroll(stdout);
 *   // 卸载时：
 *   disable();
 *
 *   const handler = (chunk: string) => {
 *     const { wheelUp, wheelDown } = parseMouseEvents(chunk);
 *     if (wheelUp > 0) ...; if (wheelDown > 0) ...;
 *   };
 *   stdin.on('data', handler);
 *   // 卸载时：
 *   stdin.off('data', handler);
 *
 * ink 内部也监听 stdin.data（EventEmitter 广播，多个 listener 不冲突）。
 * 鼠标 SGR 序列会被我们的 listener 先看到（注册顺序）；parseMouseEvents
 * 只识别 \x1b[<...M 形态的鼠标事件，不会误吞普通键盘 ANSI。剩余 chunk
 * 留给 ink useInput 解析。
 *
 * 卸载时务必调用 disable() 写 DECRST 1000l/1006l，否则残留鼠标报告
 * 模式会污染用户终端（粘贴 / 选择文本都会触发 mouse 事件）。
 */

/** 滚轮事件计数（一次 chunk 可能含多个滚轮事件）。 */
export interface MouseWheelCounts {
  /** 滚轮上滚（向历史）累计。 */
  readonly wheelUp: number;
  /** 滚轮下滚（向最新）累计。 */
  readonly wheelDown: number;
}

/** 解析结果：滚动计数 + 剩余未消费的 chunk（不含鼠标序列）。 */
export interface MouseParseResult extends MouseWheelCounts {
  /** 原始 chunk 中被识别为 SGR 鼠标事件的部分（已被剥离，不再传给 ink）。 */
  readonly consumed: string;
  /** 剩余非鼠标事件部分。 */
  readonly rest: string;
}

/** SGR 鼠标 button code（DECSET 1006 + 1000h 协议）。 */
const BUTTON_WHEEL_UP = 64;
const BUTTON_WHEEL_DOWN = 65;

/** DECSET 序列（启用 / 关闭 鼠标报告）。 */
const DECSET_MOUSE_REPORT_ENABLE = "\x1b[?1000h\x1b[?1006h";
const DECSET_MOUSE_REPORT_DISABLE = "\x1b[?1000l\x1b[?1006l";

/** ink useInput 守卫：SGR 鼠标序列剥 ESC 后形态（ink use-input.js:97-99 slice(1)
 * 剥 ESC 前缀，所以 useInput 回调收到 "[<数字;数字;数字M/m"）。
 * 抽到 mouse.ts 单点维护，避免三处硬编码 regex 漂移（app.tsx 顶层 useInput
 * 守卫 + PromptInput 守卫）。 */
export function isSgrMouseSequence(input: string): boolean {
  return /^\[<\d+;\d+;\d+[Mm]$/.test(input);
}

// SGR 鼠标序列：\x1b[<button;x;y[Mm]  （button=64 wheel up / 65 wheel down）
// 1) 转义引入：\x1b[
// 2) 字面量 <
// 3) button（数字 0..255）
// 4) ; + column（数字）
// 5) ; + row（数字）
// 6) 终止符 M（按下/拖动，scroll 用 M；m 是释放，但滚轮也会以 m 终止）
// 全局 +g 防止多行匹配遗漏；非捕获分组以保留坐标数值。
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** 解析一个 stdin chunk 中的 SGR 鼠标事件（仅滚轮 button=64/65 计入 counts）。
 *  runtime 防御：非 string 输入（undefined / null / number）-> 返回全零，不 throw
 *  （app.tsx stdin.on('data') 可能传 Buffer，调用方已 toString；但守一层避免外部
 *  误调用崩溃整个 ink app）。 */
export function parseMouseEvents(chunk: string): MouseParseResult {
  if (typeof chunk !== "string" || chunk.length === 0) {
    return { wheelUp: 0, wheelDown: 0, consumed: "", rest: "" };
  }
  let wheelUp = 0;
  let wheelDown = 0;
  let consumed = "";
  let rest = "";
  let lastIndex = 0;
  // 每次 exec 推进 lastIndex；用 replace 不修改 chunk（无副作用，便于调试）。
  // 复制正则避免 lastIndex 状态泄漏。
  const re = new RegExp(SGR_MOUSE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    const start = m.index;
    const matched = m[0];
    const button = Number.parseInt(m[1] as string, 10);
    // 终止符：M = press（button=64/65 的滚轮用 M）；m = release。
    // 滚轮在 SGR 协议下终止符是 M（大写）；但部分终端（实测 iTerm2）也
    // 用 m（小写）表示 release。为避免双计数，仅在终止符=M 时累加。
    const terminator = m[4];
    // 滚轮 button 码：64 = up，65 = down。其它 button（0/1/2 鼠标键，32-35
    // 拖动）一律忽略——本项目仅启用滚轮支持，不响应点击 / 拖动 / 选择。
    if (
      terminator === "M" &&
      (button === BUTTON_WHEEL_UP || button === BUTTON_WHEEL_DOWN)
    ) {
      if (button === BUTTON_WHEEL_UP) wheelUp += 1;
      else wheelDown += 1;
      consumed += matched;
    } else {
      // 非滚轮鼠标事件（M/m 终止）：透传，让 ink 处理（实际上 ink 也
      // 不处理；这段会被吞掉，但不影响键盘链路）。
      consumed += matched;
    }
    // 把匹配前的字符归入 rest（无论是否滚轮都跳过，因为这是 SGR 鼠标协议
    // 字节，不应该被 ink 误解析为键盘序列）。
    if (start > lastIndex) rest += chunk.slice(lastIndex, start);
    lastIndex = start + matched.length;
  }
  // 尾巴非 SGR 鼠标段：保留回 rest，让 ink useInput 继续处理普通按键。
  if (lastIndex < chunk.length) rest += chunk.slice(lastIndex);
  return { wheelUp, wheelDown, consumed, rest };
}

/**
 * 启用鼠标滚轮报告（SGR 格式）。非 TTY stdout = no-op，返回空 cleanup。
 * 返回的 cleanup 函数幂等可重复调用。
 */
export function enableMouseScroll(stdout: NodeJS.WriteStream): () => void {
  if (!stdout.isTTY) return () => undefined;
  // DECSET 1000h = 报告按钮事件；1006h = SGR 编码（100/1000+）。
  // 完整 mouse 模式 1003h 不开（避免 hover 风暴，spinner 渲染会触
  // 大量无意义事件）。
  stdout.write(DECSET_MOUSE_REPORT_ENABLE);
  let called = false;
  return (): void => {
    if (called) return;
    called = true;
    if (!stdout.isTTY) return;
    stdout.write(DECSET_MOUSE_REPORT_DISABLE);
  };
}
