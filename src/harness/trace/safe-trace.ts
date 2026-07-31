/**
 * safeTrace wrapper (GH #64 T2, ADR Decision 13)。
 *
 * 中央化 "永远不抛" 契约: 包裹任一返回 Promise 的 fn,把 rejected Promise 吃掉
 * (解析为 undefined),同时不让 fn() 调用本身的同步抛被吞掉。
 *
 * 实现必须非 async (NON-async 函数,原因):
 *   - 若实现为 `async function`,函数体内任何同步抛都会被 V8 包成 rejected Promise,
 *     进入 onRejected 分支被吞掉 —— 违反 "不要吞掉 fn() 外部同步抛" 约束。
 *   - 非 async: fn() 表达式求值阶段同步抛会直接向上传播 (编程错误,不该吞);
 *     fn() 返回的 Promise 被 onRejected 接住 → undefined (IO 错误,吞掉)。
 *
 * 注: 返回类型 `Promise<T | undefined>` —— 即使 fn 不抛,fn 的结果也可能自身
 * 是 undefined (JsonlTraceService 写盘失败路径);不可省略 undefined 分支。
 */
export function safeTrace<T>(fn: () => Promise<T>): Promise<T | undefined> {
  return fn().then(
    (value) => value,
    () => undefined
  );
}
