// Node loads its `fetch`/`Response` implementation (undici, about 20 ms) the first time either global is used,
// and the first request a page of the shell makes does that a moment after the window opens. A debugger command
// that arrives while the load runs (an e2e `evaluate` that calls `fetch`) runs inside it and meets a half-loaded
// module: "fetchImpl is not a function". Loaded before any subsystem installs a hook or a window opens, nothing
// can arrive during it.

/** Loads Node's `fetch` and `Response` implementation now. */
export function loadFetchStack (): void {
  void new Response(null)
}
