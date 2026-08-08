/**
 * src/tui/mouse.ts
 *
 * 鼠标捕获（标准 SGR 协议，DECSET 1000h + 1006h + 1002h）。
 *
 * 为什么需要（#236 朴素滚动 + 滚轮）：ink 渲染到 normal buffer（alternateScreen:false），
 * 每帧重渲染覆盖屏幕。终端原生 scrollback 在这种情况下全是中间帧垃圾，滚轮翻历史
 * 看不到干净内容、且与 app 滚动状态脱节（"滚上去没法滚回来"）。唯一稳定做法是
 * 让 app 捕获滚轮 → 走同一个 chatScroll（与 PgUp/PgDn 一致）。
 *
 * 为什么 1002h（#238 鼠标拖选复制）：1000h 只上报按钮按下/释放，按住左键拖动期间
 * 终端不报坐标，app 无法跟踪选区。1002h（drag 模式）在按住按钮移动时上报
 * button=32/35（button 0/2 + 32）的 "M" 移动事件 → app 据此扩展选区。滚轮仍走
 * 1000h 的 64/65（1002h 覆盖 1000h 的按钮事件，仅额外加 drag）。
 *
 * 协议：DECSET 1000h = 报告按钮事件；1006h = SGR 编码（iTerm2/Windows Terminal/xterm
 * 通用）；1002h = drag 模式。button code = 0（左键按下）/ 32（左键按住拖动）/
 * 3（任意键释放，SGR 中释放带 3）/ 64（滚轮上）/ 65（滚轮下）。序列形态：
 * \x1b[<0;x;yM（按下）/ \x1b[<32;x;yM（拖动）/ \x1b[<3;x;ym（释放）。
 *
 * 与 useInput 的关系：ink 的 useInput 同样会从 stdin 收到 SGR 序列（剥 ESC 后形态
 * "[<数字;数字;数字M/m"），由 isSgrMouseSequence 守卫丢弃，避免污染键盘键链。
 * 我们的 listener 与 ink useInput 并行：listener 先注册并消费鼠标，剩余字节透传。
 *
 * 卸载必须写 DECRST（1000l/1006l/1002l）关闭报告，否则残留模式会污染粘贴 / 选择。
 */
export interface MouseWheelCounts {
  /** 滚轮上滚（向历史）累计。一次 stdin chunk 可能含多个事件。 */
  readonly wheelUp: number;
  /** 滚轮下滚（向最新）累计。 */
  readonly wheelDown: number;
}

/** SGR 鼠标 button code（DECSET 1006 + 1000h/1002h 协议）。 */
const BUTTON_WHEEL_UP = 64;
const BUTTON_WHEEL_DOWN = 65;

/** DECSET 序列（启用 / 关闭 鼠标报告）。1002h 追加在 1000h 之后（覆盖按钮事件）。 */
const DECSET_MOUSE_REPORT_ENABLE = "\x1b[?1000h\x1b[?1006h\x1b[?1002h";
const DECSET_MOUSE_REPORT_DISABLE = "\x1b[?1000l\x1b[?1006l\x1b[?1002l";

/** ink useInput 守卫：ink 内部 use-input.js 剥 ESC 前缀，传到 useInput 回调时是
 *  "[<数字;数字;数字M/m" 形态。用单点维护避免两处 regex 漂移。 */
export function isSgrMouseSequence(input: string): boolean {
  return /^\[<\d+;\d+;\d+[Mm]$/.test(input);
}

// SGR 鼠标序列：\x1b[<button;x;y[Mm] （M=按下/拖动，m=释放）
// 全局 g 防多行遗漏；不让我们在这里二次丢弃——只识别。
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** 单个 SGR 鼠标事件（已解码）。 */
export interface SgrMouseEvent {
  /** 按钮码（raw）。0=左键按下，3=释放，32=左键拖动，64/65=滚轮。 */
  readonly button: number;
  /** 1-based 列（SGR 协议 x 从 1 起算）。 */
  readonly x: number;
  /** 1-based 行（SGR 协议 y 从 1 起算）。 */
  readonly y: number;
  /** true = 按下/拖动（"M"），false = 释放（"m"）。 */
  readonly pressed: boolean;
}

/** 解析一个 stdin chunk 中的全部 SGR 鼠标事件（含坐标）。非 string 返回空数组。 */
export function parseMouseAllEvents(
  chunk: string
): ReadonlyArray<SgrMouseEvent> {
  if (typeof chunk !== "string" || chunk.length === 0) return [];
  const out: SgrMouseEvent[] = [];
  const re = new RegExp(SGR_MOUSE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    out.push({
      button: Number.parseInt(m[1] as string, 10),
      x: Number.parseInt(m[2] as string, 10),
      y: Number.parseInt(m[3] as string, 10),
      pressed: m[4] === "M",
    });
  }
  return out;
}

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

/** 启用 SGR 鼠标报告（按钮 + 滚轮 + drag）。DECSET 1000h+1006h+1002h。
 *  非 TTY stdout = no-op（测试 fs stream），返回空 cleanup。 */
export function enableSgrMouseReport(stdout: NodeJS.WriteStream): () => void {
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

/** 同步写 DECRST 关鼠标报告序列。quit() 防御路径用（不依赖 effect cleanup）：
 *  与 enableMouseScroll 共用一个 SSOT，避免漏关 1002l（drag mode）污染终端。 */
export function disableMouseReport(stdout: NodeJS.WriteStream): void {
  if (!stdout.isTTY) return;
  stdout.write(DECSET_MOUSE_REPORT_DISABLE);
}

/**
 * 滚轮单格步长（行数）：max(1, floor(viewportRows / 2))。
 *
 * 与 PgUp/PgDn 步长保持一致（app.tsx 键盘 handler 共享同一公式），所以
 * 一次 wheel-up 等价于一次 PgUp 的视口位移。viewportRows = 0（无测得视口）
 * → 1（最小防呆，防 0 步长让滚轮完全无反应）。
 *
 * 注：旧 commit 88f4ac5 把 wheel 改成 clamp 到顶/底（wheel-up → maxScroll，
 * wheel-down → 0），用户反馈「滚上去只能看到第一页，滚下来只能看到当前
 * 页，中间完全看不到」。本函数是该 clamp 回归的恢复锚点——导出供测试锁
 * 死行为，单格 = 半屏 floor，绝不是端点跳变。
 */
export function wheelScrollStep(viewportRows: number): number {
  if (!Number.isFinite(viewportRows) || viewportRows < 0) return 1;
  return Math.max(1, Math.floor(viewportRows / 2));
}
