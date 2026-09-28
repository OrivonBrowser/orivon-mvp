// The shape each preview1 function family hands host.ts. An import may
// suspend the program only if it is listed under `async`: those are the
// ones instantiate.ts wraps in WebAssembly.Suspending.

/** i32 arguments arrive as numbers, i64 as bigints; the result is an errno. */
export type WasiFunction = (...args: never[]) => number | Promise<number>

export interface ImportFamily {
  readonly sync: Readonly<Record<string, (...args: never[]) => number>>
  readonly async: Readonly<Record<string, (...args: never[]) => Promise<number>>>
}
