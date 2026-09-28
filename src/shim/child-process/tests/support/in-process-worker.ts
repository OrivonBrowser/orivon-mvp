// A Worker stand-in that runs the real Worker runtime (../../../worker/) in
// the test's own process, so child_process is tested end to end without an
// Electron launch. Messages keep their order, and each hops a microtask, as
// they would cross a thread.

import { hasJspi, jspiWebAssembly } from '../../../wasi/tests/support/jspi.js'
import type { ParentChannel } from '../../../worker/parent.js'
import type { FromWorker, ToWorker } from '../../../worker/protocol.js'
import { type ForkScope, runFork } from '../../../worker/runtime-fork.js'
import { runSpawn } from '../../../worker/runtime-spawn.js'

/** What a forked module does, keyed by its URL; given the Worker's global scope. */
export const forkModules = new Map<string, (scope: ForkScope) => void | Promise<void>>()

export const workers: InProcessWorker[] = []

export class InProcessWorker {
  onmessage: ((event: { data: FromWorker }) => void) | null = null
  onerror: ((event: { preventDefault: () => void }) => void) | null = null
  terminated = false
  readonly #handlers: Array<(message: ToWorker) => void> = []
  readonly #scope: ForkScope

  constructor () {
    const target = new EventTarget()
    this.#scope = Object.assign(target, { close: () => { this.terminated = true } }) as unknown as ForkScope
    workers.push(this)
  }

  postMessage (message: ToWorker): void {
    queueMicrotask(() => {
      if (this.terminated) return
      if (message.type === 'spawn') void runSpawn(message, this.#parent(), jspiWebAssembly)
      else if (message.type === 'fork') void runFork(message, this.#parent(), this.#scope, async (url) => { await forkModules.get(url)?.(this.#scope) })
      else for (const handler of this.#handlers) handler(message)
    })
  }

  terminate (): void { this.terminated = true }

  #parent (): ParentChannel {
    return {
      post: (message) => { queueMicrotask(() => { if (!this.terminated || message.type === 'exit') this.onmessage?.({ data: message }) }) },
      onMessage: (handler) => { this.#handlers.push(handler) }
    }
  }
}

export function createInProcessWorker (): InProcessWorker {
  if (!hasJspi) throw new Error('this Node has no JSPI behind --experimental-wasm-jspi')
  return new InProcessWorker()
}
