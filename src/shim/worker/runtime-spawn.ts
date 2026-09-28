// Inside the Worker: runs a WASI program the page compiled over the WASI
// host, or a component's jco output over the WASI 0.2 host, with its file and
// socket calls going to the page's orivon and its stdio to the page's
// ChildProcess streams.

import { createWasiHost, type WasiFs } from '../wasi/host.js'
import { runCommand, suspendingImports } from '../wasi/instantiate.js'
import type { StdinSource } from '../wasi/stdio.js'
import { WasiTerminated } from '../wasi/termination.js'
import type { SocketNet } from '../wasi-p2/addresses.js'
import { componentImports } from '../wasi-p2/imports.js'
import { InputStream, OutputStream } from '../wasi-p2/io.js'
import { type Instantiate, instantiateComponent } from '../wasi-p2/run.js'
import { createOrivonClient } from './orivon-client.js'
import { OutputAcks, type ParentChannel } from './parent.js'
import type { SpawnProgram, SpawnStart, StreamName } from './protocol.js'

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

/** How the Worker loads a component's jco output; a test passes one that evaluates it against its JSPI namespace. */
export type LoadComponent = (glue: string) => Promise<Instantiate>

const importComponent: LoadComponent = async (glue) => ((await import(/* @vite-ignore */ glue)) as { instantiate: Instantiate }).instantiate

export async function runSpawn (start: SpawnStart, parent: ParentChannel, wasm: typeof WebAssembly = WebAssembly, loadComponent: LoadComponent = importComponent): Promise<void> {
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
  const io = { stdin, stdout: sink('stdout'), stderr: sink('stderr') }
  let run: () => Promise<number>
  try {
    run = start.program.kind === 'core'
      ? await prepareProgram(start, start.program, orivon, io, wasm)
      : await prepareComponent(start, start.program, orivon, io, wasm, loadComponent)
  } catch (error) {
    parent.post({ type: 'failed', error: { name: 'Error', message: String((error as Error)?.message ?? error), code: 'ENOEXEC' } })
    return
  }
  parent.post({ type: 'started' })
  try {
    parent.post({ type: 'exit', code: await run(), signal: null })
  } catch (error) {
    const text = new TextEncoder().encode(`${String((error as Error)?.stack ?? error)}\n`)
    parent.post({ type: 'output', stream: 'stderr', data: text }, [text.buffer])
    parent.post({ type: 'exit', code: null, signal: signalFor(error) })
  }
}

interface ChildIo {
  readonly stdin: StdinQueue
  readonly stdout: (data: Uint8Array) => Promise<void>
  readonly stderr: (data: Uint8Array) => Promise<void>
}

async function prepareProgram (start: SpawnStart, program: Extract<SpawnProgram, { kind: 'core' }>, orivon: Record<string, unknown>, io: ChildIo, wasm: typeof WebAssembly): Promise<() => Promise<number>> {
  const host = createWasiHost({ fs: orivon.fs as WasiFs, args: start.args, env: start.env, preopens: start.preopens, ...io })
  let instance: WebAssembly.Instance
  try {
    instance = await wasm.instantiate(program.module, { wasi_snapshot_preview1: suspendingImports(host, wasm) } as WebAssembly.Imports)
  } catch (error) {
    throw new Error(`the program cannot be instantiated as a WASI command: ${String(error)}`)
  }
  return async () => await runCommand(instance, host, wasm)
}

async function prepareComponent (start: SpawnStart, program: Extract<SpawnProgram, { kind: 'component' }>, orivon: Record<string, unknown>, io: ChildIo, wasm: typeof WebAssembly, loadComponent: LoadComponent): Promise<() => Promise<number>> {
  const imports = componentImports({
    fs: orivon.fs as WasiFs,
    net: orivon.net as SocketNet,
    preopens: start.preopens,
    args: start.args,
    env: start.env,
    stdin: new InputStream(async (max) => await io.stdin.read(max)),
    stdout: new OutputStream(io.stdout),
    stderr: new OutputStream(io.stderr)
  })
  const getCoreModule = async (name: string): Promise<WebAssembly.Module> => {
    const response = await fetch(new URL(name, program.base))
    if (!response.ok) throw new Error(`the component's core module ${name} is not served (${response.status})`)
    return await wasm.compile(await response.arrayBuffer())
  }
  try {
    return await instantiateComponent(await loadComponent(program.glue), getCoreModule, imports)
  } catch (error) {
    throw new Error(`the component cannot be instantiated as a WASI 0.2 command: ${String((error as Error)?.message ?? error)}`)
  }
}
