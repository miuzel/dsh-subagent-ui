// Ambient declarations for values that exist only inside the generated
// module-loader factory wrapper (see scripts/build.mjs):
//
//   window.__ModuleLoader__.load({ id, factory: (require) => { <modules> } })
//
// React and the jsx-runtime helpers come from the wrapper's `require` calls;
// `sessionsRt` is the shared mutable binding defined in runtime.ts. Modules
// reference these as free variables; they become one scope after linking.
// This file is used by tsc only — the build ignores *.d.ts files.

// Minimal React surface used by the modules (the real React comes from the
// module-loader `require`; this is just enough typing for tsc).
interface ReactLike {
  useState<T>(initial: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void]
  useMemo<T>(factory: () => T, deps: unknown[]): T
  useDeferredValue<T>(value: T): T
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void
  useRef<T>(initial: T): { current: T }
  Fragment: unknown
}

declare const React: ReactLike
declare const jsx: any
declare const jsxs: any

declare let sessionsRt: import('./types').SessionsRuntime | null

// Declaration merge of the host's consumer-label map: the retain contract's
// `SessionReferenceSourceMap` is extended through the package's canonical
// /client entry, so this plugin registers its own label (RETAIN_SOURCE in
// retain.ts) instead of reusing the view-side `mainView`. Type-only: the build
// ignores *.d.ts files, and the label reaches the host as a plain string.
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    subagentWorkspaceUi: unknown
  }
}
