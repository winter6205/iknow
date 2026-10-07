/**
 * Ambient declaration for `react-reconciler`, which ships no type
 * declarations (no bundled `.d.ts`, and there is no `@types/react-reconciler`
 * installed — it reaches the tree only as an untyped transitive dependency of
 * `@opentui/react`). Without this, TS7016 makes the import `any` and errors on
 * the import site in tests/web/use-session-chat-usage.test.ts.
 *
 * Scope is deliberately minimal: only the surface that test actually calls is
 * typed, so this cannot drift into a copy of React's internals.
 *
 * The host-config object handed to `Reconciler()` is React-internal and
 * version-specific (~60 required methods). Mirroring it here would duplicate
 * React's own internals and go stale against the installed version, so it is
 * accepted as an unchecked bag — the renderer is test scaffolding, not the
 * subject under test.
 */
declare module "react-reconciler" {
  /** Opaque root handle; meaningful only when passed back to updateContainer. */
  export type ReconcilerRoot = object;

  export type ReconcilerInstance = {
    createContainer(
      containerInfo: unknown,
      tag: number,
      hydrationCallbacks: unknown,
      isStrictMode: boolean,
      concurrentUpdatesByDefaultOverride: boolean | null,
      identifierPrefix: string,
      onUncaughtError: (error: unknown) => void,
      onCaughtError: (error: unknown) => void,
      onRecoverableError: (error: unknown) => void,
      transitionCallbacks?: unknown
    ): ReconcilerRoot;
    updateContainer(
      element: unknown,
      root: ReconcilerRoot,
      parentComponent: unknown,
      callback: (() => void) | null
    ): void;
  };

  export default function Reconciler(
    hostConfig: Record<string, unknown>
  ): ReconcilerInstance;
}
