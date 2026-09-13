/**
 * Archived 2026-09-13 (ADR-0092 fs isolation modes Round 1): the closed-world
 * `installRoot` read-channel retired. `--bind / /` exposes the project
 * toolchain root, so worker deps no longer thread an `installRoot` option into
 * the bash factory and `resolveInstallRoot()` is no longer consumed there.
 * The still-true worker fence shape (host root, system ro-binds, session tmp
 * as `$TMPDIR`) is certified in
 * `tests/subagent/worker-identity-root.test.ts` and
 * `tests/subagent/worker-session-layout.test.ts`.
 *
 * ── original header ──────────────────────────────────────────────────────
 * T5 (plans/closed-world-bash-fence.md) — worker registry installRoot 透传。
 *
 * 查证结论(T4 移交观察的裁决依据):worker 的 bash 是**真实执行面** ——
 * createWorkerRuntime 经 createDefaultAciRegistry 装配真实 registry(reg.inner
 * → executor),bash 工厂在 registry 构造期即实例化(registry.ts `tools =
 * toolsetNames.map(factories[n]!())`),handler 在调用时经 createFsPolicy /
 * createBwrapFence 构造围栏。缺席 installRoot 时闭世界读白名单缺 §9.2 #4
 * 合同读根(项目自身工具链 node_modules/.bin 的读通道)。
 *
 * 接线形态与 verify sandbox-run 同款:opts.installRoot 显式传入即覆盖,缺省
 * 回退 `resolveInstallRoot()` 进程级 SSOT(worker 进程没有 sessionRoots,但
 * 该解析锚 `import.meta.url`,在 worker 进程内同样成立)。
 *
 * 手法:module-mock bash.js(registry 的 named import 落到 spy;registry 本体
 * 保持真实),与 tests/harness/build-engine-install-root.test.ts 同款。
 */
