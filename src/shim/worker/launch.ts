// Starts a child Worker from the prebuilt runtime (runtime.ts, bundled into
// runtime.generated.json). A blob: URL needs no bundler support for workers
// and passes the served CSP's `worker-src 'self' blob:`.

import runtime from './runtime.generated.json'

let runtimeUrl: string | undefined

export function createChildWorker (name: string): Worker {
  runtimeUrl ??= URL.createObjectURL(new Blob([runtime.source], { type: 'text/javascript' }))
  return new Worker(runtimeUrl, { type: 'module', name })
}
