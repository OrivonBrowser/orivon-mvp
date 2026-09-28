// Inside the Worker: runs a WASI program the page compiled, over the WASI
// host, with its file calls going to the page's orivon.fs and its stdio to
// the page's ChildProcess streams.

import { createWasiHost, type WasiFs } from '../wasi/host.js'
import { runCommand, suspendingImports } from '../wasi/instantiate.js'
import type { StdinSource } from '../wasi/stdio.js'
import { WasiTerminated } from '../wasi/termination.js'
import { createOrivonClient } from './orivon-client.js'
import { OutputAcks, type ParentChannel } from './parent.js'
import type { SpawnStart, StreamName } from './protocol.js'

/** stdin as the program reads it: chunks from the page, until it ends the stream. */
class StdinQueue implements StdinSource {
  readonly #chunks: Uint8Array[] = []
  #ended = false
  #wake: (() => void) | undefined

  push (data: Uint8Array): void { this.#chunks.push(data); this.#wake?.() }
  end (): void { this.#ended = true; this.#wake?.() }

  async read (max: number): Promise<Uint8Array> {
    while (this.#chunks.length === 0 && !this.#ended) await new Promise<void>((resolve) => { this.#wake = resolve })
    this.#wake = undefined
    const head = this.#chunks[0]
    if (head === undefined) return new Uint8Array(0)
    if (head.length <= max) { this.#chunks.shift(); return head }
    this.#chunks[0] = head.subarray(max)
    return head.subarray(0, max)
  }
}

/** How a program that did not return or call proc_exit is reported, as Node reports a crashed child. */
function signalFor (error: unknown): string {
  return error instanceof WasiTerminated && error.reason === 'revoked' ? 'SIGKILL' : 'SIGABRT'
}

export async function runSpawn (start: SpawnStart, parent: ParentChannel, wasm: typeof WebAssembly = WebAssembly): Promise<void> {
  const stdin = new StdinQueue()
  const acks = new OutputAcks()
  parent.onMessage((message) => {
    if (message.type === 'stdin') stdin.push(message.data)
    else if (message.type === 'stdin-end') stdin.end()
    else if (message.type === 'ack') acks.ack(message.stream)
  })
  // A copy crosses, never `data` itself: the host still reads `data.length` for nwritten.
  const sink = (stream: StreamName) => async (data: Uint8Array): Promise<void> => {
    const acked = acks.wait(stream)
    const copy = data.slice()
    parent.post({ type: 'output', stream, data: copy }, [copy.buffer])
    await acked
  }
  const orivon = createOrivonClient(start.orivon)
  const host = createWasiHost({
    fs: orivon.fs as WasiFs,
    args: start.args,
    env: start.env,
    preopens: start.preopens,
    stdin,
    stdout: sink('stdout'),
    stderr: sink('stderr')
  })
  let instance: WebAssembly.Instance
  try {
    instance = await wasm.instantiate(start.module, { wasi_snapshot_preview1: suspendingImports(host, wasm) } as WebAssembly.Imports)
  } catch (error) {
    parent.post({ type: 'failed', error: { name: 'Error', message: `the program cannot be instantiated as a WASI command: ${String(error)}`, code: 'ENOEXEC' } })
    return
  }
  parent.post({ type: 'started' })
  try {
    parent.post({ type: 'exit', code: await runCommand(instance, host, wasm), signal: null })
  } catch (error) {
    const text = new TextEncoder().encode(`${String((error as Error)?.stack ?? error)}\n`)
    parent.post({ type: 'output', stream: 'stderr', data: text }, [text.buffer])
    parent.post({ type: 'exit', code: null, signal: signalFor(error) })
  }
}
