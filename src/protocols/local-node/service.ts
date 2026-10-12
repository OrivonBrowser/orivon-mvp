// A local node's work, apart from the process it runs in: the data directory,
// the component, and the readiness reports. The kind says what is its own (its
// arguments, its config files, how it is ready); entry.ts gives this the
// parent port, and a test gives it a directory and a recorder.

import { InputStream, OutputStream } from '../../shim/wasi-p2/io.js'
import { componentImports } from '../../shim/wasi-p2/imports.js'
import { GUEST_DATA_DIR } from './kind.js'
import type { Fetcher, NodeKind, Readiness } from './kind.js'
import { PinMismatch, loadComponent } from './component.js'
import type { LoaderSeams } from './component.js'
import { createConfinedFs } from './node-fs.js'
import { createNodeNet } from './node-net.js'
import type { NodeNetDeps } from './node-net.js'
import { failure } from './protocol.js'
import type { FromNode, LocalNodeConfig } from './protocol.js'

export interface NodeServiceDeps {
  readonly post: (message: FromNode) => void
  readonly fetcher?: Fetcher
  readonly net?: NodeNetDeps
  /** Every log line the node writes, as it writes it. */
  readonly onLog?: (line: string) => void
  readonly pollEveryMs?: number
  /** Test seams of the component loader. */
  readonly loader?: LoaderSeams
}

export interface RunningNode {
  /** Resolves with the component's exit code once it ends. */
  readonly finished: Promise<number>
  readonly compileMs: number
  stop: () => void
}

const LOG_TAIL = 40
const defaultFetcher: Fetcher = async (url, signal) => await fetch(url, { signal })

function lineSink (onLine: (line: string) => void): OutputStream {
  let pending = ''
  const decoder = new TextDecoder()
  return new OutputStream(async (bytes) => {
    pending += decoder.decode(bytes, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  })
}

export async function startNode (kind: NodeKind, config: LocalNodeConfig, deps: NodeServiceDeps): Promise<RunningNode> {
  const post = (message: FromNode): void => { deps.post(message.type === 'failed' ? failure(message.stage, message.message) : message) }
  try {
    await kind.prepare(config.dataDir, config.apiPort)
  } catch (error) {
    post({ type: 'failed', stage: 'start', message: `could not prepare the data directory: ${describe(error)}` })
    throw error
  }
  const tail: string[] = []
  let readiness: Readiness | undefined
  const onLine = (line: string): void => {
    tail.push(line)
    if (tail.length > LOG_TAIL) tail.shift()
    readiness?.onLog?.(line)
    deps.onLog?.(line)
  }
  let portTaken = false
  const imports = componentImports({
    fs: await createConfinedFs(config.dataDir),
    net: createNodeNet(config.apiPort, deps.net, { apiPortTaken: () => { portTaken = true } }),
    preopens: { [GUEST_DATA_DIR]: '/orivon/app' },
    args: kind.arguments(config),
    env: {},
    stdin: new InputStream(async () => new Uint8Array(0)),
    stdout: lineSink(onLine),
    stderr: lineSink(onLine)
  })
  let loaded
  try {
    loaded = await loadComponent(config.componentDir, config.componentName, config.files, imports, deps.loader)
  } catch (error) {
    post({ type: 'failed', stage: error instanceof PinMismatch ? 'artifact' : 'compile', message: describe(error) })
    throw error
  }

  deps.onLog?.(`compiled the component in ${String(Math.round(loaded.compileMs))} ms`)
  let stopped = false
  readiness = kind.watchReadiness({
    base: `http://127.0.0.1:${String(config.apiPort)}`,
    fetcher: deps.fetcher ?? defaultFetcher,
    post,
    everyMs: deps.pollEveryMs ?? 1_000
  })

  const finished = loaded.run().then(
    (code) => {
      if (!stopped) post(runEnded(portTaken, config.apiPort, `the node stopped with exit code ${String(code)}${tail.length > 0 ? `: ${tail.slice(-3).join(' | ')}` : ''}`))
      return code
    },
    (error: unknown) => {
      if (!stopped) post(runEnded(portTaken, config.apiPort, `the node trapped: ${describe(error)}`))
      return 1
    }
  )

  return {
    finished,
    compileMs: loaded.compileMs,
    stop: () => {
      stopped = true
      readiness?.stop()
    }
  }
}

/** A node that ended after its own API port was refused to it died of that, whatever it printed. */
function runEnded (portTaken: boolean, port: number, message: string): FromNode {
  return portTaken ? { type: 'failed', stage: 'port', message: `its API port ${String(port)} is taken by another program` } : { type: 'failed', stage: 'run', message }
}

function describe (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

