// The Worker's entry point. It is not imported by anything: the unit suite
// bundles it into runtime.generated.json (tests/runtime-bundle.test.ts), and
// launch.ts starts every child Worker from that text through a blob: URL,
// which works whatever bundler an app uses and whatever its served CSP.

import './early-globals.js'
import type { ParentChannel } from './parent.js'
import type { ToWorker } from './protocol.js'
import { type ForkScope, runFork } from './runtime-fork.js'
import { runSpawn } from './runtime-spawn.js'

const scope = globalThis as unknown as ForkScope & {
  postMessage (message: unknown, transfer: Transferable[]): void
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null
}
const handlers: Array<(message: ToWorker) => void> = []
const parent: ParentChannel = {
  post: (message, transfer = []) => { scope.postMessage(message, transfer) },
  onMessage: (handler) => { handlers.push(handler) }
}

scope.onmessage = (event) => {
  const message = event.data
  if (message.type === 'spawn') void runSpawn(message, parent).finally(() => { scope.close() })
  else if (message.type === 'fork') void runFork(message, parent, scope, async (url) => await import(url))
  else for (const handler of handlers) handler(message)
}
