// A Node behaviour this shim narrows or drops is named once per call, never
// silent (A135): wasi/context.ts and child-process/fork.ts each keep their
// own dedup set, so a WASI program and a forked module warn independently.

/** One console line the first time `call` is asked for under `prefix`, never again for the same call. */
export function createWarnOnce (prefix: string): (call: string, why: string) => void {
  const warned = new Set<string>()
  return (call, why) => {
    if (warned.has(call)) return
    warned.add(call)
    console.warn(`${prefix}: ${call} is not supported (${why})`)
  }
}
